"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  DOCUMENT_BUCKET,
  isDocumentCategory,
  type DocumentCategory,
} from "./documents-constants";

/**
 * Postgres rejects an enum value the database does not have yet, which is what
 * happens when the app ships ahead of migration 0083. Raw, that reads
 * `invalid input value for enum document_category: "coi"`, which tells the
 * person nothing they can act on.
 */
function friendlyCategoryError(message: string): string {
  if (/invalid input value for enum document_category/i.test(message)) {
    return "That document type is not in the database yet. Run migration 0083 in the Supabase SQL Editor.";
  }
  return message;
}

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
    return { ok: false, error: friendlyCategoryError(error.message) };
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

export type MoveDocumentResult =
  | { ok: true; moved: number; category: DocumentCategory }
  | { ok: false; error: string };

/**
 * Change the category of one or more documents.
 *
 * The category is chosen from a dropdown before the file is in the app, which
 * is the moment the person knows least about it. Three Sussex civil drawing
 * sets went in as Prime Contract, and the only way back was to delete the file
 * and upload it again - losing the upload date and, on a 32 MB plan set,
 * several minutes.
 *
 * The files do not move. Category is a label on the row; each blob keeps its
 * storage path, so nothing is re-uploaded and the extracted text survives.
 *
 * One statement for the whole batch rather than a request per row: moving
 * twelve drawings out of Prime Contract should not be twelve round trips, and
 * a half-applied batch is worse than a failed one.
 */
export async function moveDocuments(
  documentIds: readonly string[],
  projectId: string,
  category: string,
): Promise<MoveDocumentResult> {
  const supabase = createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return { ok: false, error: "Not authenticated" };
  }

  if (!isDocumentCategory(category)) {
    return { ok: false, error: `"${category}" is not a document type` };
  }

  const ids = Array.from(new Set(documentIds.filter(Boolean)));
  if (ids.length === 0) {
    return { ok: false, error: "Nothing selected" };
  }

  // Scoped to the project as well as the ids. The ids alone would move a
  // document belonging to another project if one were ever passed in.
  const { data, error } = await supabase
    .from("project_documents")
    .update({ category })
    .in("id", ids)
    .eq("project_id", projectId)
    .select("id");

  if (error) return { ok: false, error: friendlyCategoryError(error.message) };

  const moved = data?.length ?? 0;
  if (moved === 0) {
    return { ok: false, error: "Nothing moved - not found on this project" };
  }
  // A short count means some ids were not this project's. Say so rather than
  // reporting a clean success over a partial one.
  if (moved < ids.length) {
    return {
      ok: false,
      error: `Moved ${moved} of ${ids.length}. The rest were not found on this project.`,
    };
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, moved, category };
}
