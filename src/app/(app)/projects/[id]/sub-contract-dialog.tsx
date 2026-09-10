"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { recordDocument } from "./documents-actions";
import {
  ACCEPTED_MIME_PREFIXES,
  DOCUMENT_BUCKET,
  MAX_FILE_BYTES,
} from "./documents-constants";
import {
  linkSubcontractDocument,
  unlinkSubcontractDocument,
} from "./subs-actions";

export type SubContractDoc = {
  id: string;
  file_name: string;
  size_bytes: number | null;
  uploaded_at: string | null;
  signedUrl: string | null;
};

type Props = {
  projectId: string;
  subId: string;
  companyName: string;
  doc: SubContractDoc | null;
  trigger: React.ReactNode;
};

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_");
}

function isAcceptedMime(mime: string | null | undefined): boolean {
  if (!mime) return true;
  return ACCEPTED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

// Upload the executed subcontract for one sub. The file goes to the same
// bucket and the same project_documents table as everything else - it shows up
// in the Documents library under "Subcontract" - and the sub row just points
// at it. Replacing swaps the pointer and leaves the old file in the library,
// so a superseded contract is never silently destroyed.
export function SubContractDialog({
  projectId,
  subId,
  companyName,
  doc,
  trigger,
}: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const f = e.target.files?.[0] ?? null;
    if (!f) {
      setPendingFile(null);
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setError("File exceeds the 50 MB limit");
      setPendingFile(null);
      return;
    }
    if (!isAcceptedMime(f.type)) {
      setError(`Unsupported file type: ${f.type || "unknown"}`);
      setPendingFile(null);
      return;
    }
    setPendingFile(f);
  }

  function handleUpload() {
    if (!pendingFile) {
      setError("Pick a file first");
      return;
    }
    setError(null);
    startBusy(async () => {
      const supabase = createClient();
      const documentId = crypto.randomUUID();
      const storagePath = `${projectId}/${documentId}/${sanitizeFileName(pendingFile.name)}`;

      setStatus("Uploading file...");
      const { error: upErr } = await supabase.storage
        .from(DOCUMENT_BUCKET)
        .upload(storagePath, pendingFile, {
          cacheControl: "3600",
          contentType: pendingFile.type || undefined,
          upsert: false,
        });
      if (upErr) {
        setError(upErr.message);
        setStatus(null);
        return;
      }

      setStatus("Recording document...");
      const rec = await recordDocument({
        projectId,
        storagePath,
        fileName: pendingFile.name,
        mimeType: pendingFile.type || null,
        sizeBytes: pendingFile.size,
        category: "subcontract",
        description: `Subcontract - ${companyName}`,
      });
      if (!rec.ok) {
        setError(rec.error);
        setStatus(null);
        return;
      }

      setStatus("Attaching to subcontractor...");
      const link = await linkSubcontractDocument(subId, projectId, rec.id);
      if (!link.ok) {
        setError(link.error);
        setStatus(null);
        return;
      }

      setStatus(null);
      setPendingFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setOpen(false);
      router.refresh();
    });
  }

  function handleUnlink() {
    if (!confirm(`Detach this subcontract from ${companyName}? The file stays in the project Documents library.`)) {
      return;
    }
    setError(null);
    startBusy(async () => {
      const res = await unlinkSubcontractDocument(subId, projectId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-block">{trigger}</span>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Subcontract</h3>
                <p className="text-xs text-muted-foreground">{companyName}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Close
              </button>
            </div>

            {doc && (
              <div className="mt-4 rounded-md border bg-muted/30 p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  On file
                </div>
                <div className="mt-1 text-sm font-medium break-all">
                  {doc.signedUrl ? (
                    <a
                      href={doc.signedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      {doc.file_name}
                    </a>
                  ) : (
                    doc.file_name
                  )}
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {formatBytes(doc.size_bytes)}
                  {doc.uploaded_at ? ` · uploaded ${formatDate(doc.uploaded_at)}` : ""}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-7 px-2 text-xs text-destructive hover:text-destructive"
                  onClick={handleUnlink}
                  disabled={busy}
                >
                  Detach
                </Button>
              </div>
            )}

            <div className="mt-4 space-y-2">
              <div className="text-xs font-medium">
                {doc ? "Replace with a new file" : "Upload the executed subcontract"}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.doc,.png,.jpg,.jpeg"
                onChange={handlePick}
                disabled={busy}
                className="block w-full text-xs file:mr-3 file:rounded-md file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-muted"
              />
              {pendingFile && (
                <p className="text-[10px] text-muted-foreground">
                  Picked: {pendingFile.name} ({Math.round(pendingFile.size / 1024)} KB)
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">
                Also filed in the project Documents library under Subcontract.
                {doc ? " The current file stays there after a replace." : ""}
              </p>

              {error && (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                  {error}
                </p>
              )}
              {status && !error && (
                <p className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs text-emerald-700">
                  {status}
                </p>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2 border-t pt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button onClick={handleUpload} disabled={busy || !pendingFile}>
                {busy ? "Working..." : doc ? "Replace subcontract" : "Upload subcontract"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
