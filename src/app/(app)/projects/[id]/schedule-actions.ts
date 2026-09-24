"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/lib/database.types";
import { parsePredecessors, serializeLinks } from "@/lib/schedule-cpm";
import { orderRenames } from "@/lib/schedule-edit";
import { todayIso } from "@/lib/schedule-calendar";
import {
  describeAfpFollowUp,
  describeDeliverySync,
  planDeliverySync,
  type DeliveryTaskLike,
} from "@/lib/schedule-po-delivery";
import { resolveBillingPeriod } from "@/lib/billing-period-resolve";
import { captureScheduleSnapshot } from "@/lib/schedule-sync-server";
import {
  TASK_TYPES,
  progressCanBeSetByHand,
  progressFromStatus,
  type TaskType,
} from "@/lib/schedule-task-type";

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

/**
 * A task type the database has not been widened for yet.
 *
 * Each new type arrives with a migration that widens the check constraint -
 * procurement in 0057, inspection in 0058. Until it runs, saving that type
 * fails on "new row violates check constraint schedule_tasks_task_type_chk",
 * which names a database object nobody outside this file has heard of.
 *
 * The message does not name a migration number, because it would be wrong the
 * next time a type is added and a stale instruction is worse than a vague one.
 */
function taskTypeConstraintMessage(
  error: { code?: string; message?: string } | null,
): string | null {
  if (!error) return null;
  const hit =
    error.code === "23514" || /schedule_tasks_task_type_chk/i.test(error.message ?? "");
  if (!hit || !/task_type_chk/i.test(error.message ?? "")) return null;
  return "This task type needs its database migration run before it can be saved. The types already in the database keep working without it.";
}

export type ScheduleTaskResult =
  | { ok: true; deliveryNote?: string | null }
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
  // The form only carries Type once 0051 is applied. Leaving the key out
  // otherwise keeps the update from naming a column that does not exist.
  if (formData.has("task_type")) update.task_type = parseTaskType(formData.get("task_type"));

  // Same rule as the grid: on a deliverable or a procurement row the status
  // decides the percent, because there is no field report to take one from.
  // See progressFromStatus.
  const { data: prior } = await auth.supabase
    .from("schedule_tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();
  const derived = progressFromStatus({
    taskType:
      (update.task_type as string | null | undefined) ??
      ((prior as { task_type?: string | null } | null)?.task_type ?? null),
    status: update.status ?? null,
    currentPct: (prior as { pct_complete?: number | null } | null)?.pct_complete ?? null,
  });
  if (derived) Object.assign(update, derived);

  const { error } = await auth.supabase
    .from("schedule_tasks")
    .update(update)
    .eq("id", taskId);
  if (error) {
    return { ok: false, error: taskTypeConstraintMessage(error) ?? error.message };
  }

  // Same as the grid: a delivery closed out here reaches the PO, and the AFP.
  const priorRow = prior as Record<string, unknown> | null;
  const deliveryNote =
    derived?.pct_complete === 100 && priorRow?.wbs_code
      ? await recordDeliveriesOnPos(auth.supabase, projectId, [
          {
            wbs_code: String(priorRow.wbs_code),
            task_name: (priorRow.task_name as string | null) ?? null,
            end_date: update.end_date ?? ((priorRow.end_date as string | null) ?? null),
          },
        ])
      : null;

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, deliveryNote };
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

  // Same capture the weekly snapshot uses, so a hand-taken update and an
  // automatic one are the same record.
  const { data: { user } } = await auth.supabase.auth.getUser();
  const res = await captureScheduleSnapshot(auth.supabase, projectId, {
    label: opts.label,
    notes: opts.notes,
    userId: user?.id ?? null,
  });
  if (!res.ok) {
    if (res.code === "23505")
      return {
        ok: false,
        error: "An update already exists at this data date. Move the data date forward before taking another - two updates on the same date cannot both be the record.",
      };
    return { ok: false, error: res.error };
  }

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, dataDate: res.dataDate, taskCount: res.taskCount };
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
  "task_type",
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

function parseTaskType(v: FormDataEntryValue | null): TaskType | null {
  return TASK_TYPES.includes(v as TaskType) ? (v as TaskType) : null;
}

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
      ...(formData.has("task_type") ? { task_type: parseTaskType(formData.get("task_type")) } : {}),
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

