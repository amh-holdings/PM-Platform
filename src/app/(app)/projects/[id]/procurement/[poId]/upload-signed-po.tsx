"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { recordDocument } from "../../documents-actions";
import {
  ACCEPTED_MIME_PREFIXES,
  DOCUMENT_BUCKET,
  MAX_FILE_BYTES,
} from "../../documents-constants";

import {
  linkProcurementDocument,
  setProcurementSignedStatus,
} from "../../procurement-actions";

type Props = {
  poId: string;
  projectId: string;
  hasExistingDoc: boolean;
  isSigned: boolean;
};

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_");
}
function isAcceptedMime(mime: string | null | undefined): boolean {
  if (!mime) return true;
  return ACCEPTED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

// One-click "Upload signed PO" flow: pick the PDF, the component uploads
// to Storage, records a project_document, links it to this PO, and (by
// default) also marks the PO as signed. Then the existing
// ExtractPoMilestones panel below picks up the new linked document and
// the PM can click "Extract from PO" to populate milestones.
export function UploadSignedPo({
  poId,
  projectId,
  hasExistingDoc,
  isSigned,
}: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [markSigned, setMarkSigned] = useState(!isSigned);
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
      setError("File exceeds 50 MB limit");
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
      });
      if (!rec.ok) {
        setError(rec.error);
        setStatus(null);
        return;
      }
      setStatus("Linking to PO...");
      const linkRes = await linkProcurementDocument(poId, projectId, rec.id);
      if (!linkRes.ok) {
        setError(linkRes.error);
        setStatus(null);
        return;
      }
      if (markSigned && !isSigned) {
        setStatus("Marking PO as signed...");
        const signRes = await setProcurementSignedStatus(poId, projectId, true);
        if (!signRes.ok) {
          setError(signRes.error);
          setStatus(null);
          return;
        }
      }
      setStatus("Done. Text extraction running in background - the Extract from PO button below will pick up the new document.");
      setPendingFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-emerald-700">
            Upload signed PO
          </h3>
          <p className="text-xs text-muted-foreground">
            Pick the signed PDF, click upload. We attach it to this PO,{" "}
            {markSigned && !isSigned ? "mark the PO as signed, " : ""}and the
            Extract from PO button below will read it to pull out the payment
            schedule.
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.doc,.png,.jpg,.jpeg"
          onChange={handlePick}
          className="block w-full text-xs file:mr-3 file:rounded-md file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-muted"
        />
        {pendingFile && (
          <div className="text-[10px] text-muted-foreground">
            Picked: {pendingFile.name} ({Math.round(pendingFile.size / 1024)} KB)
          </div>
        )}

        {!isSigned && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={markSigned}
              onChange={(e) => setMarkSigned(e.target.checked)}
              className="h-3.5 w-3.5 accent-emerald-700"
            />
            Mark this PO as signed after upload
          </label>
        )}

        {hasExistingDoc && (
          <p className="text-[10px] text-amber-700">
            This PO already has a linked document. Uploading replaces the link
            (old document stays in /documents but isn&apos;t the active reference).
          </p>
        )}

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

        <Button
          onClick={handleUpload}
          disabled={busy || !pendingFile}
          className={cn("bg-emerald-700 hover:bg-emerald-700/90")}
        >
          {busy ? "Working..." : "Upload signed PO"}
        </Button>
      </div>
    </section>
  );
}
