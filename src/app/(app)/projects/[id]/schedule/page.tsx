import { createClient } from "@/lib/supabase/server";

import { ScheduleWorkspace } from "./schedule-workspace";

type Params = { id: string };

const BASE_COLS =
  "id, wbs_code, task_name, description, phase, assigned_to, status, duration_days, start_date, end_date, predecessors, is_at_risk, is_internal, non_ahc_delay, level_code, sort_order, pct_complete, status_source, last_dpr_at";
const BASELINE_COLS = "baseline_start, baseline_end, baseline_set_at, baseline_label";
const PHASE1_COLS = "is_milestone, date_constraint_type, date_constraint_date";

// Migrations here are applied by hand in the Supabase SQL editor, so the page
// cannot assume a column exists. Selecting a missing one 400s the whole query
// and takes the schedule down with it. Each optional column set is probed once
// and the UI degrades to "not enabled" rather than breaking, which is what
// lets a migration land on its own schedule without a deploy alongside it.
export default async function ProjectSchedulePage({ params }: { params: Params }) {
  const supabase = createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  const proj = (project ?? {}) as Record<string, unknown>;
  const projectName = (proj.name as string | undefined) ?? "Project";
  const dataDate = (proj.schedule_data_date as string | null) ?? null;
  const workWeek = ((proj.work_week as number | null) ?? 5) === 6 ? 6 : 5;

  let tasks: Record<string, unknown>[] | null = null;
  let error: { message: string } | null = null;
  let baselineAvailable = true;
  let phase1Available = true;

  const full = await supabase
    .from("schedule_tasks")
    .select(`${BASE_COLS}, ${BASELINE_COLS}, ${PHASE1_COLS}`)
    .eq("project_id", params.id)
    .order("sort_order", { ascending: true, nullsFirst: false });

  if (!full.error) {
    tasks = full.data as never;
  } else {
    // 0033 not applied. Try again without the Phase 1 columns.
    phase1Available = false;
    const withBaseline = await supabase
      .from("schedule_tasks")
      .select(`${BASE_COLS}, ${BASELINE_COLS}`)
      .eq("project_id", params.id)
      .order("sort_order", { ascending: true, nullsFirst: false });

    if (!withBaseline.error) {
      tasks = withBaseline.data as never;
    } else {
      // 0032 not applied either.
      baselineAvailable = false;
      const base = await supabase
        .from("schedule_tasks")
        .select(BASE_COLS)
        .eq("project_id", params.id)
        .order("sort_order", { ascending: true, nullsFirst: false });
      tasks = base.data as never;
      error = base.error;
    }
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load schedule: {error.message}
      </div>
    );
  }

  // Calendar exceptions and the constraint log both arrive with their own
  // migrations. Neither is load-bearing for the schedule itself, so a missing
  // table degrades to an empty list and the tab says why.
  const [exceptionsQuery, constraintsQuery, updatesQuery] = await Promise.all([
    supabase
      .from("project_calendar_exceptions")
      .select("id, exception_date, kind, reason")
      .eq("project_id", params.id)
      .order("exception_date", { ascending: true }),
    supabase
      .from("schedule_constraints")
      .select(
        "id, project_id, wbs_code, category, title, description, owner, need_by, status, cleared_at, resolution, source, source_id, created_at",
      )
      .eq("project_id", params.id)
      .order("need_by", { ascending: true, nullsFirst: false }),
    supabase
      .from("schedule_updates")
      .select(
        "id, data_date, label, notes, planned_finish, projected_finish, finish_slip_days, task_count, critical_count, health_score, taken_at",
      )
      .eq("project_id", params.id)
      .order("data_date", { ascending: false })
      .limit(24),
  ]);

  return (
    <ScheduleWorkspace
      projectId={params.id}
      projectName={projectName}
      tasks={(tasks ?? []) as never}
      baselineAvailable={baselineAvailable}
      phase1Available={phase1Available}
      dataDate={dataDate}
      workWeek={workWeek}
      calendarExceptions={(exceptionsQuery.data ?? []) as never}
      calendarAvailable={!exceptionsQuery.error}
      constraints={(constraintsQuery.data ?? []) as never}
      constraintsAvailable={!constraintsQuery.error}
      updates={(updatesQuery.data ?? []) as never}
      updatesAvailable={!updatesQuery.error}
    />
  );
}
