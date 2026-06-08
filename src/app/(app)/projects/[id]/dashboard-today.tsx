import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/format";

type Props = {
  projectId: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BLOCKING_LOOKAHEAD_DAYS = 14;

function todayUtcMs(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dateMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function plannedPctForTask(
  startIso: string | null,
  endIso: string | null,
  todayMs: number,
): number | null {
  const start = dateMs(startIso);
  const end = dateMs(endIso);
  if (start == null || end == null || end <= start) return null;
  if (todayMs <= start) return 0;
  if (todayMs >= end) return 100;
  return ((todayMs - start) / (end - start)) * 100;
}

function firstOfThisMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function isoDaysAhead(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function DashboardToday({ projectId }: Props) {
  const supabase = createClient();

  const todayMs = todayUtcMs();
  const thisMonthIso = firstOfThisMonthIso();
  const blockingCutoff = isoDaysAhead(BLOCKING_LOOKAHEAD_DAYS);
  const safetyCutoff = isoDaysAgo(30);

  const [
    tasksRes,
    lastDprRes,
    openRfisRes,
    blockingRfisRes,
    billingRes,
    costForecastRes,
    costTotalsRes,
    safetyRes,
  ] = await Promise.all([
    supabase
      .from("schedule_tasks")
      .select("start_date, end_date, duration_days, pct_complete, is_internal")
      .eq("project_id", projectId)
      .eq("is_internal", false),
    supabase
      .from("dprs")
      .select("report_date, status")
      .eq("project_id", projectId)
      .order("report_date", { ascending: false })
      .limit(1),
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .neq("status", "closed"),
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .neq("status", "closed")
      .not("date_needed", "is", null)
      .lte("date_needed", blockingCutoff),
    supabase
      .from("billing_entries")
      .select(
        "period_month, planned_amount, actual_amount, billing_lines!inner(project_id)",
      )
      .eq("billing_lines.project_id", projectId)
      .eq("period_month", thisMonthIso),
    supabase
      .from("cost_forecasts")
      .select(
        "period_month, planned_amount, actual_amount, cost_codes!inner(project_id)",
      )
      .eq("cost_codes.project_id", projectId)
      .eq("period_month", thisMonthIso),
    supabase
      .from("v_cost_code_totals")
      .select("code, estimated_cost, total_actual")
      .eq("project_id", projectId),
    supabase
      .from("dprs")
      .select("id, safety_incident, near_miss, report_date")
      .eq("project_id", projectId)
      .gte("report_date", safetyCutoff)
      .or("safety_incident.eq.true,near_miss.eq.true"),
  ]);

  // ===== Plan vs actual (duration-weighted) =====
  let plannedWeighted = 0;
  let actualWeighted = 0;
  let weightSum = 0;
  for (const t of tasksRes.data ?? []) {
    if (!t.start_date || !t.end_date) continue;
    const planned = plannedPctForTask(t.start_date, t.end_date, todayMs);
    if (planned == null) continue;
    const actual = Number(t.pct_complete ?? 0);
    const weight = Math.max(Number(t.duration_days ?? 0), 1);
    weightSum += weight;
    plannedWeighted += planned * weight;
    actualWeighted += actual * weight;
  }
  const plannedPct = weightSum > 0 ? plannedWeighted / weightSum : 0;
  const actualPct = weightSum > 0 ? actualWeighted / weightSum : 0;
  const variance = actualPct - plannedPct;
  const hasScheduleData = weightSum > 0;

  // ===== Last DPR =====
  const lastDpr = lastDprRes.data?.[0] ?? null;
  const lastDprMs = lastDpr ? Date.parse(lastDpr.report_date) : null;
  const daysSinceLastDpr =
    lastDprMs != null ? Math.floor((Date.now() - lastDprMs) / ONE_DAY_MS) : null;

  // ===== RFIs =====
  const openRfis = openRfisRes.count ?? 0;
  const blockingRfis = blockingRfisRes.count ?? 0;

  // ===== This-month cash =====
  let cashInThisMonth = 0;
  for (const e of billingRes.data ?? []) {
    cashInThisMonth +=
      Number(e.actual_amount ?? 0) + Number(e.planned_amount ?? 0);
  }
  let cashOutThisMonth = 0;
  for (const f of costForecastRes.data ?? []) {
    cashOutThisMonth +=
      Number(f.actual_amount ?? 0) + Number(f.planned_amount ?? 0);
  }
  const netThisMonth = cashInThisMonth - cashOutThisMonth;

  // ===== Top cost overrun =====
  let topOverrun = { code: "", variance: 0, pct: 0 };
  for (const r of costTotalsRes.data ?? []) {
    const v = Number(r.total_actual ?? 0) - Number(r.estimated_cost ?? 0);
    if (v > topOverrun.variance) {
      const pct =
        Number(r.estimated_cost ?? 0) > 0
          ? (v / Number(r.estimated_cost)) * 100
          : 0;
      topOverrun = { code: String(r.code ?? ""), variance: v, pct };
    }
  }

  // ===== Safety in last 30 days =====
  const safetyRows = safetyRes.data ?? [];
  const safetyIncidents = safetyRows.filter((r) => r.safety_incident).length;
  const safetyNearMisses = safetyRows.filter((r) => r.near_miss).length;
  const safetyTotal = safetyIncidents + safetyNearMisses;

  // ===== Tones =====
  const varianceTone =
    !hasScheduleData
      ? "text-muted-foreground"
      : variance >= -5
        ? "text-emerald-600"
        : variance >= -15
          ? "text-amber-600"
          : "text-destructive";

  const dprTone =
    daysSinceLastDpr == null
      ? "text-destructive"
      : daysSinceLastDpr <= 1
        ? "text-emerald-600"
        : daysSinceLastDpr <= 3
          ? "text-amber-600"
          : "text-destructive";

  const rfiTone =
    blockingRfis > 0
      ? "text-destructive"
      : openRfis > 0
        ? "text-amber-600"
        : "text-emerald-600";

  const cashTone =
    netThisMonth >= 0 ? "text-emerald-600" : "text-destructive";

  const overrunTone =
    topOverrun.variance === 0
      ? "text-emerald-600"
      : topOverrun.pct >= 5
        ? "text-destructive"
        : "text-amber-600";

  const safetyTone =
    safetyIncidents > 0
      ? "text-destructive"
      : safetyNearMisses > 0
        ? "text-amber-600"
        : "text-emerald-600";

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Today</h2>
        <p className="text-xs text-muted-foreground">
          What needs your attention now
        </p>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Card
          label="Yesterday DPR"
          value={
            daysSinceLastDpr == null
              ? "None"
              : daysSinceLastDpr === 0
                ? "Today"
                : daysSinceLastDpr === 1
                  ? "1d ago"
                  : `${daysSinceLastDpr}d ago`
          }
          valueClassName={dprTone}
          sub={
            lastDpr
              ? `Status: ${lastDpr.status}`
              : "No DPR ever - crew may not be reporting"
          }
        />

        <Card
          label="Schedule"
          value={
            hasScheduleData ? `${variance >= 0 ? "+" : ""}${variance.toFixed(1)}%` : "-"
          }
          valueClassName={varianceTone}
          sub={
            hasScheduleData
              ? `Actual ${actualPct.toFixed(0)}% vs plan ${plannedPct.toFixed(0)}%`
              : "No dated tasks yet"
          }
        />

        <Card
          label="Blocking RFIs"
          value={`${blockingRfis}`}
          valueClassName={rfiTone}
          sub={
            blockingRfis > 0
              ? `needed in ${BLOCKING_LOOKAHEAD_DAYS}d - ${openRfis} open total`
              : openRfis > 0
                ? `${openRfis} open, none needed soon`
                : "All clear"
          }
        />

        <Card
          label="Net cash, this month"
          value={formatCurrency(netThisMonth)}
          valueClassName={cashTone}
          sub={`In ${formatCurrency(cashInThisMonth)} / Out ${formatCurrency(cashOutThisMonth)}`}
        />

        <Card
          label="Top cost overrun"
          value={
            topOverrun.variance === 0
              ? "None"
              : `${formatCurrency(topOverrun.variance)}`
          }
          valueClassName={overrunTone}
          sub={
            topOverrun.variance === 0
              ? "All cost codes within budget"
              : `${topOverrun.code} (+${topOverrun.pct.toFixed(0)}%)`
          }
        />

        <Card
          label="Safety, last 30d"
          value={`${safetyTotal}`}
          valueClassName={safetyTone}
          sub={
            safetyTotal === 0
              ? "No incidents or near-misses"
              : `${safetyIncidents} incident${safetyIncidents === 1 ? "" : "s"}, ${safetyNearMisses} near-miss${safetyNearMisses === 1 ? "" : "es"}`
          }
        />
      </div>
    </section>
  );
}

function Card({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: string;
  sub: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 text-lg font-semibold tabular-nums", valueClassName)}>
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground line-clamp-2">
        {sub}
      </div>
    </div>
  );
}
