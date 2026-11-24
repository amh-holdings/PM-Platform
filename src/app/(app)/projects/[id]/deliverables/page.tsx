import type { SupabaseClient } from "@supabase/supabase-js";

import { guardCapability } from "@/lib/roles-server";
import { createClient } from "@/lib/supabase/server";

import { DeliverablesView, type DeliverableRow, type RevisionRow, type SubmittalRow } from "../deliverables-view";

type Params = { id: string };

export default async function ProjectDeliverablesPage({ params }: { params: Params }) {
  await guardCapability("viewDeliverables");
  const supabase = createClient();
  // Tables from 0093 come after the generated types.
  const db = supabase as unknown as SupabaseClient;

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

  // Revisions arrive with 0087, their submittal with 0093. Without either the
  // checklist still works, minus that history.
  const ids = (res.data ?? []).map((r) => r.id);
  const revCols = "id, deliverable_id, rev_no, version_date, submitted_on, decision, decided_on, notes";
  let revRes: { data: unknown[] | null; error: { message: string } | null } = ids.length
    ? await db.from("project_deliverable_revisions").select(`${revCols}, submittal_id`)
        .in("deliverable_id", ids).order("rev_no", { ascending: true })
    : { data: [], error: null };
  if (revRes.error && ids.length) {
    revRes = await db.from("project_deliverable_revisions").select(revCols)
      .in("deliverable_id", ids).order("rev_no", { ascending: true });
  }

  const subRes = await db
    .from("project_submittals")
    .select("id, submittal_no, submitted_on, transmitted_for, transmitted_other, project_label, to_name, from_name, cc, subject, notes, requested_response_date")
    .eq("project_id", params.id)
    .order("submittal_no", { ascending: true });

  const { data: project } = await supabase
    .from("projects")
    .select("name, spv_name")
    .eq("id", params.id)
    .maybeSingle();
  const { data: prefixRow } = await db.from("projects").select("submittal_prefix").eq("id", params.id).maybeSingle();

  const { data: { user } } = await supabase.auth.getUser();
  const { data: me } = user
    ? await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle()
    : { data: null };

  return (
    <DeliverablesView
      projectId={params.id}
      spvName={project?.spv_name ?? null}
      projectName={project?.name ?? ""}
      rows={(res.data ?? []) as DeliverableRow[]}
      revisions={(revRes.data ?? []) as RevisionRow[]}
      revisionsEnabled={!revRes.error}
      submittals={(subRes.data ?? []) as SubmittalRow[]}
      submittalsEnabled={!subRes.error}
      submittalPrefix={(prefixRow as { submittal_prefix?: string | null } | null)?.submittal_prefix ?? null}
      userName={me?.full_name ?? ""}
      today={new Date().toISOString().slice(0, 10)}
    />
  );
}
