import { guardCapability } from "@/lib/roles-server";
import { createClient } from "@/lib/supabase/server";

import { DeliverablesView, type DeliverableRow, type RevisionRow } from "../deliverables-view";

type Params = { id: string };

export default async function ProjectDeliverablesPage({ params }: { params: Params }) {
  await guardCapability("viewDeliverables");
  const supabase = createClient();

  // 0086 is applied by hand like every migration here, so a database without
  // it loses this page rather than the project.
  const res = await supabase
    .from("project_deliverables")
    .select("id, catalog_key, device_id, control_no, state, version_date, submitted_on, file_url, notes")
    .eq("project_id", params.id);
  if (res.error) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        Apply migration 0086 to use the Exhibit S checklist. ({res.error.message})
      </div>
    );
  }

  // Revisions arrive with 0087. Without it the checklist works, minus history.
  const ids = (res.data ?? []).map((r) => r.id);
  const revRes = ids.length
    ? await supabase
        .from("project_deliverable_revisions")
        .select("id, deliverable_id, rev_no, version_date, submitted_on, decision, decided_on, notes")
        .in("deliverable_id", ids)
        .order("rev_no", { ascending: true })
    : { data: [], error: null };

  const { data: project } = await supabase
    .from("projects")
    .select("name, spv_name")
    .eq("id", params.id)
    .maybeSingle();

  return (
    <DeliverablesView
      projectId={params.id}
      spvName={project?.spv_name ?? null}
      projectName={project?.name ?? ""}
      rows={(res.data ?? []) as DeliverableRow[]}
      revisions={(revRes.data ?? []) as RevisionRow[]}
      revisionsEnabled={!revRes.error}
      today={new Date().toISOString().slice(0, 10)}
    />
  );
}
