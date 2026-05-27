import { createClient } from "@/lib/supabase/server";

import { ScheduleTable } from "./schedule-table";

type Params = { id: string };

export default async function ProjectSchedulePage({ params }: { params: Params }) {
  const supabase = createClient();

  const { data: tasks, error } = await supabase
    .from("schedule_tasks")
    .select(
      "id, wbs_code, task_name, description, phase, assigned_to, status, duration_days, start_date, end_date, predecessors, is_at_risk, is_internal, non_ahc_delay, level_code, sort_order",
    )
    .eq("project_id", params.id)
    .order("sort_order", { ascending: true, nullsFirst: false });

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load schedule: {error.message}
      </div>
    );
  }

  return <ScheduleTable projectId={params.id} tasks={tasks ?? []} />;
}
