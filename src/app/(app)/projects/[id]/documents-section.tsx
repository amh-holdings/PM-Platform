import { createClient } from "@/lib/supabase/server";

import { DocumentUploader } from "./document-uploader";

type Props = {
  projectId: string;
};

export async function DocumentsSection({ projectId }: Props) {
  const supabase = createClient();
  const { count } = await supabase
    .from("project_documents")
    .select("*", { count: "exact", head: true })
    .eq("project_id", projectId);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Add documents</h2>
          <p className="text-xs text-muted-foreground">
            Drop files here to index them for AI Q&amp;A. Existing documents
            stay accessible to the chat below.
          </p>
        </div>
        {typeof count === "number" && count > 0 && (
          <p className="text-xs text-muted-foreground">
            {count} {count === 1 ? "file indexed" : "files indexed"}
          </p>
        )}
      </div>

      <DocumentUploader projectId={projectId} />
    </section>
  );
}
