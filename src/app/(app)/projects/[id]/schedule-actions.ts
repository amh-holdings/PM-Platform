"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/lib/database.types";
import { makeCalendar } from "@/lib/schedule-calendar";
import {
  computeCpm,
  parsePredecessors,
  serializeLinks,
} from "@/lib/schedule-cpm";
import { orderRenames } from "@/lib/schedule-edit";
import { assessSchedule, type HealthInput } from "@/lib/schedule-health";

async function assertAhcUser() {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false as const, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || !["phil", "zarina", "ahc_super"].includes(profile.role)) {
    return { ok: false as const, error: "Restricted to AHC team members" };
  }
  return { ok: true as const, supabase };
}

export type ScheduleTaskResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

function getStr(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function getDate(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value;
}

function getInt(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

export async function updateScheduleTask(
  taskId: string,
  projectId: string,
  formData: FormData,
): Promise<ScheduleTaskResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  // A constraint type without a date does nothing and a date without a type is
  // ambiguous, so the pair is written together or not at all. The database
  // enforces this too (0033); catching it here turns a 400 into a field error.
  const constraintType = getStr(formData.get("date_constraint_type"));
  const constraintDate = getDate(formData.get("date_constraint_date"));
  if (constraintType && !constraintDate) {
    return {
      ok: false,
      error: "A date constraint needs a date.",
      fieldErrors: { date_constraint_date: "Required when a constraint is set" },
    };
  }

  const update: TablesUpdate<"schedule_tasks"> = {
    task_name: getStr(formData.get("task_name")) ?? undefined,
    description: getStr(formData.get("description")),
    phase: getStr(formData.get("phase")),
    assigned_to: getStr(formData.get("assigned_to")),
    status: getStr(formData.get("status")),
    duration_days: getInt(formData.get("duration_days")),
    start_date: getDate(formData.get("start_date")),
    end_date: getDate(formData.get("end_date")),
    predecessors: getStr(formData.get("predecessors")),
    is_at_risk: formData.get("is_at_risk") === "on",
    is_internal: formData.get("is_internal") === "on",
    non_ahc_delay: formData.get("non_ahc_delay") === "on",
    is_milestone: formData.get("is_milestone") === "on",
    date_constraint_type: constraintType,
    date_constraint_date: constraintType ? constraintDate : null,
  };

  const { error } = await auth.supabase
    .from("schedule_tasks")
    .update(update)
    .eq("id", taskId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

// The data date is the "as of" line for every schedule calculation. Setting it
// is deliberate rather than automatic: a data date that advances on its own
// makes last month's update recalculate itself, which is the thing it exists
// to prevent.
export async function setScheduleDataDate(
  projectId: string,
  dataDate: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("projects")
    .update({ schedule_data_date: dataDate })
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

export async function setProjectWorkWeek(
  projectId: string,
  workWeek: 5 | 6,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("projects")
    .update({ work_week: workWeek })
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

// Calendar exceptions - rain days, shutdowns, recovery Saturdays. One row per
// date, so re-recording a date replaces it rather than stacking duplicates.
export async function upsertCalendarException(
  projectId: string,
  exceptionDate: string,
  kind: "nonworking" | "working",
  reason: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data: { user } } = await auth.supabase.auth.getUser();

  const { error } = await auth.supabase
    .from("project_calendar_exceptions")
    .upsert(
      {
        project_id: projectId,
        exception_date: exceptionDate,
        kind,
        reason,
        created_by: user?.id ?? null,
      },
      { onConflict: "project_id,exception_date" },
    );
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

export async function deleteCalendarException(
  projectId: string,
  exceptionDate: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("project_calendar_exceptions")
    .delete()
    .eq("project_id", projectId)
    .eq("exception_date", exceptionDate);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

// Capture the current dates as the committed baseline. Everything downstream
// measures against this, so it is deliberately explicit rather than automatic -
// a baseline that moves on its own is not a baseline.
//
// `onlyUnbaselined` covers the common case of tasks added after the fact: it
// baselines the new rows without disturbing the committed dates on the rest,
// which is what you want when scope is added mid-job.
export async function setScheduleBaseline(
  projectId: string,
  opts: { label?: string | null; onlyUnbaselined?: boolean } = {},
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const base = auth.supabase
    .from("schedule_tasks")
    .select("id, start_date, end_date, duration_days")
    .eq("project_id", projectId);

  const { data: tasks, error: readError } = await (opts.onlyUnbaselined
    ? base.is("baseline_end", null)
    : base);
  if (readError) return { ok: false, error: readError.message };
  if (!tasks?.length) return { ok: true, count: 0 };

  const stamp = new Date().toISOString();
  const label = opts.label?.trim() || `Baseline ${stamp.slice(0, 10)}`;

  let count = 0;
  for (const t of tasks) {
    // A task with no dates has nothing to commit to.
    if (!t.start_date && !t.end_date) continue;
    const { error } = await auth.supabase
      .from("schedule_tasks")
      .update({
        baseline_start: t.start_date,
        baseline_end: t.end_date,
        baseline_duration_days: t.duration_days,
        baseline_set_at: stamp,
        baseline_label: label,
      })
      .eq("id", t.id);
    if (error) return { ok: false, error: error.message };
    count++;
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, count };
}

// Push the CPM projection into the working dates. This is the "reflow" step:
// the projection is always live and read-only, and this is the explicit act of
// accepting it as the new plan. The baseline is untouched, so the slip stays
// visible after the reflow.
export async function applyProjectedDates(
  projectId: string,
  updates: { wbs: string; start: string; end: string }[],
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!updates.length) return { ok: true, count: 0 };

  let count = 0;
  for (const u of updates) {
    const { error } = await auth.supabase
      .from("schedule_tasks")
      .update({ start_date: u.start, end_date: u.end })
      .eq("project_id", projectId)
      .eq("wbs_code", u.wbs);
    if (error) return { ok: false, error: error.message };
    count++;
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, count };
}

// Take a schedule update: a frozen copy of every task as it stands at the data
// date, plus the headline numbers.
//
// The numbers are recomputed here rather than accepted from the browser. A
// snapshot is a record of what the schedule SAID, and the only way to be sure
// of that is to read the rows and run the engine over them at the moment of
// capture. It is also the reason the table has no update policy: correcting a
// snapshot means taking a new one, which leaves both on the record.
export async function takeScheduleUpdate(
  projectId: string,
  opts: { label?: string | null; notes?: string | null } = {},
): Promise<
  | { ok: true; dataDate: string; taskCount: number }
  | { ok: false; error: string }
> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data: project, error: projectError } = await auth.supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError) return { ok: false, error: projectError.message };

  const proj = (project ?? {}) as Record<string, unknown>;
  const dataDate =
    (proj.schedule_data_date as string | null) ?? new Date().toISOString().slice(0, 10);
  const workWeek = (proj.work_week as 5 | 6 | null) ?? 5;

  const { data: tasks, error: tasksError } = await auth.supabase
    .from("schedule_tasks")
    .select("*")
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true, nullsFirst: false });
  if (tasksError) return { ok: false, error: tasksError.message };
  if (!tasks?.length)
    return { ok: false, error: "No schedule tasks to snapshot." };

  const { data: exceptions } = await auth.supabase
    .from("project_calendar_exceptions")
    .select("exception_date, kind")
    .eq("project_id", projectId);

  const calendar = makeCalendar(
    workWeek,
    (exceptions ?? []) as { exception_date: string; kind: "nonworking" | "working" }[],
  );
  const rows = tasks as unknown as HealthInput[];
  const cpm = computeCpm(rows, { calendar, dataDate });
  const health = assessSchedule(rows, cpm, { calendar, dataDate });

  const { data: { user } } = await auth.supabase.auth.getUser();

  const { error } = await auth.supabase.from("schedule_updates").insert({
    project_id: projectId,
    data_date: dataDate,
    label: opts.label?.trim() || `Update ${dataDate}`,
    notes: opts.notes?.trim() || null,
    planned_finish: cpm.plannedFinish,
    projected_finish: cpm.projectedFinish,
    finish_slip_days: cpm.finishSlipDays,
    task_count: rows.length,
    critical_count: cpm.criticalPath.length,
    health_score: health.score,
    tasks: tasks,
    taken_by: user?.id ?? null,
  });

  if (error) {
    if (error.code === "23505")
      return {
        ok: false,
        error: `An update already exists at data date ${dataDate}. Move the data date forward before taking another - two updates on the same date cannot both be the record.`,
      };
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, dataDate, taskCount: rows.length };
}

