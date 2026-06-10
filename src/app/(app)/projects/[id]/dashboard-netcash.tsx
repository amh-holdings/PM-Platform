import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
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
      .select("owner_payment_terms_days")
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

  // CASH IN: by cash_in_month (set on entry, or computed from owner Net X).
  // Subtract retainage_amount (held back by owner).
  const inByMonth = new Map<string, number>();
  for (const e of billingRes.data ?? []) {
    const cashMonth =
      e.cash_in_month ??
      (ownerTermsDays > 0
        ? shiftByDaysToMonth(e.period_month, ownerTermsDays)
        : e.period_month);
    const gross = effectiveAmount(e.actual_amount, e.planned_amount);
    const net = gross - Number(e.retainage_amount ?? 0);
    inByMonth.set(cashMonth, (inByMonth.get(cashMonth) ?? 0) + net);
  }

  // CASH OUT (sub side): shift period_month by sub Net X, apply sub retainage.
  // Skip vendor-linked cost codes - those flow through procurement_payments.
  const outByMonth = new Map<string, number>();
  for (const f of costRes.data ?? []) {
    const code = f.cost_codes as unknown as {
      subcontractor_id: string | null;
      procurement_order_id: string | null;
      subcontractors: { payment_terms_days: number | null; retainage_pct: number | null } | null;
    } | null;
    if (code?.procurement_order_id) continue; // vendor side counted via payments
    const subDays = Number(code?.subcontractors?.payment_terms_days ?? 0);
    const retPct = Number(code?.subcontractors?.retainage_pct ?? 0) / 100;
    const cashMonth =
      subDays > 0 ? shiftByDaysToMonth(f.period_month, subDays) : f.period_month;
    const gross = effectiveAmount(f.actual_amount, f.planned_amount);
    const net = gross * (1 - retPct);
    outByMonth.set(cashMonth, (outByMonth.get(cashMonth) ?? 0) + net);
  }

  // CASH OUT (vendor side): each procurement_payment milestone.
  for (const p of payRes.data ?? []) {
    const date = p.paid_at ?? p.expected_date;
    if (!date) continue;
    const cashMonth = monthIsoFromDate(date);
    const amount = Number(p.paid_amount ?? p.amount ?? 0);
    if (!amount) continue;
    outByMonth.set(cashMonth, (outByMonth.get(cashMonth) ?? 0) + amount);
  }

  const allMonths = new Set<string>();
  inByMonth.forEach((_, k) => allMonths.add(k));
  outByMonth.forEach((_, k) => allMonths.add(k));
  const sorted = Array.from(allMonths).sort();

  let cumulative = 0;
  const chartData = sorted.map((iso) => {
    const inV = inByMonth.get(iso) ?? 0;
    const outV = outByMonth.get(iso) ?? 0;
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

  let totalIn = 0, totalOut = 0;
  inByMonth.forEach((v) => { totalIn += v; });
  outByMonth.forEach((v) => { totalOut += v; });
  const totalNet = totalIn - totalOut;

  let pastIn = 0, pastOut = 0;
  inByMonth.forEach((v, iso) => { if (iso <= thisMonthIso) pastIn += v; });
  outByMonth.forEach((v, iso) => { if (iso <= thisMonthIso) pastOut += v; });
  const cashToDate = pastIn - pastOut;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Net cash position</h2>
          <p className="text-xs text-muted-foreground">
            Cash in minus cash out, per month, plus running cumulative
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div className="text-right">
            <div className="text-muted-foreground">Cash in (total)</div>
            <div className="font-semibold text-emerald-600">
              {formatCurrency(totalIn)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-muted-foreground">Cash out (total)</div>
            <div className="font-semibold text-destructive">
              {formatCurrency(totalOut)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-muted-foreground">Net (total)</div>
            <div
              className={cn(
                "font-semibold",
                totalNet >= 0 ? "text-emerald-600" : "text-destructive",
              )}
            >
              {formatCurrency(totalNet)}
            </div>
          </div>
        </div>
      </div>

      <DashboardNetCashChart data={chartData} />

      <div className="grid gap-2 sm:grid-cols-3">
        <div
          className={cn(
            "rounded-md border p-3",
            cashToDate >= 0
              ? "border-emerald-500/40 bg-emerald-500/5"
              : "border-destructive/40 bg-destructive/5",
          )}
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Cash to date
          </div>
          <div
            className={cn(
              "mt-1 text-base font-semibold",
              cashToDate >= 0 ? "text-emerald-600" : "text-destructive",
            )}
          >
            {formatCurrency(cashToDate)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Through {shortMonthLabel(thisMonthIso)}
          </div>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Final cumulative
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
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Lowest cash point
          </div>
          {(() => {
            const min = chartData.reduce(
              (acc, d) => (d.cumulative < acc.cumulative ? d : acc),
              chartData[0] ?? { cumulative: 0, label: "-", month: "" },
            );
            return (
              <>
                <div
                  className={cn(
                    "mt-1 text-base font-semibold",
                    min.cumulative >= 0 ? "text-emerald-600" : "text-destructive",
                  )}
                >
                  {formatCurrency(min.cumulative)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {min.label !== "-" ? `In ${min.label}` : "No data"}
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </section>
  );
}
