import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  addMonthsIso,
  firstOfThisMonthIso,
  monthIsoFromDate,
  monthsBetween,
  shiftByDaysToMonth,
  shortMonthLabel,
} from "@/lib/cashflow";

import { DashboardCashOutChart } from "./dashboard-cashout-chart";

type Props = {
  projectId: string;
};

type BucketRow = { actual: number; planned: number };

export async function DashboardCashOut({ projectId }: Props) {
  const supabase = createClient();

  const [forecastRes, payRes] = await Promise.all([
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

  const err = forecastRes.error?.message ?? payRes.error?.message;
  if (err) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Cash Out timeline</h2>
        <p className="mt-2 text-xs text-destructive">Failed to load: {err}</p>
      </section>
    );
  }

  const thisMonthIso = firstOfThisMonthIso();
  const byMonth = new Map<string, BucketRow>();
  const bump = (iso: string, side: "actual" | "planned", v: number) => {
    if (!byMonth.has(iso)) byMonth.set(iso, { actual: 0, planned: 0 });
    byMonth.get(iso)![side] += v;
  };

  // Sub side: shift by Net X, apply retainage, skip vendor-linked codes.
  for (const f of forecastRes.data ?? []) {
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
    const actual = Number(f.actual_amount ?? 0) * (1 - retPct);
    const planned = Number(f.planned_amount ?? 0) * (1 - retPct);
    // Use effective rule: if both set, actual wins (so headers don't double).
    if (actual > 0) bump(cashMonth, "actual", actual);
    else if (planned > 0) bump(cashMonth, "planned", planned);
  }

  // Vendor side: payments scheduled by milestone expected_date.
  for (const p of payRes.data ?? []) {
    const isPaid = p.paid_at != null;
    const date = isPaid ? p.paid_at : p.expected_date;
    if (!date) continue;
    const cashMonth = monthIsoFromDate(date);
    const amount = Number(p.paid_amount ?? p.amount ?? 0);
    if (!amount) continue;
    bump(cashMonth, isPaid ? "actual" : "planned", amount);
  }

  // Fill in every month between earliest and latest so idle months still
  // appear as gaps in the timeline instead of compressing out.
  const sortedMonths = Array.from(byMonth.keys()).sort();
  const dataMonths =
    sortedMonths.length > 0
      ? monthsBetween(sortedMonths[0], sortedMonths[sortedMonths.length - 1])
      : [];
  const chartData = dataMonths.map((iso) => {
    const v = byMonth.get(iso) ?? { actual: 0, planned: 0 };
    return {
      month: iso,
      label: shortMonthLabel(iso),
      actual: v.actual,
      planned: v.planned,
      isFuture: iso > thisMonthIso,
    };
  });

  const thisMonth = byMonth.get(thisMonthIso);
  const nextMonth = byMonth.get(addMonthsIso(thisMonthIso, 1));
  const monthAfter = byMonth.get(addMonthsIso(thisMonthIso, 2));

  const totalActual = chartData.reduce((s, d) => s + d.actual, 0);
  const totalPlanned = chartData.reduce((s, d) => s + d.planned, 0);

  function MonthCard({
    label,
    iso,
    data,
    tone,
  }: {
    label: string;
    iso: string;
    data: BucketRow | undefined;
    tone: "current" | "future";
  }) {
    const spent = data?.actual ?? 0;
    const planned = data?.planned ?? 0;
    const isEmpty = spent === 0 && planned === 0;
    return (
      <div
        className={cn(
          "rounded-md border p-3",
          tone === "current"
            ? "border-destructive/40 bg-destructive/5"
            : "border-border bg-muted/30",
        )}
      >
        <div className="flex items-baseline justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {shortMonthLabel(iso)}
          </div>
        </div>
        {isEmpty ? (
          <div className="mt-1 text-sm text-muted-foreground">Nothing yet</div>
        ) : (
          <>
            {spent > 0 && (
              <div className="mt-1">
                <div className="text-xs text-muted-foreground">Spent</div>
                <div className="text-base font-semibold text-destructive">
                  {formatCurrency(spent)}
                </div>
              </div>
            )}
            {planned > 0 && (
              <div className="mt-1">
                <div className="text-xs text-muted-foreground">Projected</div>
                <div className="text-base font-semibold">
                  {formatCurrency(planned)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Cash Out timeline</h2>
          <p className="text-xs text-muted-foreground">
            Per-month spend (past) and projected spend (future) on AHC&apos;s side,
            net of sub retainage, including vendor payment milestones
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="text-destructive font-medium">
            {formatCurrency(totalActual)}
          </span>{" "}
          spent +{" "}
          <span className="font-medium">{formatCurrency(totalPlanned)}</span>{" "}
          projected
        </div>
      </div>

      <DashboardCashOutChart data={chartData} />

      <div className="grid gap-2 sm:grid-cols-3">
        <MonthCard
          label="This month"
          iso={thisMonthIso}
          data={thisMonth}
          tone="current"
        />
        <MonthCard
          label="Next month"
          iso={addMonthsIso(thisMonthIso, 1)}
          data={nextMonth}
          tone="future"
        />
        <MonthCard
          label="In 2 months"
          iso={addMonthsIso(thisMonthIso, 2)}
          data={monthAfter}
          tone="future"
        />
      </div>
    </section>
  );
}