export async function deleteScheduleUpdate(
  projectId: string,
  updateId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("schedule_updates")
    .delete()
    .eq("id", updateId)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

export async function deleteScheduleTask(
  taskId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("schedule_tasks")
    .delete()
    .eq("id", taskId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

// ============================================================================
// Editing the task set - create, delete, bulk patch, structural moves, import
//
// Everything below writes through the same rows the CPM engine reads, so a
// change made in the grid, by a bulk action, by dragging a bar, or by pasting a
// sheet is indistinguishable downstream. There is deliberately no second write
// path: the moment an importer gets its own table or its own columns, the
// forecast starts depending on which door the data came through.
// ============================================================================

// Fields a bulk edit is allowed to touch. An allowlist rather than a passthrough
// because these actions take their patch from the browser, and `pct_complete`,
// `status_source` and the baseline columns must never be settable that way -
// progress belongs to approved field reports and a baseline belongs to the
// baseline action.
const BULK_EDITABLE = [
  "task_name",
  "description",
  "phase",
  "assigned_to",
  "status",
  "duration_days",
  "start_date",
  "end_date",
  "predecessors",
  "is_at_risk",
  "is_internal",
  "non_ahc_delay",
  "is_milestone",
  "date_constraint_type",
  "date_constraint_date",
  "wbs_code",
  "level_code",
  "parent_wbs_code",
  "sort_order",
] as const;

type BulkField = (typeof BULK_EDITABLE)[number];

export type TaskPatch = { id: string } & Partial<Record<BulkField, unknown>>;

function cleanPatch(patch: TaskPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of BULK_EDITABLE) {
    if (key in patch) out[key] = patch[key] ?? null;
  }
  return out;
}

// 0033 added is_milestone and the date-constraint pair, and the schedule page
// probes for them so a project on an older database degrades rather than
// breaks. Writes have to honour the same contract: an insert naming a column
// that does not exist fails the whole row. Postgres reports it as 42703 and
// PostgREST as PGRST204, so a first attempt that trips either is retried
// without the Phase 1 fields.
const PHASE1_FIELDS = ["is_milestone", "date_constraint_type", "date_constraint_date"];

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return /column .* does not exist/i.test(error.message ?? "");
}

function withoutPhase1<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row };
  for (const f of PHASE1_FIELDS) delete out[f];
  return out;
}

