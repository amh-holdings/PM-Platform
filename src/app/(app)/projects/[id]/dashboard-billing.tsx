import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

import { DashboardBillingChart } from "./dashboard-billing-chart";

type Props = {
  projectId: string;
};

function firstOfThisMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function addMonthsIso(iso: string, n: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function shortLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTH_LABELS[m - 1]} ${String(y).slice(2)}`;
}

export async function DashboardBilling({ projectId }: Props) {
  const supabase = createClient();

  const { data: entries, error } = await supabase
    .from("billing_entries")
    .select(
      "period_month, planned_amount, actual_amount, billing_lines!inner(project_id)",
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
  const byMonth = new Map<string, { actual: number; planned: number }>();
  // Prefer actual when present so a paid entry that still has a planned
  // forecast doesn't get counted twice in the totals header.
  for (const e of entries ?? []) {
    if (!byMonth.has(e.period_month))
      byMonth.set(e.period_month, { actual: 0, planned: 0 });
    const m = byMonth.get(e.period_month)!;
    const actual = Number(e.actual_amount ?? 0);
    const planned = Number(e.planned_amount ?? 0);
    if (actual > 0) m.actual += actual;
    else if (planned > 0) m.planned += planned;
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
    const billed = data?.actual ?? 0;
    const planned = data?.planned ?? 0;
    const isEmpty = billed === 0 && planned === 0;
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
            {billed > 0 && (
              <div className="mt-1">
                <div className="text-xs text-muted-foreground">Billed</div>
                <div className="text-base font-semibold text-emerald-600">
                  {formatCurrency(billed)}
                </div>
              </div>
            )}
            {planned > 0 && (
              <div className="mt-1">
                <div className="text-xs text-muted-foreground">Planned</div>
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
          <h2 className="text-sm font-semibold">Billing timeline</h2>
          <p className="text-xs text-muted-foreground">
            Per-month billed (past) and planned (future) against the owner
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="text-emerald-600 font-medium">
            {formatCurrency(totalActual)}
          </span>{" "}
          billed +{" "}
          <span className="font-medium">{formatCurrency(totalPlanned)}</span>{" "}
          planned
        </div>
      </div>

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
