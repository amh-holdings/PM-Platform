"use client";

/**
 * Mark up a sheet from the plan set, straight onto the RFI.
 *
 * Zarina: "add option where we can add photo or we can mark up from the plan
 * sets". Pick the sheet, draw on it, save. The result is a flat PNG attached
 * to the RFI, which is the thing that travels: an engineer opens an email
 * attachment, not a link into our app.
 *
 * The source sheet is untouched. Markup never writes back to the PDF, so the
 * drawing set on the Documents page is still the drawing set.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  MARKUP_COLORS,
  canvasPoint,
  drawShapes,
  isTinyDrag,
  markupFileName,
  renderScale,
  type DraftShape,
  type Shape,
  type Tool,
} from "@/lib/markup";

import {
  attachDocumentToRfi,
  getAttachableRfiDocuments,
  getDocumentForMarkup,
  type AttachableDoc,
} from "./rfis-actions";
import { uploadProjectDocument } from "./upload-document";

type Props = {
  projectId: string;
  rfiId: string;
  onClose: () => void;
  onSaved: () => void;
};

/** Copied out of node_modules before every dev run and build. */
const PDF_WORKER_SRC = "/pdf.worker.min.mjs";

const ZOOMS = [
  { value: 1, label: "Fit" },
  { value: 2, label: "200%" },
  { value: 4, label: "400%" },
];

function renderable(doc: { fileName: string; mimeType: string | null }): boolean {
  if (doc.mimeType) {
    return doc.mimeType === "application/pdf" || doc.mimeType.startsWith("image/");
  }
  return /\.(pdf|png|jpe?g|gif|webp|bmp)$/i.test(doc.fileName);
}

