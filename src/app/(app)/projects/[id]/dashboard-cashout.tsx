import { createClient } from "@/lib/supabase/server";
import { buildProjection } from "@/lib/projection";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  addMonthsIso,
  firstOfThisMonthIso,
  monthsBetween,
  shortMonthLabel,
} from "@/lib/cashflow";

import { DashboardCashOutChart } from "./dashboard-cashout-chart";

type Props = {
  projectId: string;
};

type BucketRow = { actual: number; planned: number };

export async function DashboardCashOut({ projectId }: Props) {
  const supabase = createClient();

  // Same source as the projection table and the billing timeline - see the note
  // in dashboard-billing.tsx. This panel read cost_forecasts and
  // procurement_payments directly, so it reported "No cash-out data yet" while
  // the table above it showed $18,216 leaving in Nov and $42,264 in Jul 27.
  let projection;
  try {
    projection = await buildProjection(supabase, projectId, { monthsAhead: 18 });
  } catch (e) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Cash Out timeline</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {e instanceof Error ? e.message : "unknown error"}
        </p>
      </section>
    );
  }

  const thisMonthIso = firstOfThisMonthIso();
  const byMonth = new Map<string, BucketRow>();
  for (const r of projection.rows) {
    if (r.cashOutActual === 0 && r.cashOutForecast === 0) continue;
    byMonth.set(r.month, { actual: r.cashOutActual, planned: r.cashOutForecast });
  }

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
