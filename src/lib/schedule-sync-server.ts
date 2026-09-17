import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { makeCalendar, type Calendar } from "@/lib/schedule-calendar";
import { computeCpm, type CpmInput } from "@/lib/schedule-cpm";
import { assessSchedule, type HealthInput } from "@/lib/schedule-health";
import { loadProgressHistory, withProgressHistory } from "@/lib/schedule-progress-history";
import { planScheduleSync } from "@/lib/schedule-sync";

type Client = SupabaseClient<Database>;

type ScheduleContext = {
  dataDate: string;
  calendar: Calendar;
  tasks: (Record<string, unknown> & { id: string })[];
};

// Everything the forecast reads, loaded the same way for every caller - the
// sync, the snapshot and the schedule page must not disagree about what the
// schedule says.
export async function loadScheduleContext(
  supabase: Client,
  projectId: string,
): Promise<ScheduleContext | null> {
  const [{ data: project }, { data: tasks, error }, { data: exceptions }, history] =
    await Promise.all([
      supabase.from("projects").select("*").eq("id", projectId).maybeSingle(),
      supabase
        .from("schedule_tasks")
        .select("*")
        .eq("project_id", projectId)
        .order("sort_order", { ascending: true, nullsFirst: false }),
      supabase
        .from("project_calendar_exceptions")
        .select("exception_date, kind")
        .eq("project_id", projectId),
      loadProgressHistory(supabase, projectId),
    ]);
  if (error || !tasks?.length) return null;
  const proj = (project ?? {}) as Record<string, unknown>;
  return {
    dataDate:
      (proj.schedule_data_date as string | null) ?? new Date().toISOString().slice(0, 10),
    calendar: makeCalendar(
      (proj.work_week as number | null) === 6 ? 6 : 5,
      (exceptions ?? []) as { exception_date: string; kind: "nonworking" | "working" }[],
    ),
    tasks: withProgressHistory(tasks as never as { id: string }[], history) as never,
  };
}

// Rewrite a project's Start / Finish to the live forecast. See schedule-sync.ts.
//
// Called wherever the dates are about to be read or could have just changed:
// loading the schedule or the dashboard, and approving a field report. Best
// effort by design - a viewer whose role cannot write schedule_tasks simply
// sees the dates as last synced, and a failed write never breaks the page or
// the approval that triggered it.
export async function syncScheduleDates(supabase: Client, projectId: string): Promise<number> {
  try {
    const ctx = await loadScheduleContext(supabase, projectId);
    if (!ctx) return 0;
    const updates = planScheduleSync(ctx.tasks as unknown as CpmInput[], {
      calendar: ctx.calendar,
      dataDate: ctx.dataDate,
    });
    let written = 0;
    for (const u of updates) {
      const { error } = await supabase
        .from("schedule_tasks")
        .update({ start_date: u.start, end_date: u.end })
        .eq("project_id", projectId)
        .eq("wbs_code", u.wbs);
      if (!error) written++;
    }
    return written;
  } catch {
    return 0;
  }
}

// Freeze the schedule as it stands: every task row plus the headline numbers.
// The numbers are recomputed here rather than accepted from a browser, because
// a snapshot is a record of what the schedule SAID.
export async function captureScheduleSnapshot(
  supabase: Client,
  projectId: string,
  opts: { label?: string | null; notes?: string | null; userId?: string | null } = {},
): Promise<{ ok: true; dataDate: string; taskCount: number } | { ok: false; error: string; code?: string }> {
  const ctx = await loadScheduleContext(supabase, projectId);
  if (!ctx) return { ok: false, error: "No schedule tasks to snapshot." };
  const rows = ctx.tasks as unknown as HealthInput[];
  const cpm = computeCpm(rows, { calendar: ctx.calendar, dataDate: ctx.dataDate });
  const health = assessSchedule(rows, cpm, { calendar: ctx.calendar, dataDate: ctx.dataDate });

  // The stored copy is the task rows as they are in the table, without the
  // report history merged in for the calculation.
  const stored = ctx.tasks.map((t) => {
    const row: Record<string, unknown> = { ...t };
    delete row.last_report_date;
    delete row.last_progress_date;
    return row;
  });

  const { error } = await supabase.from("schedule_updates").insert({
    project_id: projectId,
    data_date: ctx.dataDate,
    label: opts.label?.trim() || `Update ${ctx.dataDate}`,
    notes: opts.notes?.trim() || null,
    planned_finish: cpm.plannedFinish,
    projected_finish: cpm.projectedFinish,
    finish_slip_days: cpm.finishSlipDays,
    task_count: rows.length,
    critical_count: cpm.criticalPath.length,
    health_score: health.score,
    tasks: stored as never,
    taken_by: opts.userId ?? null,
  });
  if (error) return { ok: false, error: error.message, code: error.code };
  return { ok: true, dataDate: ctx.dataDate, taskCount: rows.length };
}

// Monday of the week containing an ISO date.
export function weekStartOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

// One snapshot a week, taken the first time the project is opened that week.
//
// Start and Finish now move every day, so without this the only version of the
// schedule is today's. There is no cron behind it on purpose: the app is opened
// every working day, and a snapshot taken on the first load of the week is the
// schedule as the week began - which is the one worth comparing. Best effort,
// same as the sync: a viewer who cannot write snapshots simply does not take one.
export async function ensureWeeklySnapshot(supabase: Client, projectId: string): Promise<boolean> {
  try {
    const { data: latest, error } = await supabase
      .from("schedule_updates")
      .select("data_date")
      .eq("project_id", projectId)
      .order("data_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return false;
    const today = new Date().toISOString().slice(0, 10);
    if (latest && latest.data_date >= weekStartOf(today)) return false;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const res = await captureScheduleSnapshot(supabase, projectId, {
      label: `Weekly ${today}`,
      userId: user?.id ?? null,
    });
    return res.ok;
  } catch {
    return false;
  }
}