export function RfiMarkupDialog({ projectId, rfiId, onClose, onSaved }: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const drafting = useRef<DraftShape | null>(null);

  const [options, setOptions] = useState<AttachableDoc[] | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<{ id: string; fileName: string } | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState<string>(MARKUP_COLORS[0].value);
  const [width, setWidth] = useState(6);
  const [zoom, setZoom] = useState(1);
  const [shapes, setShapes] = useState<Shape[]>([]);

  // The loaded PDF, kept so paging does not re-download a 40 MB set.
  const pdfRef = useRef<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await getAttachableRfiDocuments(projectId, rfiId);
      if (!res.ok) {
        setError(res.error);
        setOptions([]);
        return;
      }
      if (!res.enabled) {
        setError("Run migration 0085 in the Supabase SQL Editor first.");
        setOptions([]);
        return;
      }
      setOptions(res.documents.filter(renderable));
    })();
  }, [projectId, rfiId]);

  /** Redraw the annotation layer, including the shape being dragged. */
  const repaint = useCallback(() => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawShapes(ctx, drafting.current ? [...shapes, drafting.current] : shapes);
  }, [shapes]);

  useEffect(() => {
    repaint();
  }, [repaint]);

  const renderPage = useCallback(async (pageNumber: number) => {
    const pdf = pdfRef.current;
    const base = baseRef.current;
    const overlay = overlayRef.current;
    if (!pdf || !base || !overlay) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfPage: any = await pdf.getPage(pageNumber);
    const unscaled = pdfPage.getViewport({ scale: 1 });
    const scale = renderScale(unscaled.width, unscaled.height);
    const viewport = pdfPage.getViewport({ scale });

    base.width = Math.round(viewport.width);
    base.height = Math.round(viewport.height);
    overlay.width = base.width;
    overlay.height = base.height;

    const ctx = base.getContext("2d");
    if (!ctx) return;
    // White behind the page: a PDF renders with a transparent background and
    // a flattened PNG with no background reads as black in most viewers.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, base.width, base.height);
    await pdfPage.render({ canvasContext: ctx, viewport, canvas: base }).promise;
  }, []);

  async function open(doc: AttachableDoc) {
    setLoading(true);
    setError(null);
    setShapes([]);
    drafting.current = null;

    const res = await getDocumentForMarkup(projectId, doc.id);
    if (!res.ok) {
      setError(res.error);
      setLoading(false);
      return;
    }

    try {
      const blob = await (await fetch(res.url)).blob();
      const isPdf =
        res.mimeType === "application/pdf" || /\.pdf$/i.test(res.fileName);

      if (isPdf) {
        const pdfjs = await import("pdfjs-dist");
        // Served from public/, put there by scripts/copy-pdf-worker.mjs on
        // every dev and build. Bundling it through new URL() is what Next
        // refuses: "ESM packages need to be imported".
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        const data = new Uint8Array(await blob.arrayBuffer());
        const pdf = await pdfjs.getDocument({ data }).promise;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pdfRef.current = pdf as any;
        setPageCount(pdf.numPages);
        setPage(1);
        setSource({ id: doc.id, fileName: res.fileName });
        await renderPage(1);
      } else {
        pdfRef.current = null;
        const bitmap = await createImageBitmap(blob);
        const base = baseRef.current;
        const overlay = overlayRef.current;
        if (!base || !overlay) throw new Error("Canvas not ready");
        base.width = bitmap.width;
        base.height = bitmap.height;
        overlay.width = bitmap.width;
        overlay.height = bitmap.height;
        const ctx = base.getContext("2d");
        ctx?.drawImage(bitmap, 0, 0);
        setPageCount(1);
        setPage(0);
        setSource({ id: doc.id, fileName: res.fileName });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open that file");
    }

    setLoading(false);
  }

  async function goToPage(next: number) {
    if (next < 1 || next > pageCount || !pdfRef.current) return;
    // Marks belong to the page they were drawn on. Carrying them across
    // would move a cloud from the foundation detail onto the key plan.
    if (shapes.length > 0 && !confirm("Leave this page? The marks on it are not saved yet.")) {
      return;
    }
    setShapes([]);
    drafting.current = null;
    setLoading(true);
    setPage(next);
    await renderPage(next);
    setLoading(false);
  }

  function pointFrom(e: React.PointerEvent) {
    const canvas = overlayRef.current;
    if (!canvas) return { x: 0, y: 0 };
    return canvasPoint(
      e.clientX,
      e.clientY,
      canvas.getBoundingClientRect(),
      canvas.width,
      canvas.height,
    );
  }

  function handleDown(e: React.PointerEvent) {
    if (!source) return;
    const p = pointFrom(e);

    if (tool === "text") {
      const text = prompt("Note to write on the sheet");
      if (!text) return;
      setShapes((prev) => [
        ...prev,
        { kind: "text", color, size: Math.max(18, width * 5), x: p.x, y: p.y, text },
      ]);
      return;
    }

    (e.target as Element).setPointerCapture(e.pointerId);
    drafting.current =
      tool === "pen"
        ? { kind: "pen", color, width, points: [[p.x, p.y]] }
        : { kind: tool, color, width, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    repaint();
  }

  function handleMove(e: React.PointerEvent) {
    const draft = drafting.current;
    if (!draft) return;
    const p = pointFrom(e);
    if (draft.kind === "pen") draft.points.push([p.x, p.y]);
    else {
      draft.x1 = p.x;
      draft.y1 = p.y;
    }
    repaint();
  }

  function handleUp() {
    const draft = drafting.current;
    drafting.current = null;
    if (!draft) return;

    // A click that drew nothing is a click, not an invisible shape sitting in
    // the undo stack.
    if (draft.kind === "pen") {
      if (draft.points.length === 0) return;
    } else if (isTinyDrag(draft.x0, draft.y0, draft.x1, draft.y1)) {
      repaint();
      return;
    }
    setShapes((prev) => [...prev, draft]);
  }

  async function save() {
    const base = baseRef.current;
    if (!base || !source) return;
    if (shapes.length === 0) {
      setError("Nothing is marked on this sheet yet.");
      return;
    }

    setSaving(true);
    setError(null);

    // Flatten: the sheet, then the marks, onto one canvas at full size.
    const flat = document.createElement("canvas");
    flat.width = base.width;
    flat.height = base.height;
    const ctx = flat.getContext("2d");
    if (!ctx) {
      setError("Could not flatten the markup");
      setSaving(false);
      return;
    }
    ctx.drawImage(base, 0, 0);
    drawShapes(ctx, shapes);

    const blob = await new Promise<Blob | null>((resolve) =>
      flat.toBlob(resolve, "image/png"),
    );
    if (!blob) {
      setError("Could not flatten the markup");
      setSaving(false);
      return;
    }

    const name = markupFileName(source.fileName, page);
    const file = new File([blob], name, { type: "image/png" });

    const up = await uploadProjectDocument({ projectId, file, category: "rfi" });
    if (!up.ok) {
      setError(up.error);
      setSaving(false);
      return;
    }
    const linked = await attachDocumentToRfi(projectId, rfiId, up.id);
    setSaving(false);
    if (!linked.ok) {
      setError(`${name} is in the library but not attached: ${linked.error}`);
      return;
    }
    onSaved();
    onClose();
  }

  const filtered = (options ?? []).filter((o) =>
    query.trim() ? o.fileName.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Mark up a sheet</h3>
            <p className="truncate text-xs text-muted-foreground">
              {source
                ? `${source.fileName}${pageCount > 1 ? ` - page ${page} of ${pageCount}` : ""}`
                : "Pick the drawing or photo the question is about"}
            </p>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        {error && (
          <p className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {!source ? (
          <div className="flex-1 space-y-2 overflow-y-auto p-4">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the library by file name"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            />
            {options === null ? (
              <p className="text-sm text-muted-foreground">Loading the library...</p>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No PDFs or images in this project&rsquo;s library yet. Upload the plan
                set on the Documents page first.
              </p>
            ) : (
              filtered.slice(0, 200).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => void open(o)}
                  className="flex w-full items-center justify-between gap-2 rounded border px-3 py-2 text-left text-sm hover:bg-muted/40"
                >
                  <span className="min-w-0 flex-1 truncate">{o.fileName}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {o.category}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
              {(["arrow", "rect", "pen", "text"] as Tool[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTool(t)}
                  className={cn(
                    "rounded border px-2 py-1 capitalize",
                    tool === t ? "border-foreground bg-foreground text-background" : "hover:bg-muted",
                  )}
                >
                  {t === "rect" ? "Box" : t}
                </button>
              ))}

              <span className="mx-1 h-4 w-px bg-border" />

              {MARKUP_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  title={c.label}
                  onClick={() => setColor(c.value)}
                  style={{ backgroundColor: c.value }}
                  className={cn(
                    "h-5 w-5 rounded-full border-2",
                    color === c.value ? "border-foreground" : "border-transparent",
                  )}
                />
              ))}

              <span className="mx-1 h-4 w-px bg-border" />

              <label className="flex items-center gap-1">
                Thickness
                <input
                  type="range"
                  min={2}
                  max={16}
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value))}
                  className="w-20"
                />
              </label>

              <select
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="rounded border border-input bg-background px-2 py-1"
              >
                {ZOOMS.map((z) => (
                  <option key={z.value} value={z.value}>
                    {z.label}
                  </option>
                ))}
              </select>

              <span className="mx-1 h-4 w-px bg-border" />

              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={shapes.length === 0}
                onClick={() => setShapes((prev) => prev.slice(0, -1))}
              >
                Undo
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={shapes.length === 0}
                onClick={() => setShapes([])}
              >
                Clear
              </Button>

              {pageCount > 1 && (
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={page <= 1 || loading}
                    onClick={() => void goToPage(page - 1)}
                  >
                    Prev
                  </Button>
                  <span className="tabular-nums">
                    {page} / {pageCount}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={page >= pageCount || loading}
                    onClick={() => void goToPage(page + 1)}
                  >
                    Next
                  </Button>
                </span>
              )}
            </div>

            <div className="flex-1 overflow-auto bg-muted/30 p-3">
              <div
                className="relative mx-auto"
                style={{ width: `${zoom * 100}%`, maxWidth: zoom === 1 ? "100%" : "none" }}
              >
                <canvas ref={baseRef} className="block w-full" />
                <canvas
                  ref={overlayRef}
                  className="absolute left-0 top-0 block w-full touch-none"
                  style={{ cursor: tool === "text" ? "text" : "crosshair" }}
                  onPointerDown={handleDown}
                  onPointerMove={handleMove}
                  onPointerUp={handleUp}
                  onPointerCancel={handleUp}
                />
              </div>
              {loading && (
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  Rendering the sheet...
                </p>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t px-4 py-2">
              <p className="text-xs text-muted-foreground">
                {shapes.length} mark{shapes.length === 1 ? "" : "s"}. The sheet itself
                is not changed - this saves a flat image onto the RFI.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSource(null);
                    setShapes([]);
                    pdfRef.current = null;
                  }}
                >
                  Pick another sheet
                </Button>
                <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
                  {saving ? "Saving..." : "Save to the RFI"}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
