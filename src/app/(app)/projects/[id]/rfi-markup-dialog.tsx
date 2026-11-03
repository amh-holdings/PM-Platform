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
  countDocuments,
  groupDocuments,
  docDateLabel,
} from "@/lib/document-picker";
import {
  MARKUP_COLORS,
  MAX_RENDER_PX,
  canvasPoint,
  cropScale,
  cropToSource,
  drawShapes,
  isTinyDrag,
  isUsableCrop,
  markupFileName,
  normalizeRect,
  renderScale,
  transformShapes,
  type DraftShape,
  type Rect,
  type Shape,
  type Tool,
} from "@/lib/markup";

import {
  getAttachableRfiDocuments,
  getDocumentForMarkup,
  type AttachableDoc,
} from "./rfis-actions";
import { uploadProjectDocument } from "./upload-document";

type Props = {
  projectId: string;
  /** Null while logging a new RFI, which has no id yet. */
  rfiId: string | null;
  /**
   * What to do with the flattened PNG once it is in the library.
   *
   * On a saved RFI that is "attach it". On the form that logs a new one it is
   * "hold the id until the RFI exists", because there is nothing to attach to
   * yet. The dialog does not need to know which.
   */
  onAttach: (documentId: string, fileName: string) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
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

export function RfiMarkupDialog({ projectId, rfiId, onAttach, onClose, onSaved }: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const drafting = useRef<DraftShape | null>(null);
  const cropStart = useRef<{ x: number; y: number } | null>(null);

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
  /** The crop being dragged, in canvas pixels. Not a mark - it never saves. */
  const [cropDraft, setCropDraft] = useState<Rect | null>(null);
  const [cropped, setCropped] = useState(false);

  // The loaded PDF, kept so paging does not re-download a 40 MB set.
  const pdfRef = useRef<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null);
  // The source image, for the same reason, when the file is not a PDF.
  const bitmapRef = useRef<ImageBitmap | null>(null);
  // The region being shown, in SOURCE units - PDF points, or pixels of the
  // original image. Null is the whole sheet.
  const cropRef = useRef<Rect | null>(null);
  // Base pixels per source unit, so a click on the canvas can be put back
  // into source units when cropping a crop.
  const scaleRef = useRef(1);
  // The render in flight. pdf.js refuses two renders onto one canvas, which
  // is exactly what clicking Next twice used to do:
  // "Cannot use the same canvas during multiple render() operations."
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderTaskRef = useRef<any>(null);

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

    if (cropDraft) {
      // Everything outside the box goes dim, so what will survive the crop
      // is obvious before committing to it.
      ctx.save();
      ctx.fillStyle = "rgba(15, 23, 42, 0.45)";
      ctx.fillRect(0, 0, canvas.width, cropDraft.y);
      ctx.fillRect(0, cropDraft.y + cropDraft.h, canvas.width, canvas.height);
      ctx.fillRect(0, cropDraft.y, cropDraft.x, cropDraft.h);
      ctx.fillRect(
        cropDraft.x + cropDraft.w,
        cropDraft.y,
        canvas.width - cropDraft.x - cropDraft.w,
        cropDraft.h,
      );
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(2, canvas.width / 400);
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(cropDraft.x, cropDraft.y, cropDraft.w, cropDraft.h);
      ctx.restore();
    }
  }, [shapes, cropDraft]);

  useEffect(() => {
    repaint();
  }, [repaint]);

  /**
   * Draw the sheet, or a region of it, onto the base canvas.
   *
   * A PDF region is re-rendered from the vector at a higher scale rather than
   * enlarged from the pixels already on screen, so cropping into a detail
   * gains real resolution instead of losing it.
   */
  const renderSheet = useCallback(
    async (pageNumber: number, crop: Rect | null) => {
      const base = baseRef.current;
      const overlay = overlayRef.current;
      if (!base || !overlay) return 1;

      // Stop whatever is still drawing onto this canvas before starting again.
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
          await renderTaskRef.current.promise;
        } catch {
          // A cancelled render rejects. That is the point of cancelling it.
        }
        renderTaskRef.current = null;
      }

      const ctx = base.getContext("2d");
      if (!ctx) return 1;

      const pdf = pdfRef.current;
      if (pdf) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdfPage: any = await pdf.getPage(pageNumber);
        const unscaled = pdfPage.getViewport({ scale: 1 });
        const region = crop ?? { x: 0, y: 0, w: unscaled.width, h: unscaled.height };
        const scale = crop
          ? cropScale(region.w, region.h)
          : renderScale(unscaled.width, unscaled.height);

        const viewport = pdfPage.getViewport({
          scale,
          offsetX: -region.x * scale,
          offsetY: -region.y * scale,
        });

        base.width = Math.max(1, Math.round(region.w * scale));
        base.height = Math.max(1, Math.round(region.h * scale));
        overlay.width = base.width;
        overlay.height = base.height;

        // White behind the page: a PDF renders with a transparent background
        // and a flattened PNG with no background reads as black in most
        // viewers.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, base.width, base.height);

        const task = pdfPage.render({ canvasContext: ctx, viewport, canvas: base });
        renderTaskRef.current = task;
        try {
          await task.promise;
        } catch (e) {
          const name = (e as { name?: string })?.name;
          if (name !== "RenderingCancelledException") throw e;
        } finally {
          if (renderTaskRef.current === task) renderTaskRef.current = null;
        }
        scaleRef.current = scale;
        return scale;
      }

      const bitmap = bitmapRef.current;
      if (!bitmap) return 1;
      const region = crop ?? { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
      // A photo has no more detail to give, so a crop is capped at 3x rather
      // than blown up to the render budget.
      const scale = crop ? cropScale(region.w, region.h, MAX_RENDER_PX, 3) : 1;

      base.width = Math.max(1, Math.round(region.w * scale));
      base.height = Math.max(1, Math.round(region.h * scale));
      overlay.width = base.width;
      overlay.height = base.height;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, base.width, base.height);
      ctx.drawImage(
        bitmap,
        region.x,
        region.y,
        region.w,
        region.h,
        0,
        0,
        base.width,
        base.height,
      );
      scaleRef.current = scale;
      return scale;
    },
    [],
  );

  /** Crop to the rectangle just dragged, carrying the marks with it. */
  async function applyCrop(rect: Rect) {
    const previousScale = scaleRef.current;
    const origin = cropRef.current ?? { x: 0, y: 0 };
    cropRef.current = cropToSource(rect, previousScale, origin);

    setLoading(true);
    const scale = await renderSheet(page || 1, cropRef.current);
    setLoading(false);

    // Marks were drawn in the old frame. Move them into the new one, or they
    // land somewhere else entirely on the cropped sheet.
    setShapes((prev) => transformShapes(prev, -rect.x, -rect.y, scale / previousScale));
    setCropped(true);
  }

  async function clearCrop() {
    const previousScale = scaleRef.current;
    const origin = cropRef.current;
    cropRef.current = null;

    setLoading(true);
    const scale = await renderSheet(page || 1, null);
    setLoading(false);

    if (origin) {
      setShapes((prev) =>
        transformShapes(prev, origin.x * previousScale, origin.y * previousScale, scale / previousScale),
      );
    }
    setCropped(false);
  }

  async function open(doc: AttachableDoc) {
    setLoading(true);
    setError(null);
    setShapes([]);
    drafting.current = null;
    setCropDraft(null);
    setCropped(false);
    cropRef.current = null;

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
        await renderSheet(1, null);
      } else {
        pdfRef.current = null;
        // Kept so a crop can be re-cut from the original pixels rather than
        // from whatever is currently on the canvas.
        bitmapRef.current = await createImageBitmap(blob);
        setPageCount(1);
        setPage(0);
        setSource({ id: doc.id, fileName: res.fileName });
        await renderSheet(1, null);
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
    setCropDraft(null);
    // The crop was a region of the page being left. Carrying it over would
    // show a corner of the next sheet with no way to tell that is what it is.
    cropRef.current = null;
    setCropped(false);
    setLoading(true);
    setPage(next);
    await renderSheet(next, null);
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

    if (tool === "crop") {
      (e.target as Element).setPointerCapture(e.pointerId);
      cropStart.current = p;
      setCropDraft({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }

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
    if (tool === "crop") {
      const start = cropStart.current;
      if (!start) return;
      const p = pointFrom(e);
      setCropDraft(normalizeRect(start.x, start.y, p.x, p.y));
      return;
    }

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
    if (tool === "crop") {
      const rect = cropDraft;
      cropStart.current = null;
      setCropDraft(null);
      // A stray click is not a crop. Anything smaller than a postage stamp
      // was a misclick, and cropping to it would lose the sheet.
      if (rect && isUsableCrop(rect)) {
        void applyCrop(rect);
        setTool("arrow");
      }
      return;
    }

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
    // A cropped detail with no marks is still worth sending: "this corner of
    // C04" is an answer to "which part of the sheet".
    if (shapes.length === 0 && !cropped) {
      setError("Mark the sheet or crop to the part you mean first.");
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

    const name = markupFileName(source.fileName, page, cropped);
    const file = new File([blob], name, { type: "image/png" });

    const up = await uploadProjectDocument({ projectId, file, category: "rfi" });
    if (!up.ok) {
      setError(up.error);
      setSaving(false);
      return;
    }
    const linked = await onAttach(up.id, name);
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
  const groups = groupDocuments(filtered);
  const total = countDocuments(groups);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Mark up a sheet</h3>
            <p className="truncate text-xs text-muted-foreground">
              {source
                ? `${source.fileName}${pageCount > 1 ? ` - page ${page} of ${pageCount}` : ""}${cropped ? " - detail" : ""}`
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
          <>
            {/* Outside the scroll area, so it stays put while you page
                through a 29-sheet library. */}
            <div className="border-b p-3">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // The dialog renders inside the form that logs the RFI.
                  // Enter here would submit it half-filled.
                  if (e.key === "Enter") e.preventDefault();
                }}
                placeholder="Search the library by file name"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-4 pt-2">
            {options === null ? (
              <p className="text-sm text-muted-foreground">Loading the library...</p>
            ) : total === 0 ? (
              <p className="text-sm text-muted-foreground">
                No PDFs or images in this project&rsquo;s library yet. Upload the plan
                set on the Documents page first.
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.key} className="space-y-1">
                  <p className="sticky top-0 z-10 bg-card py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label} ({group.docs.length})
                  </p>
                  {group.docs.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => void open(o)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded border px-3 py-2 text-left text-sm hover:bg-muted/40",
                        o.olderCopy && "opacity-60",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate" title={o.fileName}>
                        {o.fileName}
                      </span>
                      {o.olderCopy && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          older copy
                        </span>
                      )}
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {docDateLabel(o)}
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
              {(["arrow", "rect", "pen", "text", "crop"] as Tool[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTool(t)}
                  className={cn(
                    "rounded border px-2 py-1 capitalize",
                    tool === t ? "border-foreground bg-foreground text-background" : "hover:bg-muted",
                  )}
                >
                  {t === "rect" ? "Box" : t === "crop" ? "Crop" : t}
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

              {cropped && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={loading}
                  onClick={() => void clearCrop()}
                >
                  Whole sheet
                </Button>
              )}

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
                  aria-label={
                    tool === "crop"
                      ? "Drag a box around the part of the sheet to keep"
                      : "Draw on the sheet"
                  }
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
                {tool === "crop"
                  ? "Drag a box around the part of the sheet to keep."
                  : `${shapes.length} mark${shapes.length === 1 ? "" : "s"}${cropped ? ", cropped" : ""}. The sheet itself is not changed - this saves a flat image onto the RFI.`}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSource(null);
                    setShapes([]);
                    setCropped(false);
                    setCropDraft(null);
                    cropRef.current = null;
                    pdfRef.current = null;
                    bitmapRef.current = null;
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