/**
 * Apply a set of cell patches, and hand back the patches that would put them
 * all back.
 *
 * The inverse is read from the database immediately before the write and
 * covers exactly the fields being changed and no others, so replaying it
 * restores what was there without touching anything a later edit may have
 * changed elsewhere on the row. That is what makes one-step undo safe here
 * without a migration or an audit table: the browser holds a patch set that is
 * only ever the mirror of the one it just sent.
 *
 * It is deliberately one step. An undo stack that survives a refresh would be
 * a different feature with a table behind it; an undo button that works for
 * the edit you just made is most of the value and none of the schema.
 */
export async function bulkUpdateScheduleTasks(
  projectId: string,
  patches: TaskPatch[],
): Promise<
  | { ok: true; count: number; inverse: TaskPatch[]; deliveryNote?: string | null }
  | { ok: false; error: string }
> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!patches.length) return { ok: true, count: 0, inverse: [] };

  const ids = patches.map((p) => p.id);
  const { data: before, error: readError } = await auth.supabase
    .from("schedule_tasks")
    .select("*")
    .eq("project_id", projectId)
    .in("id", ids);
  if (readError) return { ok: false, error: readError.message };

  const beforeById = new Map(
    (before ?? []).map((r) => [(r as { id: string }).id, r as Record<string, unknown>]),
  );

  const inverse: TaskPatch[] = [];
  for (const p of patches) {
    const prior = beforeById.get(p.id);
    if (!prior) continue;
    const back: TaskPatch = { id: p.id };
    let any = false;
    for (const key of BULK_EDITABLE) {
      if (!(key in p)) continue;
      (back as Record<string, unknown>)[key] = prior[key] ?? null;
      any = true;
    }
    if (any) inverse.push(back);
  }

  let count = 0;
  // Rows this save takes to 100%. Their linked POs get the delivery date once
  // the schedule writes are done.
  const completed: DeliveryTaskLike[] = [];
  for (const p of patches) {
    const update = cleanPatch(p);
    // Status and progress are one fact on a deliverable or a procurement row,
    // so the status the person picked decides the percent. Derived here rather
    // than in the browser because pct_complete is deliberately not something
    // the grid can post: on a construction row it still belongs to an approved
    // field report, and progressFromStatus refuses those.
    if ("status" in p) {
      const prior = beforeById.get(p.id);
      const derived = progressFromStatus({
        // The type may be changing in this same save, so the patch wins over
        // what the row held a moment ago.
        taskType:
          ("task_type" in p
            ? (p.task_type as string | null)
            : (prior?.task_type as string | null)) ?? null,
        status: p.status as string | null,
        currentPct: prior?.pct_complete as number | null,
      });
      if (derived) Object.assign(update, derived);
      if (derived?.pct_complete === 100 && prior) {
        completed.push({
          wbs_code: String(prior.wbs_code ?? ""),
          task_name: (prior.task_name as string | null) ?? null,
          // The finish may be moving in this same save, so the patch wins.
          end_date:
            ("end_date" in p
              ? (p.end_date as string | null)
              : (prior.end_date as string | null)) ?? null,
        });
      }
    }
    if (!Object.keys(update).length) continue;
    const { error } = await auth.supabase
      .from("schedule_tasks")
      .update(update as never)
      .eq("id", p.id)
      .eq("project_id", projectId);
    if (error) {
      const message = taskTypeConstraintMessage(error) ?? error.message;
      return {
        ok: false,
        error: `${message} (stopped after ${count} of ${patches.length} - the rest were not written)`,
      };
    }
    count++;
  }

  const deliveryNote = await recordDeliveriesOnPos(
    auth.supabase,
    projectId,
    completed.filter((c) => c.wbs_code),
  );

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, count, inverse, deliveryNote };
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

// ============================================================================
// Progress on a task no field report will ever cover
// ============================================================================
//
// Percent complete belongs to approved daily reports and BULK_EDITABLE keeps
// the grid away from it. That rule exists for construction, where a typed
// number is a number nobody can defend in a pay application.
//
// It was never about the other two kinds. A permit is issued or it is not. A
// transformer is on site or it is not. There is no report that could ever set
// a percent on either, so refusing the edit protects nothing and leaves the
// row on "No report" permanently - which is exactly what Sweet Springs
// procurement has been doing.
//
// So this is the one door to pct_complete from the browser, and it checks the
// task's own type on the server before it opens. Construction and unclassified
// rows are refused here whatever the page sends.

