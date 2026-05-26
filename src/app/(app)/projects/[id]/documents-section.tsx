import { createClient } from "@/lib/supabase/server";

import { DocumentList } from "./document-list";
import { DocumentUploader } from "./document-uploader";

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
    .order("uploaded_at", { ascending: false });

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
        <DocumentList projectId={projectId} documents={documents ?? []} />
      )}
    </section>
  );
}
