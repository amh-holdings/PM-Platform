import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { ScheduleTable } from "./schedule-table";

type Params = { id: string };

export async function generateMetadata({ params }: { params: Params }) {
  const supabase = createClient();
  const { data } = await supabase
    .from("projects")
    .select("name")
    .eq("id", params.id)
    .maybeSingle();
  return {
    title: data ? `${data.name} schedule - AHC PM Platform` : "Schedule - AHC PM Platform",
  };
}

export default async function ProjectSchedulePage({ params }: { params: Params }) {
  const supabase = createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", params.id)
    .maybeSingle();
  if (!project) notFound();

  const { data: tasks, error } = await supabase
    .from("schedule_tasks")
    .select(
      "id, wbs_code, task_name, description, phase, assigned_to, status, duration_days, start_date, end_date, predecessors, is_at_risk, is_internal, non_ahc_delay, level_code, sort_order",
    )
    .eq("project_id", params.id)
    .order("sort_order", { ascending: true, nullsFirst: false });

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${project.id}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; {project.name}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Schedule</h1>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load schedule: {error.message}
        </div>
      ) : (
        <ScheduleTable projectId={params.id} tasks={tasks ?? []} />
      )}
    </div>
  );
}
