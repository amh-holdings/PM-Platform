import Link from "next/link";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";

type Props = {
  projectId: string;
};

export async function ScheduleSummary({ projectId }: Props) {
  const supabase = createClient();

  const { data: tasks, count, error } = await supabase
    .from("schedule_tasks")
    .select("status, is_at_risk", { count: "exact" })
    .eq("project_id", projectId);

  if (error) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Schedule</h2>
        <p className="text-sm text-destructive">Failed to load: {error.message}</p>
      </section>
    );
  }

  const total = count ?? 0;
  const complete = (tasks ?? []).filter((t) => t.status === "Complete").length;
  const inProgress = (tasks ?? []).filter((t) => t.status === "In Progress").length;
  const atRisk = (tasks ?? []).filter((t) => t.is_at_risk).length;
  const percentComplete = total > 0 ? (complete / total) * 100 : 0;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Schedule</h2>
          <p className="text-xs text-muted-foreground">
            {total === 0
              ? "No tasks yet"
              : `${total} tasks - ${complete} complete, ${inProgress} in progress`}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href={`/projects/${projectId}/schedule`}>Open schedule</Link>
        </Button>
      </div>

      {total > 0 && (
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{percentComplete.toFixed(0)}% complete</span>
            {atRisk > 0 && (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                {atRisk} at risk
              </span>
            )}
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full bg-emerald-500 transition-all")}
              style={{ width: `${percentComplete}%` }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
