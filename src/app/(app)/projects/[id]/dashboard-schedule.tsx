import Link from "next/link";

import { createClient } from "@/lib/supabase/server";

import { DashboardScheduleChart } from "./dashboard-schedule-chart";

type Props = {
  projectId: string;
};

export async function DashboardSchedule({ projectId }: Props) {
  const supabase = createClient();

  const { data: tasks, error } = await supabase
    .from("schedule_tasks")
    .select("id, wbs_code, task_name, phase, status, is_at_risk, end_date")
    .eq("project_id", projectId);

  if (error) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Schedule</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {error.message}
        </p>
      </section>
    );
  }

  const rows = tasks ?? [];

  const phaseCounts = new Map<string, { complete: number; total: number }>();
  for (const t of rows) {
    const phase = (t.phase ?? "Unassigned").trim() || "Unassigned";
    if (!phaseCounts.has(phase))
      phaseCounts.set(phase, { complete: 0, total: 0 });
    const entry = phaseCounts.get(phase)!;
    entry.total += 1;
    if (t.status === "Complete") entry.complete += 1;
  }
  const chartData = Array.from(phaseCounts.entries())
    .map(([phase, { complete, total }]) => ({
      phase,
      complete,
      total,
      pct: total > 0 ? (complete / total) * 100 : 0,
    }))
    .sort((a, b) => a.phase.localeCompare(b.phase));

  const atRisk = rows
    .filter((t) => t.is_at_risk)
    .sort((a, b) => {
      const ad = a.end_date ?? "9999-99-99";
      const bd = b.end_date ?? "9999-99-99";
      return ad.localeCompare(bd);
    })
    .slice(0, 5);

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Schedule by phase</h2>
          <p className="text-xs text-muted-foreground">
            % of tasks complete per phase
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/schedule`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          View all &rarr;
        </Link>
      </div>

      <DashboardScheduleChart data={chartData} />

      <div className="border-t pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            At-risk tasks
          </h3>
          <span className="text-xs text-muted-foreground">
            {atRisk.length === 0 ? "None" : `${atRisk.length} shown`}
          </span>
        </div>
        {atRisk.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No tasks flagged at risk.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {atRisk.map((t) => (
              <li
                key={t.id}
                className="flex items-start justify-between gap-3 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.task_name}</div>
                  <div className="text-muted-foreground">
                    {t.wbs_code}
                    {t.phase ? ` - ${t.phase}` : ""}
                  </div>
                </div>
                <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive">
                  {t.end_date ?? "no date"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
