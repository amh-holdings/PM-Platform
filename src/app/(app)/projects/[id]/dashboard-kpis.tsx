import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { deriveContractValue } from "@/lib/project-financials";
import { rollUpCostCodes } from "@/lib/ceo-report-financials";

type Props = {
  projectId: string;
  // When false (Construction Manager), the internal Cost variance tile is
  // omitted so AHC's cost/margin position stays Phil-only.
  showCosts?: boolean;
};

type Kpi = {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "warn" | "good" | "bad";
};

export async function DashboardKpis({ projectId, showCosts = true }: Props) {
  const supabase = createClient();

  const [projectRes, billingSumRes, tasksRes, costsRes, costForecastsRes, cosRes] =
    await Promise.all([
      supabase
        .from("projects")
        // "*" because original_contract_value (0046) is not in the generated
        // types yet, and PostgREST errors on a named column it cannot find.
        .select("*")
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
        // `code` is what says whether a row is a budget line or a breakdown of
        // one. Summing without it double counts the hierarchy.
        .select("id, code, estimated_cost")
        .eq("project_id", projectId),
      supabase
        .from("cost_forecasts")
        .select("actual_amount, cost_codes!inner(project_id)")
        .eq("cost_codes.project_id", projectId),
      // The agreement side of the contract value: approved change orders only.
      supabase
        .from("change_orders")
        .select("co_value, status")
        .eq("project_id", projectId),
    ]);

  // The contract is the AGREEMENT - original price plus approved change orders,
  // the same arithmetic Exhibit H prints. The SOV total is a second,
  // independent answer and becomes a cross-check rather than the headline.
  // See project-financials.ts for why reading the SOV alone was wrong.
  const approvedCoValue = (cosRes.data ?? [])
    .filter((c) => c.status === "approved")
    .reduce((sum, c) => sum + Number(c.co_value ?? 0), 0);
  const project = projectRes.data as {
    contract_value?: number | null;
    original_contract_value?: number | null;
  } | null;
  // Falls back to contract_value when no original is recorded, which is the
  // pre-0046 shape. deriveContractValue reports which one it used.
  const originalContractValue =
    project?.original_contract_value ?? project?.contract_value ?? null;
  const contract = deriveContractValue({
    originalContractValue:
      originalContractValue == null ? null : Number(originalContractValue),
    approvedCoValue,
    sovTotal: Number(billingSumRes.data?.total_scheduled ?? 0),
  });
  const contractValue = contract.value;
  const billedToDate = Number(billingSumRes.data?.total_billed ?? 0);
  const futurePlanned = Number(billingSumRes.data?.future_planned ?? 0);
  const billedPct = contractValue > 0 ? (billedToDate / contractValue) * 100 : 0;

  const tasks = tasksRes.data ?? [];
  const totalTasks = tasks.length;
  const completeTasks = tasks.filter((t) => t.status === "Complete").length;
  const schedulePct = totalTasks > 0 ? (completeTasks / totalTasks) * 100 : 0;
  const atRisk = tasks.filter((t) => t.is_at_risk).length;

  // Cost codes are dotted: "SSC T" is the budget line and "SSC T.1".."SSC T.15"
  // break it down. Summing every row counts the breakdown on top of the line it
  // breaks down, which on Sweet Springs reported $3.90M of budget against a
  // $3.79M contract. rollUpCostCodes keeps the parent and folds the children -
  // it was written for exactly this and only the dormant CEO module used it.
  const rollup = rollUpCostCodes(
    (costsRes.data ?? []).map((c) => ({
      code: c.code,
      name: null,
      estimated_cost: c.estimated_cost == null ? null : Number(c.estimated_cost),
      actual_cost: null,
      is_change_order: null,
    })),
  );
  const estTotal = rollup.budget;
  const actTotal = (costForecastsRes.data ?? []).reduce(
    (sum, c) => sum + Number(c.actual_amount ?? 0),
    0,
  );
  const variance = actTotal - estTotal;

  const kpis: Kpi[] = [
    {
      label: "Contract value",
      value: formatCurrency(contractValue),
      // Say where the number came from. "Includes approved COs" was a claim
      // about provenance the old figure could not make - it was whatever sat
      // in billing_lines.
      sub:
        contract.basis === "sov"
          ? contractValue > 0
            ? "From the SOV - no original contract price on record"
            : "Not set"
          : `${formatCurrency(contract.originalContractValue ?? 0)} original${
              contract.approvedCoValue !== 0
                ? ` + ${formatCurrency(contract.approvedCoValue)} approved COs`
                : ", no approved COs"
            }`,
      tone: contract.sovDisagrees ? "warn" : "default",
    },
    // Only when the two answers differ. A silent gap here means AHC is
    // scheduled to bill something other than what it is owed: over the
    // contract and the overage gets rejected, under it and work has no line
    // to bill against.
    ...(contract.sovDisagrees
      ? [
          {
            label: "SOV does not match",
            value: `${contract.sovDrift > 0 ? "+" : "-"}${formatCurrency(Math.abs(contract.sovDrift))}`,
            sub: `SOV totals ${formatCurrency(contract.sovTotal)} against a ${formatCurrency(contractValue)} contract`,
            tone: "bad" as const,
          },
        ]
      : []),
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
    ...(showCosts
      ? [
          {
            label: "Cost variance",
            value:
              variance === 0
                ? "$0"
                : `${variance > 0 ? "+" : "-"}${formatCurrency(Math.abs(variance))}`,
            sub:
              estTotal > 0
                ? `vs ${formatCurrency(estTotal)} budget${
                    rollup.doubleCounted !== 0
                      ? ` · ${formatCurrency(rollup.doubleCounted)} of breakdown folded into its parent`
                      : ""
                  }`
                : "No estimates set",
            tone: (variance > 0 ? "bad" : variance < 0 ? "good" : "default") as Kpi["tone"],
          },
        ]
      : []),
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