/**
 * Record the delivery on whatever PO points at these tasks.
 *
 * Both write paths call this after they have saved, so completing a delivery
 * row in the grid and completing it in the dialog reach the AFP the same way.
 * A failure here never fails the save: the schedule edit is real and correct
 * on its own, and the note says the PO did not get stamped rather than
 * pretending the whole thing was rejected.
 */
async function recordDeliveriesOnPos(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  projectId: string,
  completed: DeliveryTaskLike[],
): Promise<string | null> {
  if (!completed.length) return null;

  const { data: pos, error } = await supabase
    .from("procurement_orders")
    .select("id, po_number, vendor_name, linked_delivery_task_wbs_code, actual_delivery_date")
    .eq("project_id", projectId);
  if (error) return `Could not check the linked purchase orders: ${error.message}`;

  const plan = planDeliverySync({
    completed,
    pos: pos ?? [],
    todayIso: todayIso(),
  });

  for (const u of plan.updates) {
    const { error: writeError } = await supabase
      .from("procurement_orders")
      .update({ actual_delivery_date: u.date })
      .eq("id", u.poId);
    if (writeError) {
      return `Saved, but ${u.label} could not be marked delivered: ${writeError.message}`;
    }
  }
  if (plan.updates.length) {
    revalidatePath(`/projects/${projectId}/procurement`);
    revalidatePath(`/projects/${projectId}/billing`);
  }

  // Delivered is not the same as billed. Stamping the date fires the milestone
  // on a procurement SOV line and does nothing at all for a PO billed by a
  // typed figure, so the equipment can be on site, the row green, and the
  // money still waiting on somebody to remember. Name the ones that are.
  let followUp: string | null = null;
  if (plan.updates.length) {
    const periodMonth = await resolveBillingPeriod(supabase, projectId);
    // Selected with * because source_procurement_order_id arrives in migration
    // 0056 and naming a missing column would error the whole request.
    const { data: staged } = await supabase
      .from("billing_entries")
      .select("*, billing_lines!inner(project_id)")
      .eq("billing_lines.project_id", projectId)
      .eq("period_month", periodMonth);
    const stagedPoIds = (staged ?? [])
      .map((e: Record<string, unknown>) => e.source_procurement_order_id as string | null)
      .filter((id: string | null): id is string => !!id);
    followUp = describeAfpFollowUp({
      delivered: plan.updates.map((u) => ({ poId: u.poId, label: u.label })),
      stagedPoIds,
      periodMonth,
    });
  }

  return [describeDeliverySync(plan), followUp].filter(Boolean).join(" ") || null;
}

export type SetProgressResult =
  | { ok: true; pct: number | null }
  | { ok: false; error: string };

export async function setTaskProgressByHand(
  taskId: string,
  projectId: string,
  /** 0 to 100, or null to clear it back to no report. */
  pct: number | null,
): Promise<SetProgressResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
    return { ok: false, error: "Percent must be between 0 and 100" };
  }

  // Read the type from the database rather than trusting what the page sent.
  const { data: task, error: readErr } = await auth.supabase
    .from("schedule_tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!task) return { ok: false, error: "Task not found" };

  const taskType = (task as { task_type?: string | null }).task_type ?? null;
  if (!progressCanBeSetByHand(taskType)) {
    return {
      ok: false,
      error:
        taskType === "construction"
          ? "Construction progress comes from approved field reports, not typed in here."
          : "Set this task's Type to Deliverable or Procurement first, then its progress can be set here.",
    };
  }

  const rounded = pct == null ? null : Math.round(pct * 10) / 10;
  const { error } = await auth.supabase
    .from("schedule_tasks")
    .update({
      pct_complete: rounded,
      // Says where the number came from, so the tooltip and any later audit
      // can tell a typed figure from an approved report.
      status_source: rounded == null ? null : "manual",
    } as TablesUpdate<"schedule_tasks">)
    .eq("id", taskId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, pct: rounded };
}
