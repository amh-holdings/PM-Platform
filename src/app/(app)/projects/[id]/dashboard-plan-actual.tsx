import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";


type Props = {
  projectId: string;
};

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

export async function DashboardPlanActual({ projectId }: Props) {
  const supabase = createClient();

  const { data: tasks, error } = await supabase
    .from("schedule_tasks")
    .select(
      "id, task_name, start_date, end_date, duration_days, pct_complete, status, is_internal",
    )
    .eq("project_id", projectId)
    .eq("is_internal", false);

  if (error) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Plan vs actual</h2>
        <p className="mt-2 text-xs text-destructive">Failed to load: {error.message}</p>
      </section>
    );
  }

  const todayMs = todayUtcMs();
  const dated = (tasks ?? []).filter(
    (t) => t.start_date && t.end_date && (t.duration_days ?? 0) >= 0,
  );

  // Duration-weighted planned and actual percent across all dated tasks.
  let weightSum = 0;
  let plannedWeighted = 0;
  let actualWeighted = 0;
  let slipDaysSum = 0;
  let slipDenom = 0;
  let behindCount = 0;
  let aheadCount = 0;
  let activeNoStartCount = 0;
  let activeBlownEnd = 0;

  for (const t of dated) {
    const planned = plannedPctForTask(t.start_date, t.end_date, todayMs);
    if (planned == null) continue;
    const actual = Number(t.pct_complete ?? 0);
    const weight = Math.max(Number(t.duration_days ?? 0), 1);
    weightSum += weight;
    plannedWeighted += planned * weight;
    actualWeighted += actual * weight;

    if (planned > 0 && planned < 100) {
      const delta = planned - actual;
      const slipDays = (delta / 100) * weight;
      slipDaysSum += slipDays;
      slipDenom += 1;
      if (delta > 10) behindCount += 1;
      else if (delta < -10) aheadCount += 1;
    }

    const startMs = dateMs(t.start_date);
    if (startMs != null && todayMs >= startMs && actual === 0) {
      activeNoStartCount += 1;
    }
    const endMs = dateMs(t.end_date);
    if (endMs != null && todayMs > endMs && actual < 100) {
      activeBlownEnd += 1;
    }
  }

  const plannedPct = weightSum > 0 ? plannedWeighted / weightSum : 0;
  const actualPct = weightSum > 0 ? actualWeighted / weightSum : 0;
  const spi = plannedPct > 0 ? actualPct / plannedPct : null;
  const avgSlipDays = slipDenom > 0 ? slipDaysSum / slipDenom : 0;

  const variance = actualPct - plannedPct;
  const varianceTone =
    variance >= -5
      ? "text-emerald-600"
      : variance >= -15
        ? "text-amber-600"
        : "text-destructive";
  const spiTone =
    spi == null
      ? "text-muted-foreground"
      : spi >= 0.95
        ? "text-emerald-600"
        : spi >= 0.85
          ? "text-amber-600"
          : "text-destructive";

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-semibold">Plan vs actual</h2>
          <p className="text-xs text-muted-foreground">
            Duration-weighted across {dated.length} dated tasks. Linear interpolation.
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-5">
        <Kpi label="Planned today" value={`${plannedPct.toFixed(1)}%`} />
        <Kpi
          label="Actual today"
          value={`${actualPct.toFixed(1)}%`}
          valueClassName={varianceTone}
          sub={`${variance >= 0 ? "+" : ""}${variance.toFixed(1)} vs plan`}
        />
        <Kpi
          label="SPI"
          value={spi == null ? "-" : spi.toFixed(2)}
          valueClassName={spiTone}
          sub={spi == null ? "no in-flight tasks" : spi >= 1 ? "on/ahead" : "behind"}
        />
        <Kpi
          label="Avg task slip"
          value={`${avgSlipDays.toFixed(1)}d`}
          sub={
            avgSlipDays >= 0
              ? `behind plan - ${behindCount} behind, ${aheadCount} ahead`
              : `ahead plan - ${behindCount} behind, ${aheadCount} ahead`
          }
          valueClassName={
            avgSlipDays <= 0.5
              ? "text-emerald-600"
              : avgSlipDays <= 2
                ? "text-amber-600"
                : "text-destructive"
          }
        />
        <Kpi
          label="At-risk tasks"
          value={`${activeNoStartCount + activeBlownEnd}`}
          sub={`${activeNoStartCount} not started, ${activeBlownEnd} past end`}
          valueClassName={
            activeBlownEnd > 0
              ? "text-destructive"
              : activeNoStartCount > 0
                ? "text-amber-600"
                : "text-emerald-600"
          }
        />
      </div>

      {weightSum === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          No dated tasks yet. Import a schedule with start and end dates so plan
          vs actual can compute.
        </p>
      )}
    </section>
  );
}

function Kpi({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 text-xl font-semibold tabular-nums", valueClassName)}>
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}
