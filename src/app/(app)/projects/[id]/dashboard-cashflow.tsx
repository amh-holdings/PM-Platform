import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { firstOfThisMonthIso } from "@/lib/cashflow";
import { buildProjection } from "@/lib/projection";

import { DashboardCashflowChart, type CashflowDatum } from "./dashboard-cashflow-chart";

type Props = { projectId: string };

// Replaces Project margin, Billing timeline and Cash Out timeline.
//
// Those were three panels, three charts and nine month-tiles rendering one
// dataset, and most of the tiles read "$0" or "Nothing yet" on any project that
// had not billed. What a PM needs from a dashboard is the position and the low
// point; the month-by-month detail lives in the projection table underneath,
// and the per-line detail lives on the Billing page.

export async function DashboardCashflow({ projectId }: Props) {
  const supabase = createClient();

  let projection;
  try {
    projection = await buildProjection(supabase, projectId, { monthsAhead: 18 });
  } catch (e) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Cash flow</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {e instanceof Error ? e.message : "unknown error"}
        </p>
      </section>
    );
  }

  const thisMonthIso = firstOfThisMonthIso();

  // Months where nothing happens are dropped rather than drawn as a run of
  // empty bars. The cumulative line still steps across them because it carries
  // forward from the row before.
  const active = projection.rows.filter(
    (r) =>
      r.cashIn !== 0 ||
      r.totalCashOut !== 0 ||
      r.retainageActual !== 0 ||
      r.retainageForecast !== 0,
  );

  const data: CashflowDatum[] = active.map((r) => ({
    month: r.month,
    label: r.label,
    cashInActual: r.cashIn > 0 ? Math.min(r.cashIn, r.revenueActual) : 0,
    cashInForecast: Math.max(0, r.cashIn - Math.min(r.cashIn, r.revenueActual)),
    retainageHeld: r.retainageActual + r.retainageForecast,
    cashOutActual: -r.cashOutActual,
    cashOutForecast: -r.cashOutForecast,
    cumulative: r.cumulativeCash,
    isFuture: r.month > thisMonthIso,
  }));

  // The number the panel exists for: the worst the bank balance gets, and when.
  //
  // Measured from the first month money moves, not from the start of the
  // horizon. Every project sits at zero before its first receipt, so scanning
  // the whole series reports "low point $0" in a month nothing happened - true,
  // and no use to anyone deciding whether to fund the job.
  // The first month cash actually moves, which is not the first active month:
  // Sussexx accrues retainage in Jun 26 but nothing reaches the bank until the
  // 30-day terms land it in Jul, so a scan from Jun still reports $0.
  const firstActive = projection.rows.find(
    (r) => r.cashIn !== 0 || r.totalCashOut !== 0,
  )?.month;
  let trough = { month: "", label: "", value: Number.POSITIVE_INFINITY };
  for (const r of projection.rows) {
    if (firstActive && r.month < firstActive) continue;
    if (r.cumulativeCash < trough.value) {
      trough = { month: r.month, label: r.label, value: r.cumulativeCash };
    }
  }
  if (!Number.isFinite(trough.value)) trough = { month: "", label: "", value: 0 };
  const cashToDate =
    [...projection.rows].filter((r) => r.month <= thisMonthIso).pop()?.cumulativeCash ?? 0;
  const retainageHeld = projection.rows.reduce(
    (s, r) => s + r.retainageActual + r.retainageForecast,
    0,
  );
  const finalMargin = projection.totals.margin;

  const noData = data.length === 0;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Cash flow</h2>
          <p className="text-xs text-muted-foreground">
            Money in and out by month, with the running position. Solid is
            recorded, lighter is forecast from the schedule.
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/billing`}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Billing &rarr;
        </Link>
      </div>

      <DashboardCashflowChart data={data} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label="Cash position today"
          value={formatCurrency(cashToDate)}
          tone={cashToDate >= 0 ? "good" : "bad"}
          note={`Through ${monthLabel(thisMonthIso)}`}
        />
        <Tile
          label="Low point"
          value={noData ? "-" : formatCurrency(trough.value)}
          tone={trough.value < 0 ? "bad" : "good"}
          note={
            noData
              ? "Nothing projected"
              : trough.value < 0
                ? `${trough.label} - funding needed`
                : `${trough.label} - never negative`
          }
        />
        <Tile
          label="Retainage held"
          value={formatCurrency(retainageHeld)}
          note="Earned, not yet released"
        />
        <Tile
          label="Margin at completion"
          value={formatCurrency(finalMargin)}
          tone={finalMargin >= 0 ? "good" : "bad"}
          note="Revenue less cost, whole horizon"
        />
      </div>

      {projection.warnings.length > 0 && (
        <details className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
          <summary className="cursor-pointer font-medium text-amber-800">
            {projection.warnings.length} thing
            {projection.warnings.length === 1 ? "" : "s"} the forecast could not
            account for
          </summary>
          <ul className="mt-1.5 space-y-1 text-amber-900">
            {projection.warnings.slice(0, 10).map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

function Tile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "bad" && "text-destructive",
          tone === "good" && "text-emerald-700",
        )}
      >
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground">{note}</div>
    </div>
  );
}