export async function createScheduleTask(
  projectId: string,
  formData: FormData,
): Promise<{ ok: true; id: string; wbs: string } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const wbs = getStr(formData.get("wbs_code"));
  const name = getStr(formData.get("task_name"));
  if (!wbs) return { ok: false, error: "A WBS code is required." };
  if (!name) return { ok: false, error: "A task name is required." };
  if (!/^\d+(\.\d+)*$/.test(wbs)) {
    return {
      ok: false,
      error: `"${wbs}" is not a WBS code. Use dotted numbers, like 5.1.2.3 - the hierarchy is read from the code.`,
    };
  }

  const constraintType = getStr(formData.get("date_constraint_type"));
  const constraintDate = getDate(formData.get("date_constraint_date"));
  if (constraintType && !constraintDate) {
    return { ok: false, error: "A date constraint needs a date." };
  }

  // Slot the new row directly after its parent's last descendant, so a task
  // added to a branch appears inside that branch rather than at the bottom of
  // the schedule. sort_order is spaced by 10s, leaving room to insert without
  // renumbering the whole list.
  const { data: siblings } = await auth.supabase
    .from("schedule_tasks")
    .select("wbs_code, sort_order")
    .eq("project_id", projectId);

  const parent = wbs.includes(".") ? wbs.slice(0, wbs.lastIndexOf(".")) : null;
  let sortOrder = 10;
  if (siblings?.length) {
    const branch = parent
      ? siblings.filter(
          (s) => s.wbs_code === parent || s.wbs_code.startsWith(parent + "."),
        )
      : [];
    const pool = branch.length ? branch : siblings;
    const max = pool.reduce((m, s) => Math.max(m, s.sort_order ?? 0), 0);
    sortOrder = max + (branch.length ? 1 : 10);
  }

  const row = {
      project_id: projectId,
      wbs_code: wbs,
      task_name: name,
      description: getStr(formData.get("description")),
      phase: getStr(formData.get("phase")),
      assigned_to: getStr(formData.get("assigned_to")),
      status: getStr(formData.get("status")) ?? "Not Started",
      duration_days: getInt(formData.get("duration_days")),
      start_date: getDate(formData.get("start_date")),
      end_date: getDate(formData.get("end_date")),
      predecessors: getStr(formData.get("predecessors")),
      is_at_risk: formData.get("is_at_risk") === "on",
      is_internal: formData.get("is_internal") === "on",
      non_ahc_delay: formData.get("non_ahc_delay") === "on",
      is_milestone: formData.get("is_milestone") === "on",
      date_constraint_type: constraintType,
      date_constraint_date: constraintType ? constraintDate : null,
      level_code: wbs.split(".").length,
      parent_wbs_code: parent,
      sort_order: sortOrder,
  };

  let { data, error } = await auth.supabase
    .from("schedule_tasks")
    .insert(row as never)
    .select("id")
    .single();

  if (isMissingColumn(error)) {
    ({ data, error } = await auth.supabase
      .from("schedule_tasks")
      .insert(withoutPhase1(row) as never)
      .select("id")
      .single());
  }

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `WBS ${wbs} already exists on this project.` };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, id: (data as { id: string }).id, wbs };
}

