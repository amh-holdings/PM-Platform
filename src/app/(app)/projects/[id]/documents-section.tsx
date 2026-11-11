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
  const BASE_COLS =
    "id, file_name, category, size_bytes, mime_type, text_status, uploaded_at, pages_count";

  // 0083's columns are asked for first and the query falls back without them,
  // because migrations here are applied by hand: selecting a column that does
  // not exist yet 400s and takes the whole documents page down with it.
  // 0090 (owner invoices) is tried first, then 0083 alone, then neither.
  const withOwner = await supabase
    .from("project_documents")
    .select(`${BASE_COLS}, subcontractor_id, valid_until, owner_invoice, pay_application_id`)
    .eq("project_id", projectId)
    .order("uploaded_at", { ascending: false, nullsFirst: false });
  const ownerEnabled = !withOwner.error;

  const withCompliance = ownerEnabled
    ? withOwner
    : await supabase
        .from("project_documents")
        .select(`${BASE_COLS}, subcontractor_id, valid_until`)
        .eq("project_id", projectId)
        .order("uploaded_at", { ascending: false, nullsFirst: false });

  const complianceEnabled = !withCompliance.error;
  const documents = complianceEnabled
    ? withCompliance.data
    : (
        await supabase
          .from("project_documents")
          .select(BASE_COLS)
          .eq("project_id", projectId)
          .order("uploaded_at", { ascending: false, nullsFirst: false })
      ).data;

  const rows = (documents ?? []) as Array<
    NonNullable<typeof withOwner.data>[number]
  >;

  // The roster, for the Sub dropdown. Active only: a COI belongs to a sub who
  // is still on the job, and a dropdown of everyone who ever was buries them.
  const { data: subRoster } = complianceEnabled
    ? await supabase
        .from("subcontractors")
        .select("id, company_name")
        .eq("project_id", projectId)
        .neq("active", false)
        .order("company_name", { ascending: true })
    : { data: null };

  // The owner side, for the same dropdown: the client's name and the AFPs a
  // pay application file can be tied to.
  const { data: project } = ownerEnabled
    ? await supabase.from("projects").select("client").eq("id", projectId).maybeSingle()
    : { data: null };
  const { data: afps } = ownerEnabled
    ? await supabase
        .from("pay_applications")
        .select("id, app_number, period_end")
        .eq("project_id", projectId)
        .order("period_end", { ascending: true })
    : { data: null };

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

      <DocumentList
        projectId={projectId}
        groups={groups}
        subs={subRoster ?? []}
        complianceEnabled={complianceEnabled}
        ownerEnabled={ownerEnabled}
        ownerName={project?.client ?? null}
        afps={(afps ?? []).map((a) => ({ id: a.id, label: a.app_number }))}
      />
    </section>
  );
}
