import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { buildProjection } from "@/lib/projection";

type Props = {
  projectId: string;
};

const CONFIDENCE_STYLES: Record<string, { dot: string; label: string }> = {
  high: { dot: "bg-emerald-600", label: "Actual" },
  medium: { dot: "bg-blue-500", label: "Forecast" },
  low: { dot: "bg-amber-500", label: "Estimated" },
  none: { dot: "bg-muted-foreground", label: "No data" },
};

export async function DashboardProjection({ projectId }: Props) {
  const supabase = createClient();
  const result = await buildProjection(supabase, projectId);
  const { rows, warnings, totals } = result;

  if (rows.length === 0) {
    return null;
  }

  // Trim view to a useful window: start at the earliest month with any activity,
  // end at the last month with activity (capped at 12 months from today).
  const firstActiveIdx = rows.findIndex(
    (r) =>
      r.revenueRecognized > 0 ||
      r.totalCost > 0 ||
      r.cashIn > 0 ||
      r.totalCashOut > 0,
  );
  const lastActiveIdx = (() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.revenueRecognized > 0 || r.totalCost > 0 || r.cashIn > 0 || r.totalCashOut > 0) {
        return i;
      }
    }
    return rows.length - 1;
  })();
  const startIdx = firstActiveIdx === -1 ? 0 : Math.max(0, firstActiveIdx);
  const endIdx = lastActiveIdx === -1 ? rows.length - 1 : lastActiveIdx;
  const visible = rows.slice(startIdx, endIdx + 1);

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Cash flow projection</h2>
          <p className="text-xs text-muted-foreground">
            Month-by-month revenue + cash IN against cost + cash OUT,
            confidence-tagged. Reads billing entries, sub forecasts,
            vendor milestones + smart schedule signals.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-right text-xs">
          <div>
            <div className="text-muted-foreground">Revenue (total)</div>
            <div className="font-semibold text-emerald-600">
              {formatCurrency(totals.revenue)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Cost (total)</div>
            <div className="font-semibold text-destructive">
              {formatCurrency(totals.cost)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Margin (total)</div>
            <div
              className={cn(
                "font-semibold",
                totals.margin >= 0 ? "text-emerald-600" : "text-destructive",
              )}
            >
              {formatCurrency(totals.margin)}
            </div>
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <details className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <summary className="cursor-pointer font-medium text-amber-800">
            {warnings.length} data quality {warnings.length === 1 ? "warning" : "warnings"} affecting projection
          </summary>
          <ul className="mt-2 space-y-1">
            {warnings.slice(0, 15).map((w, i) => (
              <li key={i} className="text-amber-900">
                <span className="font-mono text-[10px] text-muted-foreground">
                  [{w.kind}]
                </span>{" "}
                {w.message}
              </li>
            ))}
            {warnings.length > 15 && (
              <li className="text-muted-foreground italic">
                ... and {warnings.length - 15} more
              </li>
            )}
          </ul>
        </details>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="py-1.5 pr-2 text-left font-medium">Month</th>
              <th className="py-1.5 pr-2 text-left font-medium">Conf</th>
              <th className="py-1.5 pr-2 text-right font-medium">Revenue</th>
              <th className="py-1.5 pr-2 text-right font-medium">Cost</th>
              <th className="py-1.5 pr-2 text-right font-medium">Margin</th>
              <th className="py-1.5 pr-2 text-right font-medium">Cash in</th>
              <th className="py-1.5 pr-2 text-right font-medium">Cash out</th>
              <th className="py-1.5 pr-2 text-right font-medium">Net cash</th>
              <th className="py-1.5 text-right font-medium">Cum cash</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const conf = CONFIDENCE_STYLES[r.confidence];
              return (
                <tr
                  key={r.month}
                  className={cn(
                    "border-b last:border-0",
                    r.isCurrent && "bg-emerald-500/5 font-medium",
                    r.cumulativeCash < 0 && "bg-destructive/5",
                  )}
                >
                  <td className="py-1.5 pr-2">
                    {r.label}
                    {r.isCurrent && (
                      <span className="ml-1 text-[10px] text-emerald-700">(now)</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    <span
                      className={cn("inline-block h-2 w-2 rounded-full", conf.dot)}
                      title={conf.label}
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    {r.revenueRecognized > 0
                      ? formatCurrency(r.revenueRecognized)
                      : "-"}
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    {r.totalCost > 0 ? formatCurrency(r.totalCost) : "-"}
                  </td>
                  <td
                    className={cn(
                      "py-1.5 pr-2 text-right",
                      r.netMargin > 0 && "text-emerald-700",
                      r.netMargin < 0 && "text-destructive",
                    )}
                  >
                    {r.netMargin !== 0 ? formatCurrency(r.netMargin) : "-"}
                  </td>
                  <td className="py-1.5 pr-2 text-right text-emerald-700">
                    {r.cashIn > 0 ? formatCurrency(r.cashIn) : "-"}
                  </td>
                  <td className="py-1.5 pr-2 text-right text-destructive">
                    {r.totalCashOut > 0 ? formatCurrency(r.totalCashOut) : "-"}
                  </td>
                  <td
                    className={cn(
                      "py-1.5 pr-2 text-right font-medium",
                      r.netCash > 0 && "text-emerald-700",
                      r.netCash < 0 && "text-destructive",
                    )}
                  >
                    {r.netCash !== 0 ? formatCurrency(r.netCash) : "-"}
                  </td>
                  <td
                    className={cn(
                      "py-1.5 text-right font-semibold",
                      r.cumulativeCash < 0 ? "text-destructive" : "text-foreground",
                    )}
                  >
                    {formatCurrency(r.cumulativeCash)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-[10px] text-muted-foreground">
        <span>Confidence:</span>
        {Object.entries(CONFIDENCE_STYLES).map(([key, c]) => (
          <span key={key} className="inline-flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-full", c.dot)} /> {c.label}
          </span>
        ))}
        <span className="ml-auto">
          Revenue/cost on accrual basis (work month). Cash in/out on cash basis
          (after Net X + retainage).
        </span>
      </div>
    </section>
  );
}