// Deleting a task is not a local act. Inspections lose their WBS link and stop
// feeding progress, DPR task updates cascade away outright, and billing lines
// and cost codes hold the code as plain text with no foreign key, so they
// simply dangle. The caller is told what it is about to break before it does.
export async function describeTaskDeletion(
  projectId: string,
  wbsCodes: string[],
): Promise<{
  ok: true;
  inspections: number;
  dprUpdates: number;
  successors: { wbs_code: string; task_name: string }[];
  children: number;
} | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!wbsCodes.length)
    return { ok: true, inspections: 0, dprUpdates: 0, successors: [], children: 0 };

  const { data: tasks } = await auth.supabase
    .from("schedule_tasks")
    .select("id, wbs_code, task_name, predecessors")
    .eq("project_id", projectId);

  const rows = tasks ?? [];
  const targets = rows.filter((t) => wbsCodes.includes(t.wbs_code));
  const ids = targets.map((t) => t.id);

  const children = rows.filter((t) =>
    wbsCodes.some((w) => t.wbs_code !== w && t.wbs_code.startsWith(w + ".")),
  ).length;

  const successors = rows
    .filter(
      (t) =>
        !wbsCodes.includes(t.wbs_code) &&
        parsePredecessors(t.predecessors).some((l) => wbsCodes.includes(l.pred)),
    )
    .map((t) => ({ wbs_code: t.wbs_code, task_name: t.task_name }));

  let inspections = 0;
  let dprUpdates = 0;
  if (ids.length) {
    const [insp, dpr] = await Promise.all([
      auth.supabase
        .from("inspections")
        .select("id", { count: "exact", head: true })
        .in("schedule_task_id", ids),
      auth.supabase
        .from("dpr_task_updates")
        .select("id", { count: "exact", head: true })
        .in("schedule_task_id", ids),
    ]);
    inspections = insp.count ?? 0;
    dprUpdates = dpr.count ?? 0;
  }

  return { ok: true, inspections, dprUpdates, successors, children };
}

