"use client";

/**
 * Photos and marked-up sheets on one RFI.
 *
 * Zarina: "add option where we can add photo or we can mark up from the plan
 * sets". Two ways in, because the file is in two different places depending
 * on what it is. A photo of the condition is on somebody's phone and has
 * never existed anywhere else, so it uploads. The sheet the question is about
 * is already in the library, often as part of a 40 MB set, so it attaches
 * rather than uploading a second copy.
 */

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { DOCUMENT_CATEGORY_LABEL } from "./documents-constants";
import {
  attachDocumentToRfi,
  detachDocumentFromRfi,
  getAttachableRfiDocuments,
  type AttachableDoc,
} from "./rfis-actions";
import { formatBytes, uploadProjectDocument } from "./upload-document";

export type RfiAttachment = {
  id: string;
  fileName: string;
  category: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Signed for an hour, minted on the server. Null if signing failed. */
  url: string | null;
};

type Props = {
  projectId: string;
  rfiId: string;
  attachments: RfiAttachment[];
  /** False when 0085 has not been applied. */
  enabled: boolean;
};

export function isImage(mime: string | null, fileName: string): boolean {
  if (mime) return mime.startsWith("image/");
  return /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(fileName);
}

export function RfiAttachments({ projectId, rfiId, attachments, enabled }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [options, setOptions] = useState<AttachableDoc[] | null>(null);
  const [query, setQuery] = useState("");
  const [, startTransition] = useTransition();

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);
      const names = Array.from(files).map((f) => f.name);
      setUploading((prev) => [...prev, ...names]);

      for (const file of Array.from(files)) {
        const up = await uploadProjectDocument({ projectId, file, category: "rfi" });
        if (!up.ok) {
          setError(`${file.name}: ${up.error}`);
        } else {
          const linked = await attachDocumentToRfi(projectId, rfiId, up.id);
          if (!linked.ok) {
            // The file DID land in the library. Saying "failed" here would
            // send somebody to upload it a second time.
            setError(`${file.name} is in the library but not attached: ${linked.error}`);
          }
        }
        setUploading((prev) => prev.filter((n) => n !== file.name));
      }

      startTransition(() => router.refresh());
    },
    [projectId, rfiId, router],
  );

  async function openPicker() {
    setPicking(true);
    setError(null);
    const res = await getAttachableRfiDocuments(projectId, rfiId);
    if (!res.ok) {
      setError(res.error);
      setOptions([]);
      return;
    }
    if (!res.enabled) {
      setError("Run migration 0085 in the Supabase SQL Editor to attach files to an RFI.");
      setOptions([]);
      return;
    }
    setOptions(res.documents);
  }

  async function attach(documentId: string) {
    setBusy(true);
    setError(null);
    const res = await attachDocumentToRfi(projectId, rfiId, documentId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPicking(false);
    setOptions(null);
    setQuery("");
    startTransition(() => router.refresh());
  }

  async function detach(documentId: string) {
    setBusy(true);
    setError(null);
    const res = await detachDocumentFromRfi(projectId, documentId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  if (!enabled) {
    return (
      <p className="text-xs text-muted-foreground">
        Run migration 0085 to attach photos and marked-up sheets to an RFI.
      </p>
    );
  }

  const filtered = (options ?? []).filter((o) =>
    query.trim()
      ? o.fileName.toLowerCase().includes(query.trim().toLowerCase())
      : true,
  );

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Photos and sheets ({attachments.length})
      </p>

      {error && (
        <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="group relative w-36 overflow-hidden rounded border bg-background"
            >
              {a.url && isImage(a.mimeType, a.fileName) ? (
                <a href={a.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.url}
                    alt={a.fileName}
                    className="h-24 w-full object-cover"
                  />
                </a>
              ) : (
                <a
                  href={a.url ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-24 w-full items-center justify-center bg-muted/40 text-[11px] text-muted-foreground"
                >
                  {DOCUMENT_CATEGORY_LABEL[
                    a.category as keyof typeof DOCUMENT_CATEGORY_LABEL
                  ] ?? a.category}
                </a>
              )}
              <div className="space-y-0.5 px-1.5 py-1">
                <p className="truncate text-[11px]" title={a.fileName}>
                  {a.fileName}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">
                    {a.sizeBytes != null ? formatBytes(a.sizeBytes) : ""}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void detach(a.id)}
                    className="text-[10px] text-muted-foreground underline hover:text-destructive"
                  >
                    remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {uploading.map((name) => (
        <p key={name} className="text-[11px] text-muted-foreground">
          Uploading {name}...
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {/* capture tells a phone to open the camera rather than the gallery.
            Desktop browsers ignore it and show the file picker, which is why
            both buttons can exist without one breaking the other. */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          Add a file
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => cameraRef.current?.click()}
        >
          Take a photo
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void openPicker()}
        >
          Attach from the plan sets
        </Button>
        <Link
          href={`/projects/${projectId}/documents`}
          className="text-[11px] text-muted-foreground underline hover:text-foreground"
        >
          Open the library
        </Link>
      </div>

      {picking && (
        <div className="space-y-2 rounded border bg-background p-2">
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the library by file name"
              className="h-8 text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setPicking(false);
                setOptions(null);
                setQuery("");
              }}
            >
              Cancel
            </Button>
          </div>
          {options === null ? (
            <p className="text-xs text-muted-foreground">Loading...</p>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing matches. Upload the sheet from the library page first.
            </p>
          ) : (
            <div className="max-h-56 overflow-y-auto">
              {filtered.slice(0, 50).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void attach(o.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 border-b px-2 py-1.5 text-left text-xs last:border-0",
                    "hover:bg-muted/40",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{o.fileName}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {DOCUMENT_CATEGORY_LABEL[
                      o.category as keyof typeof DOCUMENT_CATEGORY_LABEL
                    ] ?? o.category}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
