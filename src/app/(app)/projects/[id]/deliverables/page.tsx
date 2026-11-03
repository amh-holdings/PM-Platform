import { guardCapability } from "@/lib/roles-server";
import { createClient } from "@/lib/supabase/server";

import { DeliverablesView, type DeliverableRow } from "../deliverables-view";

type Params = { id: string };

export default async function ProjectDeliverablesPage({ params }: { params: Params }) {
  await guardCapability("viewDeliverables");
  const supabase = createClient();

  // 0086 is applied by hand like every migration here, so a database without
  // it loses this page rather than the project.
  const res = await supabase
    .from("project_deliverables")
    .select("id, catalog_key, device_id, state, version_date, submitted_on, file_url, notes")
    .eq("project_id", params.id);
  if (res.error) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        Apply migration 0086 to use the Exhibit S checklist. ({res.error.message})
      </div>
    );
  }

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
      today={new Date().toISOString().slice(0, 10)}
    />
  );
}
