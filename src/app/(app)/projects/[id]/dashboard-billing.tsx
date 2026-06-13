import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  addMonthsIso,
  firstOfThisMonthIso,
  monthsBetween,
  shortMonthLabel,
} from "@/lib/cashflow";

import { BillThisPeriodPanel } from "./billing/bill-this-period-panel";
import { DashboardBillingChart } from "./dashboard-billing-chart";

type Props = {
  projectId: string;
};

const shortLabel = shortMonthLabel;

export async function DashboardBilling({ projectId }: Props) {
  const supabase = createClient();

  const { data: entries, error } = await supabase
    .from("billing_entries")
    .select(
      "period_month, planned_amount, actual_amount, retainage_amount, afp_number, status, billing_lines!inner(project_id, description, item_number)",
    )
    .eq("billing_lines.project_id", projectId)
    .order("period_month");

  if (error) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Billing timeline</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {error.message}
        </p>
      </section>
    );
  }

  const thisMonthIso = firstOfThisMonthIso();
  type Bucket = {
    actualCash: number;
    actualRetainage: number;
    plannedCash: number;
    plannedRetainage: number;
  };
  const byMonth = new Map<string, Bucket>();
  // Prefer actual when present so a paid entry with a leftover planned
  // forecast doesn't get counted twice. Split each entry into cash + retainage
  // so the chart can stack "held back" on top of "going to the bank."
  for (const e of entries ?? []) {
    if (!byMonth.has(e.period_month))
      byMonth.set(e.period_month, {
        actualCash: 0,
        actualRetainage: 0,
        plannedCash: 0,
        plannedRetainage: 0,
      });
    const m = byMonth.get(e.period_month)!;
    const actual = Number(e.actual_amount ?? 0);
    const planned = Number(e.planned_amount ?? 0);
    const retainage = Number(e.retainage_amount ?? 0);
    if (actual > 0) {
      m.actualRetainage += retainage;
      m.actualCash += Math.max(0, actual - retainage);
    } else if (planned > 0) {
      m.plannedRetainage += retainage;
      m.plannedCash += Math.max(0, planned - retainage);
    }
  }

  // Fill in every month between earliest and latest so empty months still
  // appear as gaps in the timeline instead of being compressed out.
  const sortedMonths = Array.from(byMonth.keys()).sort();
  const dataMonths =
    sortedMonths.length > 0
      ? monthsBetween(sortedMonths[0], sortedMonths[sortedMonths.length - 1])
      : [];
  const zeroBucket: Bucket = {
    actualCash: 0,
    actualRetainage: 0,
    plannedCash: 0,
    plannedRetainage: 0,
  };
  const chartData = dataMonths.map((iso) => {
    const v = byMonth.get(iso) ?? zeroBucket;
    return {
      month: iso,
      label: shortLabel(iso),
      ...v,
      isFuture: iso > thisMonthIso,
    };
  });

  const thisMonth = byMonth.get(thisMonthIso);
  const nextMonth = byMonth.get(addMonthsIso(thisMonthIso, 1));
  const monthAfter = byMonth.get(addMonthsIso(thisMonthIso, 2));


  // Header totals: gross billed = cash + retainage. Show retainage held separately.
  const totalActualCash = chartData.reduce((s, d) => s + d.actualCash, 0);
  const totalActualRetainage = chartData.reduce((s, d) => s + d.actualRetainage, 0);
  const totalPlannedCash = chartData.reduce((s, d) => s + d.plannedCash, 0);
  const totalPlannedRetainage = chartData.reduce((s, d) => s + d.plannedRetainage, 0);
  const totalActual = totalActualCash + totalActualRetainage;
  const totalPlanned = totalPlannedCash + totalPlannedRetainage;
  const totalRetainageHeld = totalActualRetainage + totalPlannedRetainage;

  function MonthCard({
    label,
    iso,
    data,
    tone,
  }: {
    label: string;
    iso: string;
    data: Bucket | undefined;
    tone: "current" | "future";
  }) {
    const billedGross =
      (data?.actualCash ?? 0) + (data?.actualRetainage ?? 0);
    const plannedGross =
      (data?.plannedCash ?? 0) + (data?.plannedRetainage ?? 0);
    const billedRetainage = data?.actualRetainage ?? 0;
    const plannedRetainage = data?.plannedRetainage ?? 0;
    const isEmpty = billedGross === 0 && plannedGross === 0;
    return (
      <div
        className={cn(
          "rounded-md border p-3",
          tone === "current"
            ? "border-emerald-500/40 bg-emerald-500/5"
            : "border-border bg-muted/30",
        )}
      >
        <div className="flex items-baseline justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {shortLabel(iso)}
          </div>
        </div>
        {isEmpty ? (
          <div className="mt-1 text-sm text-muted-foreground">Nothing yet</div>
        ) : (
          <>
            {billedGross > 0 && (
              <div className="mt-1">
                <div className="text-xs text-muted-foreground">Billed</div>
                <div className="text-base font-semibold text-emerald-600">
                  {formatCurrency(billedGross)}
                </div>
                {billedRetainage > 0 && (
                  <div className="text-[10px] text-muted-foreground">
                    less {formatCurrency(billedRetainage)} retainage
                  </div>
                )}
              </div>
            )}
            {plannedGross > 0 && (
              <div className="mt-1">
                <div className="text-xs text-muted-foreground">Planned</div>
                <div className="text-base font-semibold">
                  {formatCurrency(plannedGross)}
                </div>
                {plannedRetainage > 0 && (
                  <div className="text-[10px] text-muted-foreground">
                    less {formatCurrency(plannedRetainage)} retainage
                  </div>
                )}
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
          <h2 className="text-sm font-semibold">Billing timeline</h2>
          <p className="text-xs text-muted-foreground">
            Per-month billed (past) and planned (future). Lighter shade on each
            bar shows the portion held by the owner as retainage.
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>
            <span className="text-emerald-600 font-medium">
              {formatCurrency(totalActual)}
            </span>{" "}
            billed +{" "}
            <span className="font-medium">{formatCurrency(totalPlanned)}</span>{" "}
            planned
          </div>
          {totalRetainageHeld > 0 && (
            <div className="text-[10px]">
              of which {formatCurrency(totalRetainageHeld)} held in retainage
            </div>
          )}
        </div>
      </div>

      <BillThisPeriodPanel projectId={projectId} variant="widget" />

      <DashboardBillingChart data={chartData} />

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