export async function deleteScheduleTasks(
  projectId: string,
  taskIds: string[],
  opts: { stripPredecessors?: boolean } = {},
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!taskIds.length) return { ok: true, count: 0 };

  const { data: all } = await auth.supabase
    .from("schedule_tasks")
    .select("id, wbs_code, predecessors")
    .eq("project_id", projectId);

  const rows = all ?? [];
  const goingCodes = new Set(
    rows.filter((r) => taskIds.includes(r.id)).map((r) => r.wbs_code),
  );

  // The engine skips a predecessor it cannot resolve, so a dangling reference
  // does not error - it quietly frees the successor to start on day one. Left
  // alone that is a schedule that reads fine and forecasts nonsense, so the
  // references are cleaned out with the task by default.
  if (opts.stripPredecessors !== false && goingCodes.size) {
    for (const r of rows) {
      if (taskIds.includes(r.id)) continue;
      const links = parsePredecessors(r.predecessors);
      const kept = links.filter((l) => !goingCodes.has(l.pred));
      if (kept.length === links.length) continue;
      const { error } = await auth.supabase
        .from("schedule_tasks")
        .update({ predecessors: serializeLinks(kept) })
        .eq("id", r.id);
      if (error) return { ok: false, error: error.message };
    }
  }

  const { error } = await auth.supabase
    .from("schedule_tasks")
    .delete()
    .eq("project_id", projectId)
    .in("id", taskIds);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, count: taskIds.length };
}

export async function bulkUpdateScheduleTasks(
  projectId: string,
  patches: TaskPatch[],
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!patches.length) return { ok: true, count: 0 };

  let count = 0;
  for (const p of patches) {
    const update = cleanPatch(p);
    if (!Object.keys(update).length) continue;
    const { error } = await auth.supabase
      .from("schedule_tasks")
      .update(update as never)
      .eq("id", p.id)
      .eq("project_id", projectId);
    if (error) {
      return {
        ok: false,
        error: `${error.message} (stopped after ${count} of ${patches.length} - the rest were not written)`,
      };
    }
    count++;
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, count };
}

// Apply an indent, outdent or row move. Renames run in a dependency-safe order
// because (project_id, wbs_code) is unique: a task cannot take a code until its
// current holder has vacated. Anything caught in a cycle is parked on a
// temporary code first.
export async function applyStructurePlan(
  projectId: string,
  plan: {
    renames: { id: string; from: string; to: string }[];
    predecessorRewrites: { id: string; predecessors: string | null }[];
    levelUpdates: { id: string; level_code: number }[];
    parentUpdates: { id: string; parent_wbs_code: string | null }[];
    sortUpdates: { id: string; sort_order: number }[];
  },
): Promise<{ ok: true; renamed: number } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data: existing } = await auth.supabase
    .from("schedule_tasks")
    .select("wbs_code")
    .eq("project_id", projectId);

  const occupied = new Set((existing ?? []).map((r) => r.wbs_code));
  const { direct, viaTemp } = orderRenames(plan.renames, occupied);

  const setCode = async (id: string, code: string) => {
    const { error } = await auth.supabase
      .from("schedule_tasks")
      .update({ wbs_code: code })
      .eq("id", id)
      .eq("project_id", projectId);
    return error?.message ?? null;
  };

  // Park the cyclic set out of the way, then land everything.
  for (let i = 0; i < viaTemp.length; i++) {
    const err = await setCode(viaTemp[i].id, `~tmp${i}~${viaTemp[i].from}`);
    if (err) return { ok: false, error: err };
  }
  for (const r of direct) {
    const err = await setCode(r.id, r.to);
    if (err) return { ok: false, error: err };
  }
  for (const r of viaTemp) {
    const err = await setCode(r.id, r.to);
    if (err)
      return {
        ok: false,
        error: `${err}. Some tasks may still hold a temporary WBS code - re-run the move to clear it.`,
      };
  }

  const patches = new Map<string, Record<string, unknown>>();
  const merge = (id: string, patch: Record<string, unknown>) =>
    patches.set(id, { ...(patches.get(id) ?? {}), ...patch });

  for (const p of plan.predecessorRewrites) merge(p.id, { predecessors: p.predecessors });
  for (const l of plan.levelUpdates) merge(l.id, { level_code: l.level_code });
  for (const p of plan.parentUpdates) merge(p.id, { parent_wbs_code: p.parent_wbs_code });
  for (const s of plan.sortUpdates) merge(s.id, { sort_order: s.sort_order });

  for (const [id, patch] of Array.from(patches.entries())) {
    const { error } = await auth.supabase
      .from("schedule_tasks")
      .update(patch as never)
      .eq("id", id)
      .eq("project_id", projectId);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, renamed: plan.renames.length };
}

