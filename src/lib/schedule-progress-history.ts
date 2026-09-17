import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

// When a task was last reported on, and when its percent last actually moved.
//
// Two different questions, and Sweet Springs needed both. Rough Road stopped
// being reported on 9/2 and still read 10% two weeks later - no report. Debris
// Removal was reported almost every day from 8/20 to 9/16 and read 10% every
// time - reported, but not moving. A schedule driven by field reports is only
// as current as those reports, so the engine uses the second date to decide
// whether a task's pace can be trusted, and the health check names both.
//
// Only approved subcontractor pins count, by report date - the same evidence
// that moves the percent (see applyPinProgressToSchedule).

export type ProgressHistory = {
  /** Report date of the newest approved report on the task. */
  last_report_date: string | null;
  /** Report date on which the reported percent last went UP. */
  last_progress_date: string | null;
};

export type ProgressPin = {
  taskId: string;
  reportDate: string;
  pct: number | null;
};

export function summarizeProgressHistory(pins: ProgressPin[]): Map<string, ProgressHistory> {
  const byTask = new Map<string, ProgressPin[]>();
  for (const p of pins) {
    const list = byTask.get(p.taskId) ?? [];
    list.push(p);
    byTask.set(p.taskId, list);
  }
  const out = new Map<string, ProgressHistory>();
  byTask.forEach((list, taskId) => {
    list.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
    let high = 0;
    let lastProgress: string | null = null;
    for (const p of list) {
      const pct = Number(p.pct ?? 0);
      // Measured against the highest percent reported so far, not the previous
      // report: 95 -> 25 (a typo) -> 95 is not progress on the third day.
      if (pct > high) {
        high = pct;
        lastProgress = p.reportDate;
      }
    }
    out.set(taskId, {
      last_report_date: list[list.length - 1]?.reportDate ?? null,
      last_progress_date: lastProgress,
    });
  });
  return out;
}

export async function loadProgressHistory(
  supabase: SupabaseClient<Database>,
  projectId: string,
): Promise<Map<string, ProgressHistory>> {
  const [{ data: pins }, { data: dprs }] = await Promise.all([
    supabase
      .from("inspections")
      .select("schedule_task_id, task_new_pct, dpr_id")
      .eq("project_id", projectId)
      .eq("origin", "sub")
      .eq("status", "approved")
      .not("schedule_task_id", "is", null),
    supabase.from("dprs").select("id, report_date").eq("project_id", projectId),
  ]);
  const reportDate = new Map((dprs ?? []).map((d) => [d.id, d.report_date]));
  return summarizeProgressHistory(
    (pins ?? [])
      .filter((p) => p.dpr_id && reportDate.has(p.dpr_id))
      .map((p) => ({
        taskId: p.schedule_task_id as string,
        reportDate: reportDate.get(p.dpr_id as string)!,
        pct: p.task_new_pct,
      })),
  );
}

/** Attach each task's history, keyed by task id. Tasks never reported get nulls. */
export function withProgressHistory<T extends { id: string }>(
  tasks: T[],
  history: Map<string, ProgressHistory>,
): (T & ProgressHistory)[] {
  return tasks.map((t) => ({
    ...t,
    ...(history.get(t.id) ?? { last_report_date: null, last_progress_date: null }),
  }));
}
