import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

import { DashboardCashOutChart } from "./dashboard-cashout-chart";

type Props = {
  projectId: string;
};

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTH_LABELS[m - 1]} ${String(y).slice(2)}`;
}

function firstOfThisMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function addMonthsIso(iso: string, n: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function DashboardCashOut({ projectId }: Props) {
  const supabase = createClient();

  const { data: forecasts, error } = await supabase
    .from("cost_forecasts")
    .select(
      "period_month, planned_amount, actual_amount, cost_codes!inner(project_id)",
    )
    .eq("cost_codes.project_id", projectId)
    .order("period_month");

  if (error) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Cash Out timeline</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {error.message}
        </p>
      </section>
    );
  }

  const thisMonthIso = firstOfThisMonthIso();
  const byMonth = new Map<string, { actual: number; planned: number }>();
  for (const f of forecasts ?? []) {
    if (!byMonth.has(f.period_month))
      byMonth.set(f.period_month, { actual: 0, planned: 0 });
    const m = byMonth.get(f.period_month)!;
    m.actual += Number(f.actual_amount ?? 0);
    m.planned += Number(f.planned_amount ?? 0);
  }

  const sortedMonths = Array.from(byMonth.keys()).sort();
  const chartData = sortedMonths.map((iso) => {
    const v = byMonth.get(iso)!;
    return {
      month: iso,
      label: shortLabel(iso),
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
    data: { actual: number; planned: number } | undefined;
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
            {shortLabel(iso)}
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
            Per-month spend (past) and projected spend (future) on AHC&apos;s side
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
