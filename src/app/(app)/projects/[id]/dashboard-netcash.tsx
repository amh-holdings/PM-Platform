import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  addMonthsIso,
  effectiveAmount,
  firstOfThisMonthIso,
  monthIsoFromDate,
  shiftByDaysToMonth,
  shortMonthLabel,
} from "@/lib/cashflow";

import { DashboardNetCashChart } from "./dashboard-netcash-chart";

type Props = {
  projectId: string;
};

export async function DashboardNetCash({ projectId }: Props) {
  const supabase = createClient();

  const [projectRes, billingRes, costRes, payRes] = await Promise.all([
    supabase
      .from("projects")
      .select("owner_payment_terms_days, retainage_pct_default")
      .eq("id", projectId)
      .maybeSingle(),
    supabase
      .from("billing_entries")
      .select(
        "period_month, cash_in_month, planned_amount, actual_amount, retainage_amount, billing_lines!inner(project_id)",
      )
      .eq("billing_lines.project_id", projectId),
    supabase
      .from("cost_forecasts")
      .select(
        "period_month, planned_amount, actual_amount, cost_codes!inner(project_id, subcontractor_id, procurement_order_id, subcontractors(payment_terms_days, retainage_pct))",
      )
      .eq("cost_codes.project_id", projectId),
    supabase
      .from("procurement_payments")
      .select(
        "expected_date, paid_at, amount, paid_amount, procurement_orders!inner(project_id)",
      )
      .eq("procurement_orders.project_id", projectId),
  ]);

  const err =
    billingRes.error?.message ??
    costRes.error?.message ??
    payRes.error?.message ??
    projectRes.error?.message;
  if (err) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Net cash position</h2>
        <p className="mt-2 text-xs text-destructive">Failed to load: {err}</p>
      </section>
    );
  }

  const thisMonthIso = firstOfThisMonthIso();
  const ownerTermsDays = Number(
    projectRes.data?.owner_payment_terms_days ?? 0,
  );
  const ownerRetainagePct = Number(
    projectRes.data?.retainage_pct_default ?? 0,
  ) / 100;

  // We compute TWO views of the project:
  //  1. ACCRUAL (revenue by work month, cost by work month) -> drives the
  //     chart bars + cumulative line. Answers "am I making money on this job?"
  //  2. CASH (cash in by cash_in_month, cash out by Net-X shifted month) ->
  //     drives the funding gap detector. Answers "will I run out of cash?"

  // === ACCRUAL: revenue by period_month, GROSS billed amount ===
  const revenueByMonth = new Map<string, number>();
  for (const e of billingRes.data ?? []) {
    const gross = effectiveAmount(e.actual_amount, e.planned_amount);
    revenueByMonth.set(
      e.period_month,
      (revenueByMonth.get(e.period_month) ?? 0) + gross,
    );
  }

  // === ACCRUAL: sub cost by work month (period_month), gross. Skip vendor-linked. ===
  const costByMonth = new Map<string, number>();
  for (const f of costRes.data ?? []) {
    const code = f.cost_codes as unknown as {
      subcontractor_id: string | null;
      procurement_order_id: string | null;
      subcontractors: { payment_terms_days: number | null; retainage_pct: number | null } | null;
    } | null;
    if (code?.procurement_order_id) continue;
    const gross = effectiveAmount(f.actual_amount, f.planned_amount);
    costByMonth.set(
      f.period_month,
      (costByMonth.get(f.period_month) ?? 0) + gross,
    );
  }

  // === ACCRUAL: vendor cost at milestone date (paid or expected). ===
  // Treat each milestone payment as the cost incurred that month - a
  // simplification (deposit is technically a prepaid asset, not COGS, until
  // delivery), but matches the granularity of the rest of the model.
  for (const p of payRes.data ?? []) {
    const date = p.paid_at ?? p.expected_date;
    if (!date) continue;
    const month = monthIsoFromDate(date);
    const amount = Number(p.paid_amount ?? p.amount ?? 0);
    if (!amount) continue;
    costByMonth.set(month, (costByMonth.get(month) ?? 0) + amount);
  }

  // === CASH BASIS (for funding gap detector) ===
  const cashInByMonth = new Map<string, number>();
  for (const e of billingRes.data ?? []) {
    const cashMonth =
      e.cash_in_month ??
      (ownerTermsDays > 0
        ? shiftByDaysToMonth(e.period_month, ownerTermsDays)
        : e.period_month);
    const gross = effectiveAmount(e.actual_amount, e.planned_amount);
    const net = gross - Number(e.retainage_amount ?? 0);
    cashInByMonth.set(cashMonth, (cashInByMonth.get(cashMonth) ?? 0) + net);
  }
  const cashOutByMonth = new Map<string, number>();
  for (const f of costRes.data ?? []) {
    const code = f.cost_codes as unknown as {
      subcontractor_id: string | null;
      procurement_order_id: string | null;
      subcontractors: { payment_terms_days: number | null; retainage_pct: number | null } | null;
    } | null;
    if (code?.procurement_order_id) continue;
    const subDays = Number(code?.subcontractors?.payment_terms_days ?? 0);
    const retPct = Number(code?.subcontractors?.retainage_pct ?? 0) / 100;
    const cashMonth =
      subDays > 0 ? shiftByDaysToMonth(f.period_month, subDays) : f.period_month;
    const gross = effectiveAmount(f.actual_amount, f.planned_amount);
    const net = gross * (1 - retPct);
    cashOutByMonth.set(cashMonth, (cashOutByMonth.get(cashMonth) ?? 0) + net);
  }
  for (const p of payRes.data ?? []) {
    const date = p.paid_at ?? p.expected_date;
    if (!date) continue;
    const cashMonth = monthIsoFromDate(date);
    const amount = Number(p.paid_amount ?? p.amount ?? 0);
    if (!amount) continue;
    cashOutByMonth.set(cashMonth, (cashOutByMonth.get(cashMonth) ?? 0) + amount);
  }

  // === Retainage release (CASH BASIS only - accrual already accounts for it) ===
  // Both sides release at substantial completion. Land 1 month after the last
  // regular cash event so cycle payments have cleared first.
  let totalOwnerRetainage = 0;
  for (const e of billingRes.data ?? []) {
    totalOwnerRetainage += Number(e.retainage_amount ?? 0);
  }
  let totalSubRetainage = 0;
  for (const f of costRes.data ?? []) {
    const code = f.cost_codes as unknown as {
      subcontractor_id: string | null;
      procurement_order_id: string | null;
      subcontractors: { payment_terms_days: number | null; retainage_pct: number | null } | null;
    } | null;
    if (code?.procurement_order_id) continue;
    const retPct = Number(code?.subcontractors?.retainage_pct ?? 0) / 100;
    const gross = effectiveAmount(f.actual_amount, f.planned_amount);
    totalSubRetainage += gross * retPct;
  }
  if (totalOwnerRetainage > 0 || totalSubRetainage > 0) {
    const allCashMonthsForRelease = new Set<string>();
    cashInByMonth.forEach((_, k) => allCashMonthsForRelease.add(k));
    cashOutByMonth.forEach((_, k) => allCashMonthsForRelease.add(k));
    const lastCashMonth = Array.from(allCashMonthsForRelease).sort().pop();
    if (lastCashMonth) {
      const releaseMonth = addMonthsIso(lastCashMonth, 1);
      if (totalOwnerRetainage > 0) {
        cashInByMonth.set(
          releaseMonth,
          (cashInByMonth.get(releaseMonth) ?? 0) + totalOwnerRetainage,
        );
      }
      if (totalSubRetainage > 0) {
        cashOutByMonth.set(
          releaseMonth,
          (cashOutByMonth.get(releaseMonth) ?? 0) + totalSubRetainage,
        );
      }
    }
  }

  // === Build chart data on ACCRUAL ===
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
