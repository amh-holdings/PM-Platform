import Link from "next/link";
import { notFound } from "next/navigation";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";

import { DprReviewActions } from "./dpr-review-actions";

type Params = { id: string; dprId: string };

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  returned: "bg-destructive/10 text-destructive",
};

export default async function DprDetailPage({ params }: { params: Params }) {
  const supabase = createClient();

  const { data: dpr, error } = await supabase
    .from("dprs")
    .select(
      "id, project_id, report_date, status, work_narrative, crew_count, total_man_hours, weather_conditions, safety_incident, near_miss, safety_narrative, submitted_at, reviewed_at, review_notes",
    )
    .eq("id", params.dprId)
    .maybeSingle();
  if (error || !dpr) notFound();

  const { data: updates } = await supabase
    .from("dpr_task_updates")
    .select(
      "id, schedule_task_id, previous_status, new_status, previous_pct_complete, new_pct_complete, installed_quantity, notes",
    )
    .eq("dpr_id", params.dprId);

  const taskIds = (updates ?? [])
    .map((u) => u.schedule_task_id)
    .filter((id): id is string => !!id);
  const { data: taskRows } = taskIds.length
    ? await supabase
        .from("schedule_tasks")
        .select("id, wbs_code, task_name, phase")
        .in("id", taskIds)
    : { data: [] };
  const taskById = new Map((taskRows ?? []).map((t) => [t.id, t]));

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/dprs`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; DPRs
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">
            DPR for {formatDate(dpr.report_date)}
          </h2>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
              STATUS_TONE[dpr.status ?? ""] ?? "bg-muted",
            )}
          >
            {dpr.status}
          </span>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Crew count
          </div>
          <div className="mt-1 text-base font-semibold">
            {dpr.crew_count ?? "-"}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Total man-hours
          </div>
          <div className="mt-1 text-base font-semibold">
            {dpr.total_man_hours ?? "-"}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Weather
          </div>
          <div className="mt-1 text-sm">{dpr.weather_conditions ?? "-"}</div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">Work narrative</h3>
        <p className="mt-2 whitespace-pre-wrap text-sm">{dpr.work_narrative}</p>
      </section>

      {(dpr.safety_incident || dpr.near_miss || dpr.safety_narrative) && (
        <section className="rounded-lg border border-amber-500/40 bg-amber-50/30 p-4 shadow-sm">
          <h3 className="text-sm font-semibold">Safety</h3>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {dpr.safety_incident && (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive">
                Incident reported
              </span>
            )}
            {dpr.near_miss && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900">
                Near miss
              </span>
            )}
          </div>
          {dpr.safety_narrative && (
            <p className="mt-2 whitespace-pre-wrap text-sm">
              {dpr.safety_narrative}
            </p>
          )}
        </section>
      )}

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">
          Proposed schedule task updates ({updates?.length ?? 0})
        </h3>
        {(updates ?? []).length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            This DPR did not propose any task changes.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1.5 pr-2 text-left font-medium">Task</th>
                  <th className="py-1.5 pr-2 text-left font-medium">Status</th>
                  <th className="py-1.5 pr-2 text-right font-medium">% complete</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Installed qty</th>
                  <th className="py-1.5 text-left font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {(updates ?? []).map((u) => {
                  const t = u.schedule_task_id ? taskById.get(u.schedule_task_id) : null;
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">
                        <div className="font-mono text-[10px]">{t?.wbs_code ?? "?"}</div>
                        <div className="font-medium">{t?.task_name ?? "?"}</div>
                      </td>
                      <td className="py-1.5 pr-2">
                        <span className="text-muted-foreground">
                          {u.previous_status ?? "-"}
                        </span>{" "}
                        &rarr;{" "}
                        <span className="font-medium">{u.new_status ?? "-"}</span>
                      </td>
                      <td className="py-1.5 pr-2 text-right">
                        <span className="text-muted-foreground">
                          {u.previous_pct_complete ?? "-"}%
                        </span>{" "}
                        &rarr;{" "}
                        <span className="font-medium">
                          {u.new_pct_complete ?? "-"}%
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-right">
                        {u.installed_quantity ?? "-"}
                      </td>
                      <td className="py-1.5 text-muted-foreground">
                        {u.notes ?? "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dpr.review_notes && (
        <section className="rounded-lg border bg-muted/30 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Review notes
          </h3>
          <p className="mt-2 whitespace-pre-wrap text-sm">{dpr.review_notes}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Reviewed {dpr.reviewed_at ? formatDate(dpr.reviewed_at) : ""}
          </p>
        </section>
      )}

      {dpr.status === "submitted" && (
        <DprReviewActions dprId={dpr.id} projectId={params.id} />
      )}
    </div>
  );
}
