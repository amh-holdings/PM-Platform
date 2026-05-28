import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

import { DashboardNetCashChart } from "./dashboard-netcash-chart";

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

export async function DashboardNetCash({ projectId }: Props) {
  const supabase = createClient();

  const [billingRes, costRes] = await Promise.all([
    supabase
      .from("billing_entries")
      .select(
        "period_month, planned_amount, actual_amount, billing_lines!inner(project_id)",
      )
      .eq("billing_lines.project_id", projectId),
    supabase
      .from("cost_forecasts")
      .select(
        "period_month, planned_amount, actual_amount, cost_codes!inner(project_id)",
      )
      .eq("cost_codes.project_id", projectId),
  ]);

  if (billingRes.error || costRes.error) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Net cash position</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {billingRes.error?.message ?? costRes.error?.message}
        </p>
      </section>
    );
  }

  const thisMonthIso = firstOfThisMonthIso();

  // Cash in per month = billed actual (past) + billed planned (future)
  // Cash out per month = spent actual (past) + spent planned (future)
  // Net = Cash in - Cash out
  const inByMonth = new Map<string, number>();
  for (const e of billingRes.data ?? []) {
    const total = Number(e.actual_amount ?? 0) + Number(e.planned_amount ?? 0);
    inByMonth.set(e.period_month, (inByMonth.get(e.period_month) ?? 0) + total);
  }
  const outByMonth = new Map<string, number>();
  for (const f of costRes.data ?? []) {
    const total = Number(f.actual_amount ?? 0) + Number(f.planned_amount ?? 0);
    outByMonth.set(f.period_month, (outByMonth.get(f.period_month) ?? 0) + total);
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
      label: shortLabel(iso),
      net,
      cumulative,
      isFuture: iso > thisMonthIso,
    };
  });

  let totalIn = 0, totalOut = 0;
  inByMonth.forEach((v) => { totalIn += v; });
  outByMonth.forEach((v) => { totalOut += v; });
  const totalNet = totalIn - totalOut;

  // Snapshot up to and including current month
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
            Through {shortLabel(thisMonthIso)}
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
