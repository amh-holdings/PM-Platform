import Link from "next/link";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/format";

import { DashboardFinancialChart } from "./dashboard-financial-chart";

type Props = {
  projectId: string;
};

export async function DashboardFinancial({ projectId }: Props) {
  const supabase = createClient();

  const { data: rows, error } = await supabase
    .from("wbs_sov")
    .select("trade, contract_value, billed_to_date")
    .eq("project_id", projectId);

  if (error) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Financial</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {error.message}
        </p>
      </section>
    );
  }

  const items = rows ?? [];
  const totalContract = items.reduce(
    (sum, r) => sum + Number(r.contract_value ?? 0),
    0,
  );
  const totalBilled = items.reduce(
    (sum, r) => sum + Number(r.billed_to_date ?? 0),
    0,
  );
  const billedPct = totalContract > 0 ? (totalBilled / totalContract) * 100 : 0;

  const byTrade = new Map<string, number>();
  for (const r of items) {
    const trade = (r.trade ?? "Untagged").trim() || "Untagged";
    byTrade.set(
      trade,
      (byTrade.get(trade) ?? 0) + Number(r.contract_value ?? 0),
    );
  }
  const chartData = Array.from(byTrade.entries())
    .map(([trade, value]) => ({ trade, value }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Financial</h2>
          <p className="text-xs text-muted-foreground">
            Billed vs contract, by SOV line
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/wbs`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          View all &rarr;
        </Link>
      </div>

      <div>
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium">{formatCurrency(totalBilled)}</span>
          <span className="text-xs text-muted-foreground">
            of {formatCurrency(totalContract)} ({billedPct.toFixed(1)}%)
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full bg-emerald-500 transition-all")}
            style={{ width: `${Math.min(100, billedPct)}%` }}
          />
        </div>
      </div>

      <div className="border-t pt-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Contract by trade
        </h3>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row">
          <div className="sm:w-1/2">
            <DashboardFinancialChart data={chartData} />
          </div>
          <ul className="space-y-1 sm:w-1/2">
            {chartData.length === 0 ? (
              <li className="text-xs text-muted-foreground">No trades set</li>
            ) : (
              chartData.slice(0, 6).map((d, i) => {
                const palette = [
                  "bg-blue-500",
                  "bg-emerald-500",
                  "bg-amber-500",
                  "bg-red-500",
                  "bg-violet-500",
                  "bg-teal-500",
                ];
                const pct =
                  totalContract > 0 ? (d.value / totalContract) * 100 : 0;
                return (
                  <li
                    key={d.trade}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          "h-2.5 w-2.5 shrink-0 rounded-sm",
                          palette[i % palette.length],
                        )}
                      />
                      <span className="truncate">{d.trade}</span>
                    </div>
                    <span className="shrink-0 text-muted-foreground">
                      {formatCurrency(d.value)} ({pct.toFixed(0)}%)
                    </span>
                  </li>
                );
              })
            )}
            {chartData.length > 6 && (
              <li className="text-xs text-muted-foreground">
                +{chartData.length - 6} more
              </li>
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}
