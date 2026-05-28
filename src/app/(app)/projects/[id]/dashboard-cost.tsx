import Link from "next/link";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/format";

import { DashboardCostChart } from "./dashboard-cost-chart";

type Props = {
  projectId: string;
};

export async function DashboardCost({ projectId }: Props) {
  const supabase = createClient();

  const { data: rowsRaw, error } = await supabase
    .from("v_cost_code_totals")
    .select("cost_code_id, code, estimated_cost, total_planned, total_actual, remaining_budget")
    .eq("project_id", projectId);

  if (error) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Cost variance</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {error.message}
        </p>
      </section>
    );
  }

  // Pull the human-readable name from cost_codes since the view doesn't have it
  const codeIds = (rowsRaw ?? [])
    .map((r) => r.cost_code_id)
    .filter((id): id is string => !!id);
  const { data: nameRows } = codeIds.length
    ? await supabase
        .from("cost_codes")
        .select("id, name, is_change_order")
        .in("id", codeIds)
    : { data: [] };
  const nameById = new Map<string, { name: string; isCO: boolean }>();
  for (const c of nameRows ?? []) {
    nameById.set(c.id, {
      name: c.name,
      isCO: Boolean(c.is_change_order),
    });
  }

  const rows = (rowsRaw ?? []).map((r) => {
    const meta = nameById.get(r.cost_code_id ?? "");
    return {
      code: String(r.code ?? ""),
      name: meta?.name ?? r.code ?? "",
      is_change_order: meta?.isCO ?? false,
      estimated: Number(r.estimated_cost ?? 0),
      actual: Number(r.total_actual ?? 0),
      planned: Number(r.total_planned ?? 0),
      variance: Number(r.total_actual ?? 0) - Number(r.estimated_cost ?? 0),
    };
  });

  const chartData = rows
    .filter((r) => r.estimated > 0 || r.actual > 0 || r.planned > 0)
    .map((r) => ({ code: r.code, estimated: r.estimated, actual: r.actual }));

  const topOverruns = rows
    .filter((r) => r.variance > 0)
    .sort((a, b) => b.variance - a.variance)
    .slice(0, 3);

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Cost variance</h2>
          <p className="text-xs text-muted-foreground">
            Estimated vs actual, per cost code
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/costs`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          View all &rarr;
        </Link>
      </div>

      <DashboardCostChart data={chartData} />

      <div className="border-t pt-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Top overruns
        </h3>
        {topOverruns.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No cost codes are over budget.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {topOverruns.map((r) => {
              const pct =
                r.estimated > 0 ? (r.variance / r.estimated) * 100 : null;
              return (
                <li
                  key={r.code}
                  className="flex items-start justify-between gap-3 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{r.name}</div>
                    <div className="text-muted-foreground">{r.code}</div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive",
                    )}
                  >
                    +{formatCurrency(r.variance)}
                    {pct !== null && ` (${pct.toFixed(0)}%)`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
