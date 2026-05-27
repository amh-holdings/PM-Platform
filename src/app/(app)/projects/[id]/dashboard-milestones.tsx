import Link from "next/link";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";

type Props = {
  projectId: string;
};

function daysFromToday(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return null;
  const target = Date.UTC(y, m - 1, d);
  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return Math.round((target - todayUtc) / (1000 * 60 * 60 * 24));
}

function relativeLabel(days: number | null): string {
  if (days === null) return "no date";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

export async function DashboardMilestones({ projectId }: Props) {
  const supabase = createClient();

  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const { data: tasks, error } = await supabase
    .from("schedule_tasks")
    .select("id, wbs_code, task_name, phase, status, start_date, end_date, is_at_risk")
    .eq("project_id", projectId)
    .neq("status", "Complete")
    .not("end_date", "is", null)
    .gte("end_date", todayIso)
    .order("end_date", { ascending: true })
    .limit(10);

  if (error) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Upcoming milestones</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {error.message}
        </p>
      </section>
    );
  }

  const rows = tasks ?? [];

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Upcoming milestones</h2>
          <p className="text-xs text-muted-foreground">
            Next {rows.length || 10} schedule tasks not yet complete
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/schedule`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          View all &rarr;
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No upcoming tasks with future end dates.
        </p>
      ) : (
        <ul className="divide-y">
          {rows.map((t) => {
            const days = daysFromToday(t.end_date);
            const urgent = days !== null && days <= 7;
            return (
              <li
                key={t.id}
                className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{t.task_name}</span>
                    {t.is_at_risk && (
                      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
                        At risk
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t.wbs_code}
                    {t.phase ? ` - ${t.phase}` : ""}
                    {t.status ? ` - ${t.status}` : ""}
                  </div>
                </div>
                <div className="shrink-0 text-right text-xs">
                  <div className="font-medium">{formatDate(t.end_date)}</div>
                  <div
                    className={cn(
                      "text-muted-foreground",
                      urgent && "text-amber-600",
                    )}
                  >
                    {relativeLabel(days)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