export type ImportPlan = {
  adds: {
    wbs_code: string;
    task_name: string;
    description?: string | null;
    phase?: string | null;
    assigned_to?: string | null;
    status?: string | null;
    duration_days?: number | null;
    start_date?: string | null;
    end_date?: string | null;
    predecessors?: string | null;
    is_milestone?: boolean | null;
  }[];
  changes: { id: string; patch: Record<string, unknown> }[];
  deleteIds: string[];
};

// Apply a reviewed import. The browser sends the plan it showed you, not the
// paste - the diff you approved is the diff that runs. Adds go in first so a
// change or a predecessor can reference a task created in the same pass.
export async function applyScheduleImport(
  projectId: string,
  plan: ImportPlan,
): Promise<
  | { ok: true; added: number; changed: number; deleted: number }
  | { ok: false; error: string }
> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data: existing } = await auth.supabase
    .from("schedule_tasks")
    .select("wbs_code, sort_order")
    .eq("project_id", projectId);

  let sort = (existing ?? []).reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0);

  if (plan.adds.length) {
    const rows = plan.adds.map((a) => {
      sort += 10;
      const parent = a.wbs_code.includes(".")
        ? a.wbs_code.slice(0, a.wbs_code.lastIndexOf("."))
        : null;
      return {
        project_id: projectId,
        wbs_code: a.wbs_code,
        task_name: a.task_name,
        description: a.description ?? null,
        phase: a.phase ?? null,
        assigned_to: a.assigned_to ?? null,
        status: a.status ?? "Not Started",
        duration_days: a.duration_days ?? null,
        start_date: a.start_date ?? null,
        end_date: a.end_date ?? null,
        predecessors: a.predecessors ?? null,
        is_milestone: a.is_milestone ?? false,
        level_code: a.wbs_code.split(".").length,
        parent_wbs_code: parent,
        sort_order: sort,
      };
    });

    // Chunked so a large paste does not hit the request size limit, and so a
    // failure names the block it stopped on.
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      let { error } = await auth.supabase
        .from("schedule_tasks")
        .insert(chunk as never);
      if (isMissingColumn(error)) {
        ({ error } = await auth.supabase
          .from("schedule_tasks")
          .insert(chunk.map(withoutPhase1) as never));
      }
      if (error) {
        if (error.code === "23505")
          return {
            ok: false,
            error: `A WBS code in this paste already exists on the project. ${
              i ? `${i} rows were added before this failed.` : "Nothing was added."
            }`,
          };
        return { ok: false, error: error.message };
      }
    }
  }

  let changed = 0;
  for (const c of plan.changes) {
    const patch = cleanPatch({ id: c.id, ...c.patch } as TaskPatch);
    if (!Object.keys(patch).length) continue;
    const { error } = await auth.supabase
      .from("schedule_tasks")
      .update(patch as never)
      .eq("id", c.id)
      .eq("project_id", projectId);
    if (error)
      return {
        ok: false,
        error: `${error.message} (${plan.adds.length} added, ${changed} updated before this failed)`,
      };
    changed++;
  }

  let deleted = 0;
  if (plan.deleteIds.length) {
    const res = await deleteScheduleTasks(projectId, plan.deleteIds);
    if (!res.ok) return res;
    deleted = res.count;
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, added: plan.adds.length, changed, deleted };
}
