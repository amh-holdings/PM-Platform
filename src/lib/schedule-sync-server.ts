import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { makeCalendar } from "@/lib/schedule-calendar";
import type { CpmInput } from "@/lib/schedule-cpm";
import { planScheduleSync } from "@/lib/schedule-sync";

// Rewrite a project's Start / Finish to the live forecast. See schedule-sync.ts.
//
// Called wherever the dates are about to be read or could have just changed:
// loading the schedule or the dashboard, and approving a field report. Best
// effort by design - a viewer whose role cannot write schedule_tasks simply
// sees the dates as last synced, and a failed write never breaks the page or
// the approval that triggered it.
export async function syncScheduleDates(
  supabase: SupabaseClient<Database>,
  projectId: string,
): Promise<number> {
  try {
    const { data: project } = await supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .maybeSingle();
    const proj = (project ?? {}) as Record<string, unknown>;
    const dataDate =
      (proj.schedule_data_date as string | null) ?? new Date().toISOString().slice(0, 10);
    const workWeek = (proj.work_week as number | null) === 6 ? 6 : 5;

    const [{ data: tasks, error }, { data: exceptions }] = await Promise.all([
      supabase.from("schedule_tasks").select("*").eq("project_id", projectId),
      supabase
        .from("project_calendar_exceptions")
        .select("exception_date, kind")
        .eq("project_id", projectId),
    ]);
    if (error || !tasks?.length) return 0;

    const calendar = makeCalendar(
      workWeek,
      (exceptions ?? []) as { exception_date: string; kind: "nonworking" | "working" }[],
    );
    const updates = planScheduleSync(tasks as unknown as CpmInput[], { calendar, dataDate });

    let written = 0;
    for (const u of updates) {
      const { error: writeError } = await supabase
        .from("schedule_tasks")
        .update({ start_date: u.start, end_date: u.end })
        .eq("project_id", projectId)
        .eq("wbs_code", u.wbs);
      if (!writeError) written++;
    }
    return written;
  } catch {
    return 0;
  }
}
