import { createClient } from "@/lib/supabase/server";

import { DocumentList } from "./document-list";
import { DocumentUploader } from "./document-uploader";
import {
  DOCUMENT_CATEGORY_DEFAULT_OPEN,
  DOCUMENT_CATEGORY_ORDER,
  type DocumentCategory,
} from "./documents-constants";

type Props = {
  projectId: string;
};

export async function DocumentsSection({ projectId }: Props) {
  const supabase = createClient();
  const { data: documents, error } = await supabase
    .from("project_documents")
    .select(
      "id, file_name, category, size_bytes, mime_type, text_status, uploaded_at, pages_count",
    )
    .eq("project_id", projectId)
    .order("file_name", { ascending: true });

  // Group by category, preserving the display order from constants.
  const groups = DOCUMENT_CATEGORY_ORDER
    .map((category: DocumentCategory) => ({
      category,
      documents: (documents ?? []).filter((d) => d.category === category),
      defaultOpen: DOCUMENT_CATEGORY_DEFAULT_OPEN.includes(category),
    }))
    .filter((g) => g.documents.length > 0);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Documents</h2>
          <p className="text-xs text-muted-foreground">
            Prime contracts, amendments, drawings, and more. Files are indexed
            for AI Q&amp;A after upload.
          </p>
        </div>
        {documents && documents.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {documents.length} {documents.length === 1 ? "file" : "files"}
          </p>
        )}
      </div>

      <DocumentUploader projectId={projectId} />

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load documents: {error.message}
        </div>
      ) : (
        <DocumentList projectId={projectId} groups={groups} />
      )}
    </section>
  );
}
