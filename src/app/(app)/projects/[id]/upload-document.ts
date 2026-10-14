// One browser-side upload path, for callers that take a file.
//
// "Sanitize the name, check the size, put it in the bucket, insert the row,
// delete the blob if the insert fails" was already written out longhand in the
// Documents uploader, the procurement form and the sub contract dialog. The
// schedule grid wanted it a fourth time, for a file dropped straight onto a
// task row, which was the point to stop copying it.
//
// The Documents uploader and the schedule grid use this. The other two still
// carry their own copy and should move onto it, but not in the same change
// that adds the drop target - a procurement upload breaking is a different
// day's problem.
//
// The blob goes up from the browser straight to Storage - a 40 MB drawing set
// has no business passing through a server action - and only the metadata
// insert is a server call, where RLS and the uploader's identity live.
//
// Every caller gets the document id back, so whatever wanted the file can link
// it: a schedule task, a purchase order, a change order. The row lands in
// project_documents either way, which is what puts it on the Documents page.

import { createClient } from "@/lib/supabase/client";

import { recordDocument } from "./documents-actions";
import {
  ACCEPTED_MIME_PREFIXES,
  DOCUMENT_BUCKET,
  MAX_FILE_BYTES,
  type DocumentCategory,
} from "./documents-constants";

export type UploadOutcome = { ok: true; id: string } | { ok: false; error: string };

/** Some browsers omit the mime type for unusual extensions. Allow those. */
export function isAcceptedMime(mime: string | null | undefined): boolean {
  if (!mime) return true;
  return ACCEPTED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function uploadProjectDocument({
  projectId,
  file,
  category,
  description,
}: {
  projectId: string;
  file: File;
  category: DocumentCategory;
  description?: string | null;
}): Promise<UploadOutcome> {
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: "File exceeds the 50 MB limit" };
  }
  if (!isAcceptedMime(file.type)) {
    return { ok: false, error: `Unsupported file type: ${file.type || "unknown"}` };
  }

  const supabase = createClient();
  const documentId = crypto.randomUUID();
  const storagePath = `${projectId}/${documentId}/${sanitizeFileName(file.name)}`;

  const { error: uploadError } = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(storagePath, file, {
      cacheControl: "3600",
      contentType: file.type || undefined,
      upsert: false,
    });

  if (uploadError) return { ok: false, error: uploadError.message };

  // recordDocument removes the blob itself when the insert is refused, so a
  // rejected upload leaves nothing behind in the bucket.
  const result = await recordDocument({
    projectId,
    storagePath,
    fileName: file.name,
    mimeType: file.type || null,
    sizeBytes: file.size,
    category,
    description: description ?? null,
  });

  return result.ok ? { ok: true, id: result.id } : { ok: false, error: result.error };
}
