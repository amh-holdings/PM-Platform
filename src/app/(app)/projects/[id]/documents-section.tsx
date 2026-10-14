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

  // The list was written and never mounted, so a file uploaded here vanished
  // into a count. "once uploaded it will be automatically recorded in the
  // Documents Page" needs the page to actually show the record.
  const { data: documents } = await supabase
    .from("project_documents")
    .select(
      "id, file_name, category, size_bytes, mime_type, text_status, uploaded_at, pages_count",
    )
    .eq("project_id", projectId)
    .order("uploaded_at", { ascending: false, nullsFirst: false });

  const rows = documents ?? [];

  // Grouped in the fixed category order rather than by whatever came back
  // first, so the same category sits in the same place on every project.
  const groups = DOCUMENT_CATEGORY_ORDER.map((category) => ({
    category,
    documents: rows.filter((d) => d.category === category),
    defaultOpen: DOCUMENT_CATEGORY_DEFAULT_OPEN.includes(category),
  })).filter((g) => g.documents.length > 0);

  // A category nothing anticipated - added to the enum, not yet added to the
  // order list - would otherwise be uploadable and invisible.
  const known = new Set<DocumentCategory>(DOCUMENT_CATEGORY_ORDER);
  const strays = rows.filter((d) => !known.has(d.category));
  for (const category of Array.from(new Set(strays.map((d) => d.category)))) {
    groups.push({
      category,
      documents: strays.filter((d) => d.category === category),
      defaultOpen: false,
    });
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Add documents</h2>
          <p className="text-xs text-muted-foreground">
            Drop files here to index them for AI Q&amp;A. Files dropped on a
            schedule line land here too.
          </p>
        </div>
        {rows.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? "file indexed" : "files indexed"}
          </p>
        )}
      </div>

      <DocumentUploader projectId={projectId} />

      <DocumentList projectId={projectId} groups={groups} />
    </section>
  );
}
