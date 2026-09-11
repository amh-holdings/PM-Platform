import { createClient } from "@/lib/supabase/server";
import { buildProjection } from "@/lib/projection";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  firstOfThisMonthIso,
  shortMonthLabel,
} from "@/lib/cashflow";

import { DashboardNetCashChart } from "./dashboard-netcash-chart";

type Props = {
  projectId: string;
};

export async function DashboardNetCash({ projectId }: Props) {
  const supabase = createClient();

  // Same rows as the projection table, the billing timeline and the cash-out
  // timeline - see the note in dashboard-billing.tsx. This panel built its own
  // maps from billing_entries and cost_forecasts, so on a project that had
  // never billed it drew "No cash flow yet" directly beneath a table showing
  // $290,388 of revenue and a $194,288 margin.
  const projectRes = await supabase
    .from("projects")
    .select("owner_payment_terms_days, retainage_pct_default")
    .eq("id", projectId)
    .maybeSingle();

  let projection;
  try {
    projection = await buildProjection(supabase, projectId, { monthsAhead: 18 });
  } catch (e) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Net cash position</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {e instanceof Error ? e.message : "unknown error"}
        </p>
      </section>
    );
  }

  const thisMonthIso = firstOfThisMonthIso();
  const ownerTermsDays = Number(projectRes.data?.owner_payment_terms_days ?? 0);
  const ownerRetainagePct =
    Number(projectRes.data?.retainage_pct_default ?? 0) / 100;

  // Months with nothing in them are left out so the chart does not draw a flat
  // run of empty bars either side of the work.
  const revenueByMonth = new Map<string, number>();
  const costByMonth = new Map<string, number>();
  const cashInByMonth = new Map<string, number>();
  const cashOutByMonth = new Map<string, number>();
  for (const r of projection.rows) {
    if (r.revenueRecognized !== 0) revenueByMonth.set(r.month, r.revenueRecognized);
    if (r.totalCost !== 0) costByMonth.set(r.month, r.totalCost);
    if (r.cashIn !== 0) cashInByMonth.set(r.month, r.cashIn);
    if (r.totalCashOut !== 0) cashOutByMonth.set(r.month, r.totalCashOut);
  }


  const allMonths = new Set<string>();
  revenueByMonth.forEach((_, k) => allMonths.add(k));
  costByMonth.forEach((_, k) => allMonths.add(k));
  const sorted = Array.from(allMonths).sort();

  let cumulative = 0;
  const chartData = sorted.map((iso) => {
    const inV = revenueByMonth.get(iso) ?? 0;
    const outV = costByMonth.get(iso) ?? 0;
    const net = inV - outV;
    cumulative += net;
    return {
      month: iso,
      label: shortMonthLabel(iso),
      net,
      cumulative,
      isFuture: iso > thisMonthIso,
    };
  });

  // === Cash-basis cumulative for the funding gap detector ===
  const allCashMonths = new Set<string>();
  cashInByMonth.forEach((_, k) => allCashMonths.add(k));
  cashOutByMonth.forEach((_, k) => allCashMonths.add(k));
  const sortedCash = Array.from(allCashMonths).sort();
  let cumCash = 0;
  const cashData = sortedCash.map((iso) => {
    const inV = cashInByMonth.get(iso) ?? 0;
    const outV = cashOutByMonth.get(iso) ?? 0;
    cumCash += inV - outV;
    return { month: iso, label: shortMonthLabel(iso), cumCash };
  });

  // FUNDING GAP DETECTION on CASH BASIS - this is the right basis for "will
  // we run out of money," even though the chart itself shows accrual margin.
  const ownerCycle = Math.max(1, Math.ceil(ownerTermsDays / 30));
  const gaps = cashData
    .filter((d) => d.cumCash < 0)
    .map((d) => {
      const shortBy = Math.abs(d.cumCash);
      const billNeeded =
        ownerRetainagePct > 0 && ownerRetainagePct < 1
          ? shortBy / (1 - ownerRetainagePct)
          : shortBy;
      const billMonthIdx = sortedCash.indexOf(d.month) - ownerCycle;
      const billMonth =
        billMonthIdx >= 0
          ? shortMonthLabel(sortedCash[billMonthIdx])
          : "before forecast horizon";
      return {
        month: d.label,
        cumulative: d.cumCash,
        shortBy,
        billNeeded,
        billMonth,
      };
    });

  // Margin totals (ACCRUAL).
  let totalRevenue = 0, totalCost = 0;
  revenueByMonth.forEach((v) => { totalRevenue += v; });
  costByMonth.forEach((v) => { totalCost += v; });
  const totalMargin = totalRevenue - totalCost;

  // Margin to date (through current month, accrual).
  let pastRevenue = 0, pastCost = 0;
  revenueByMonth.forEach((v, iso) => { if (iso <= thisMonthIso) pastRevenue += v; });
  costByMonth.forEach((v, iso) => { if (iso <= thisMonthIso) pastCost += v; });
  const marginToDate = pastRevenue - pastCost;

  // Current cash position (through current month, cash basis).
  let cashToDate = 0;
  cashData.forEach((d) => { if (d.month <= thisMonthIso) cashToDate = d.cumCash; });

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Project margin</h2>
          <p className="text-xs text-muted-foreground">
            Profit by work month (revenue billed - cost incurred), plus running
            cumulative margin
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div className="text-right">
            <div className="text-muted-foreground">Revenue (total)</div>
            <div className="font-semibold text-emerald-600">
              {formatCurrency(totalRevenue)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-muted-foreground">Cost (total)</div>
            <div className="font-semibold text-destructive">
              {formatCurrency(totalCost)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-muted-foreground">Margin (total)</div>
            <div
              className={cn(
                "font-semibold",
                totalMargin >= 0 ? "text-emerald-600" : "text-destructive",
              )}
            >
              {formatCurrency(totalMargin)}
            </div>
          </div>
        </div>
      </div>

      {gaps.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <div className="flex items-baseline justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-destructive">
              Funding gap detected
            </div>
            <div className="text-[10px] text-muted-foreground">
              {gaps.length} month{gaps.length === 1 ? "" : "s"} project negative cash
            </div>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Cash on hand goes negative below (separate from the margin chart
            above) - AHC would be financing the project. Bill the owner earlier
            or larger to close the gap.
          </p>
          <table className="mt-2 w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-destructive/20">
                <th className="py-1 text-left font-medium">Gap month</th>
                <th className="py-1 text-right font-medium">Short by</th>
                <th className="py-1 text-right font-medium">Recommended bill</th>
                <th className="py-1 text-right font-medium">Bill by</th>
              </tr>
            </thead>
            <tbody>
              {gaps.map((g) => (
                <tr key={g.month} className="border-b border-destructive/10 last:border-0">
                  <td className="py-1 font-medium">{g.month}</td>
                  <td className="py-1 text-right text-destructive">
                    {formatCurrency(g.shortBy)}
                  </td>
                  <td className="py-1 text-right font-semibold">
                    {formatCurrency(g.billNeeded)}
                  </td>
                  <td className="py-1 text-right text-muted-foreground">
                    {g.billMonth}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DashboardNetCashChart data={chartData} />

      <div className="grid gap-2 sm:grid-cols-3">
        <div
          className={cn(
            "rounded-md border p-3",
            marginToDate >= 0
              ? "border-emerald-500/40 bg-emerald-500/5"
              : "border-destructive/40 bg-destructive/5",
          )}
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Margin to date
          </div>
          <div
            className={cn(
              "mt-1 text-base font-semibold",
              marginToDate >= 0 ? "text-emerald-600" : "text-destructive",
            )}
          >
            {formatCurrency(marginToDate)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Earned through {shortMonthLabel(thisMonthIso)}
          </div>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Final margin
          </div>
          <div
            className={cn(
              "mt-1 text-base font-semibold",
              chartData[chartData.length - 1]?.cumulative >= 0
                ? "text-emerald-600"
                : "text-destructive",
            )}
          >
            {formatCurrency(chartData[chartData.length - 1]?.cumulative ?? 0)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            At end of forecast horizon
          </div>
        </div>
        <div
          className={cn(
            "rounded-md border p-3",
            cashToDate >= 0
              ? "border-border bg-muted/30"
              : "border-destructive/40 bg-destructive/5",
          )}
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Cash on hand
          </div>
          <div
            className={cn(
              "mt-1 text-base font-semibold",
              cashToDate >= 0 ? "text-foreground" : "text-destructive",
            )}
          >
            {formatCurrency(cashToDate)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Bank position through {shortMonthLabel(thisMonthIso)}
          </div>
        </div>
      </div>
    </section>
  );
}
