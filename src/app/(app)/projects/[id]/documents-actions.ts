"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  DOCUMENT_BUCKET,
  type DocumentCategory,
} from "./documents-constants";

export type RecordDocumentInput = {
  projectId: string;
  storagePath: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  category: DocumentCategory;
  description?: string | null;
};

export type RecordDocumentResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function recordDocument(
  input: RecordDocumentInput,
): Promise<RecordDocumentResult> {
  const supabase = createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return { ok: false, error: "Not authenticated" };
  }

  const { data, error } = await supabase
    .from("project_documents")
    .insert({
      project_id: input.projectId,
      uploaded_by_id: user.id,
      file_name: input.fileName,
      storage_path: input.storagePath,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      category: input.category,
      description: input.description ?? null,
      text_status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    // Best-effort cleanup of the uploaded blob so we don't leak orphan files
    // when the metadata insert fails (RLS rejection, FK violation, etc).
    await supabase.storage.from(DOCUMENT_BUCKET).remove([input.storagePath]);
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: data.id };
}

export type DeleteDocumentResult = { ok: true } | { ok: false; error: string };

export async function deleteDocument(
  documentId: string,
  projectId: string,
): Promise<DeleteDocumentResult> {
  const supabase = createClient();

  const { data: doc, error: fetchError } = await supabase
    .from("project_documents")
    .select("storage_path")
    .eq("id", documentId)
    .maybeSingle();

  if (fetchError) return { ok: false, error: fetchError.message };
  if (!doc) return { ok: false, error: "Document not found" };

  const { error: rowError } = await supabase
    .from("project_documents")
    .delete()
    .eq("id", documentId);
  if (rowError) return { ok: false, error: rowError.message };

  const { error: storageError } = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .remove([doc.storage_path]);
  if (storageError) {
    // Row is gone but blob remains. Surface so the user can retry cleanup,
    // but the document no longer appears in the app.
    return { ok: false, error: `Row deleted, blob orphaned: ${storageError.message}` };
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
