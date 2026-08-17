"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/lib/database.types";
import { makeCalendar } from "@/lib/schedule-calendar";
import { computeCpm } from "@/lib/schedule-cpm";
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
