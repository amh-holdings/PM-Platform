import Link from "next/link";

import { createClient } from "@/lib/supabase/server";

import { DprForm } from "./dpr-form";

type Params = { id: string };

export default async function NewDprPage({ params }: { params: Params }) {
  const supabase = createClient();

  const { data: tasks, error } = await supabase
    .from("schedule_tasks")
    .select("id, wbs_code, task_name, phase, status, pct_complete, end_date")
    .eq("project_id", params.id)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("wbs_code", { ascending: true });

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load schedule tasks: {error.message}
      </div>
    );
  }

  const taskRows = (tasks ?? []).map((t) => ({
    id: t.id,
    wbsCode: t.wbs_code,
    taskName: t.task_name,
    phase: t.phase,
    currentStatus: t.status,
    currentPct: Number(t.pct_complete ?? 0) || null,
    endDate: t.end_date,
  }));

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/dprs`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; DPRs
        </Link>
        <h2 className="mt-1 text-lg font-semibold">Submit DPR</h2>
        <p className="text-xs text-muted-foreground">
          Pick the schedule tasks worked on today, set their new status or
          percent complete, add a narrative. On approval, the schedule and the
          dashboard auto-suggest both update.
        </p>
      </div>

      <DprForm projectId={params.id} tasks={taskRows} />
    </div>
  );
}
