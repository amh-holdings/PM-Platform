import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

type Props = {
  projectId: string;
};

type Kpi = {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "warn" | "good" | "bad";
};

export async function DashboardKpis({ projectId }: Props) {
  const supabase = createClient();

  const [projectRes, billingSumRes, tasksRes, costsRes, costForecastsRes] =
    await Promise.all([
      supabase
        .from("projects")
        .select("contract_value")
        .eq("id", projectId)
        .maybeSingle(),
      supabase
        .from("v_project_billing_summary")
        .select("total_scheduled, total_billed, future_planned, total_retainage")
        .eq("project_id", projectId)
        .maybeSingle(),
      supabase
        .from("schedule_tasks")
        .select("status, is_at_risk")
        .eq("project_id", projectId),
      supabase
        .from("cost_codes")
        .select("id, estimated_cost")
        .eq("project_id", projectId),
      supabase
        .from("cost_forecasts")
        .select("actual_amount, cost_codes!inner(project_id)")
        .eq("cost_codes.project_id", projectId),
    ]);

  const contractValue =
    Number(billingSumRes.data?.total_scheduled ?? projectRes.data?.contract_value ?? 0);
  const billedToDate = Number(billingSumRes.data?.total_billed ?? 0);
  const futurePlanned = Number(billingSumRes.data?.future_planned ?? 0);
  const billedPct = contractValue > 0 ? (billedToDate / contractValue) * 100 : 0;

  const tasks = tasksRes.data ?? [];
  const totalTasks = tasks.length;
  const completeTasks = tasks.filter((t) => t.status === "Complete").length;
  const schedulePct = totalTasks > 0 ? (completeTasks / totalTasks) * 100 : 0;
  const atRisk = tasks.filter((t) => t.is_at_risk).length;

  const estTotal = (costsRes.data ?? []).reduce(
    (sum, c) => sum + Number(c.estimated_cost ?? 0),
    0,
  );
  const actTotal = (costForecastsRes.data ?? []).reduce(
    (sum, c) => sum + Number(c.actual_amount ?? 0),
    0,
  );
  const variance = actTotal - estTotal;

  const kpis: Kpi[] = [
    {
      label: "Contract value",
      value: formatCurrency(contractValue),
      sub: contractValue > 0 ? "Includes approved COs" : "Not set",
    },
    {
      label: "Billed to date",
      value: formatCurrency(billedToDate),
      sub:
        contractValue > 0
          ? `${billedPct.toFixed(1)}% of contract`
          : "No contract set",
      tone: billedPct >= 100 ? "good" : "default",
    },
    {
      label: "Future planned",
      value: formatCurrency(futurePlanned),
      sub: futurePlanned > 0 ? "Forecast next months" : "Nothing scheduled",
    },
    {
      label: "Schedule complete",
      value: `${schedulePct.toFixed(0)}%`,
      sub:
        totalTasks > 0 ? `${completeTasks} of ${totalTasks} tasks` : "No tasks",
    },
    {
      label: "At-risk tasks",
      value: String(atRisk),
      sub: atRisk === 0 ? "All on track" : "Tasks flagged at risk",
      tone: atRisk > 0 ? "warn" : "good",
    },
    {
      label: "Cost variance",
      value:
        variance === 0
          ? "$0"
          : `${variance > 0 ? "+" : "-"}${formatCurrency(Math.abs(variance))}`,
      sub:
        estTotal > 0
          ? `vs ${formatCurrency(estTotal)} estimated`
          : "No estimates set",
      tone: variance > 0 ? "bad" : variance < 0 ? "good" : "default",
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {kpis.map((k) => (
        <div
          key={k.label}
          className="rounded-lg border bg-card p-4 shadow-sm"
        >
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {k.label}
          </div>
          <div
            className={cn(
              "mt-1 text-2xl font-semibold",
              k.tone === "good" && "text-emerald-600",
              k.tone === "warn" && "text-amber-600",
              k.tone === "bad" && "text-destructive",
            )}
          >
            {k.value}
          </div>
          {k.sub && (
            <div className="mt-1 text-xs text-muted-foreground">{k.sub}</div>
          )}
        </div>
      ))}
    </div>
  );
}
