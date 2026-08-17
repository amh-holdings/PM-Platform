import { createClient } from "@/lib/supabase/server";

import { ScheduleWorkspace } from "./schedule-workspace";

type Params = { id: string };

const BASE_COLS =
  "id, wbs_code, task_name, description, phase, assigned_to, status, duration_days, start_date, end_date, predecessors, is_at_risk, is_internal, non_ahc_delay, level_code, sort_order, pct_complete, status_source, last_dpr_at";
const BASELINE_COLS = "baseline_start, baseline_end, baseline_set_at, baseline_label";

export default async function ProjectSchedulePage({ params }: { params: Params }) {
  const supabase = createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("name")
    .eq("id", params.id)
    .maybeSingle();

  // Baseline columns arrive with migration 0032, which is applied by hand in
  // the Supabase SQL editor. Selecting them before that lands would 400 the
  // whole page, so the query falls back and the UI flags the baseline as
  // unavailable rather than breaking the schedule.
  let tasks;
  let error;
  let baselineAvailable = true;

  const withBaseline = await supabase
    .from("schedule_tasks")
    .select(`${BASE_COLS}, ${BASELINE_COLS}`)
    .eq("project_id", params.id)
    .order("sort_order", { ascending: true, nullsFirst: false });

  if (withBaseline.error) {
    baselineAvailable = false;
    const fallback = await supabase
      .from("schedule_tasks")
      .select(BASE_COLS)
      .eq("project_id", params.id)
      .order("sort_order", { ascending: true, nullsFirst: false });
    tasks = fallback.data;
    error = fallback.error;
  } else {
    tasks = withBaseline.data;
    error = withBaseline.error;
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load schedule: {error.message}
      </div>
    );
  }

  return (
    <ScheduleWorkspace
      projectId={params.id}
      projectName={project?.name ?? "Project"}
      tasks={(tasks ?? []) as never}
      baselineAvailable={baselineAvailable}
    />
  );
}
