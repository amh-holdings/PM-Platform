"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { CoAttachment } from "@/lib/change-order-load";
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_KIND_LABELS,
  CO_ATTACHMENT_PREFIX,
  type AttachmentKind,
} from "../../change-orders-constants";
import { DOCUMENT_BUCKET, MAX_FILE_BYTES } from "../../documents-constants";
import { deleteCoAttachment, recordCoAttachment } from "../../change-orders-actions";

type Props = {
  projectId: string;
  changeOrderId: string;
  /** The cost line this backup justifies. Every attachment belongs to one. */
  costLineId: string;
  attachments: CoAttachment[];
  defaultKind?: AttachmentKind;
  /** Only the per-line uploader inside a locked buildup passes this. */
  readOnly?: boolean;
  compact?: boolean;
};

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_");
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CoAttachments({
  projectId,
  changeOrderId,
  costLineId,
  attachments,
  defaultKind = "quote",
  readOnly = false,
  compact = false,
}: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<AttachmentKind>(defaultKind);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      setError(null);
      const supabase = createClient();

      for (const file of Array.from(files)) {
        if (file.size > MAX_FILE_BYTES) {
          setError(`${file.name} is over the 50 MB limit`);
          continue;
        }
        setBusy(file.name);

        // Path is keyed by CO so a deleted CO's files are easy to sweep, and
        // by a fresh uuid so two quotes with the same filename can coexist.
        const storagePath = `${CO_ATTACHMENT_PREFIX}/${changeOrderId}/${crypto.randomUUID()}-${sanitize(file.name)}`;

        const { error: upErr } = await supabase.storage
          .from(DOCUMENT_BUCKET)
          .upload(storagePath, file, {
            cacheControl: "3600",
            contentType: file.type || undefined,
            upsert: false,
          });
        if (upErr) {
          setError(`${file.name}: ${upErr.message}`);
          setBusy(null);
          continue;
        }

        const res = await recordCoAttachment({
          projectId,
          changeOrderId,
          costLineId,
          kind,
          fileName: file.name,
          storagePath,
          mimeType: file.type || null,
          sizeBytes: file.size,
          description: null,
        });
        if (!res.ok) {
          // The object is already in the bucket; drop it so the row and the
          // file cannot disagree about what exists.
          await supabase.storage.from(DOCUMENT_BUCKET).remove([storagePath]);
          setError(`${file.name}: ${res.error}`);
        }
        setBusy(null);
      }
      router.refresh();
    },
    [changeOrderId, costLineId, kind, projectId, router],
  );

  async function onDelete(a: CoAttachment) {
    if (!confirm(`Remove ${a.fileName}? The file is deleted from storage too.`)) return;
    setBusy(a.id);
    const res = await deleteCoAttachment(a.id, changeOrderId, projectId);
    setBusy(null);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <div className={cn("space-y-2", compact ? "text-xs" : "text-sm")}>
      {attachments.length === 0 && (
        <p className="text-xs text-muted-foreground">No document attached to this line yet.</p>
      )}

      {attachments.length > 0 && (
        <ul className="divide-y rounded-md border bg-background">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-2 py-1.5">
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {ATTACHMENT_KIND_LABELS[a.kind as AttachmentKind] ?? a.kind}
              </span>
              {a.signedUrl ? (
                <a
                  href={a.signedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-primary underline-offset-2 hover:underline"
                >
                  {a.fileName}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate">{a.fileName}</span>
              )}
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {formatBytes(a.sizeBytes)}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => onDelete(a)}
                  disabled={busy === a.id}
                  className="shrink-0 text-[11px] text-muted-foreground hover:text-destructive"
                >
                  {busy === a.id ? "..." : "Remove"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files);
          }}
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2",
            dragActive && "border-primary bg-primary/5",
          )}
        >
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AttachmentKind)}
            className="h-7 rounded border border-input bg-background px-1.5 text-xs"
            aria-label="Backup type"
          >
            {ATTACHMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {ATTACHMENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy != null}
            className="h-7 rounded border bg-background px-2 text-xs hover:bg-muted disabled:opacity-50"
          >
            {busy ? `Uploading ${busy}...` : "Attach file"}
          </button>
          <span className="text-[10px] text-muted-foreground">or drop files here</span>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}

      {error && (
        <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
