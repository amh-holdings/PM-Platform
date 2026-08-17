"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { computeCpm } from "@/lib/schedule-cpm";
import { workingDaysBetween } from "@/lib/schedule-calendar";
import { SCOPE_ORDER, scopeOf, type TaskScope } from "@/lib/schedule-scope";
import { applyProjectedDates, setScheduleBaseline } from "../schedule-actions";
import { ScheduleTable, type ScheduleTaskRow } from "./schedule-table";
import { ScheduleGantt } from "./schedule-gantt";
import { ScheduleLookaheadView } from "./schedule-lookahead-view";

type Props = {
  projectId: string;
  projectName: string;
  tasks: ScheduleTaskRow[];
  baselineAvailable: boolean;
};

type View = "table" | "gantt" | "lookahead";

function fmt(iso: string | null): string {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ScheduleWorkspace({
  projectId,
  projectName,
  tasks,
  baselineAvailable,
}: Props) {
  const [view, setView] = useState<View>("table");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const scopeCounts = useMemo(() => {
    const m = new Map<TaskScope, number>();
    for (const t of tasks) m.set(scopeOf(t), (m.get(scopeOf(t)) ?? 0) + 1);
    return m;
  }, [tasks]);

  const [scopeFilter, setScopeFilter] = useState<string>(
    scopeCounts.get("Civil") ? "Civil" : "",
  );

  const scoped = useMemo(
    () => (scopeFilter ? tasks.filter((t) => scopeOf(t) === scopeFilter) : tasks),
    [tasks, scopeFilter],
  );

  // CPM runs on the client so the Map it returns never has to cross the RSC
  // boundary. It is a pure pass over a few dozen rows, so the cost is nil.
  const cpm = useMemo(() => computeCpm(scoped), [scoped]);

  const baselineStats = useMemo(() => {
    const withBaseline = scoped.filter((t) => t.baseline_end);
    let behind = 0;
    let worst = 0;
    for (const t of withBaseline) {
      if (!t.end_date || !t.baseline_end) continue;
      const v = workingDaysBetween(t.baseline_end, t.end_date);
      if (v > 0) behind++;
      if (v > worst) worst = v;
    }
    return { count: withBaseline.length, total: scoped.length, behind, worst };
  }, [scoped]);

  function takeBaseline(onlyUnbaselined: boolean) {
    setMsg(null);
    startTransition(async () => {
      const res = await setScheduleBaseline(projectId, { onlyUnbaselined });
      setMsg(
        res.ok
          ? `Baseline set on ${res.count} task${res.count === 1 ? "" : "s"}.`
          : `Failed: ${res.error}`,
      );
      if (res.ok) router.refresh();
    });
  }

  // Tasks whose projection has moved off the planned dates. The projection is
  // always live and read-only; this is the deliberate act of accepting it as
  // the plan, which is why it is a button and not a background job.
  const drifted = useMemo(
    () =>
      scoped
        .map((t) => {
          const c = cpm.byWbs.get(t.wbs_code);
          if (!c) return null;
          if (c.projectedStart === t.start_date && c.projectedEnd === t.end_date)
            return null;
          return { wbs: t.wbs_code, start: c.projectedStart, end: c.projectedEnd };
        })
        .filter((x): x is { wbs: string; start: string; end: string } => x !== null),
    [scoped, cpm],
  );

  function acceptProjection() {
    setMsg(null);
    startTransition(async () => {
      const res = await applyProjectedDates(projectId, drifted);
      setMsg(
        res.ok
          ? `Reflowed ${res.count} task${res.count === 1 ? "" : "s"} onto projected dates. Baseline untouched, so the variance is still visible.`
          : `Failed: ${res.error}`,
      );
      if (res.ok) router.refresh();
    });
  }

  const slip = cpm.finishSlipDays;

  return (
    <div className="space-y-4">
      {/* Forecast banner - the two dates that matter, side by side. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Planned finish" value={fmt(cpm.plannedFinish)} />
        <Card
          label="Projected finish"
          value={fmt(cpm.projectedFinish)}
          tone={slip > 0 ? "bad" : slip < 0 ? "good" : undefined}
          note={
            slip === 0
              ? "on plan"
              : slip > 0
                ? `${slip} working days late`
                : `${-slip} working days early`
          }
        />
        <Card
          label="Critical path"
          value={`${cpm.criticalPath.length} task${cpm.criticalPath.length === 1 ? "" : "s"}`}
          note={cpm.criticalPath.length ? "zero float" : "no logic driving finish"}
          tone={cpm.criticalPath.length ? "bad" : undefined}
        />
        <Card
          label="Baseline"
          value={
            !baselineAvailable
              ? "Not enabled"
              : baselineStats.count === 0
                ? "Not set"
                : `${baselineStats.count} of ${baselineStats.total}`
          }
          note={
            !baselineAvailable
              ? "run migration 0032"
              : baselineStats.count === 0
                ? "no committed dates to measure against"
                : `${baselineStats.behind} behind, worst ${baselineStats.worst}d`
          }
          tone={!baselineAvailable || baselineStats.count === 0 ? "warn" : undefined}
        />
      </div>

      {cpm.cycle && (
        <Banner tone="bad">
          Circular dependency between {cpm.cycle.join(", ")}. Dates cannot be
          calculated until the loop is broken.
        </Banner>
      )}
      {cpm.isolated.length > 0 && (
        <Banner tone="warn">
          {cpm.isolated.length} task{cpm.isolated.length === 1 ? " has" : "s have"} no
          predecessor or successor ({cpm.isolated.join(", ")}). They float free of
          the schedule logic and do not drive the finish date.
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-1 rounded-md border p-1">
          {(
            [
              ["table", "Table"],
              ["gantt", "Gantt"],
              ["lookahead", "Look-ahead"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium",
                view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-sm">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">Scope</label>
          <select
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm font-medium"
          >
            <option value="">All scopes ({tasks.length})</option>
            {SCOPE_ORDER.filter((s) => scopeCounts.get(s)).map((s) => (
              <option key={s} value={s}>
                {s} ({scopeCounts.get(s)})
              </option>
            ))}
          </select>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {drifted.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={acceptProjection}
              title="Move planned dates onto the projection. The baseline is not touched."
            >
              Reflow {drifted.length} task{drifted.length === 1 ? "" : "s"}
            </Button>
          )}
          {baselineAvailable && (
            <>
              {baselineStats.count > 0 && baselineStats.count < baselineStats.total && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => takeBaseline(true)}
                >
                  Baseline {baselineStats.total - baselineStats.count} new
                </Button>
              )}
              <Button
                variant={baselineStats.count === 0 ? "default" : "outline"}
                size="sm"
                disabled={pending}
                onClick={() => takeBaseline(false)}
              >
                {baselineStats.count === 0 ? "Set baseline" : "Re-baseline all"}
              </Button>
            </>
          )}
        </div>
      </div>

      {msg && <Banner tone={msg.startsWith("Failed") ? "bad" : "good"}>{msg}</Banner>}

      {view === "table" && (
        <ScheduleTable projectId={projectId} tasks={scoped} cpm={cpm} allTasks={tasks} />
      )}
      {view === "gantt" && <ScheduleGantt tasks={scoped} cpm={cpm} />}
      {view === "lookahead" && (
        <ScheduleLookaheadView tasks={scoped} cpm={cpm} projectName={projectName} />
      )}
    </div>
  );
}

function Card({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "good" | "bad" | "warn";
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3 shadow-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-lg font-semibold",
          tone === "bad" && "text-destructive",
          tone === "good" && "text-emerald-700",
          tone === "warn" && "text-amber-700",
        )}
      >
        {value}
      </div>
      {note && <div className="text-[11px] text-muted-foreground">{note}</div>}
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "good" | "bad" | "warn";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm",
        tone === "bad" && "border-destructive/40 bg-destructive/10 text-destructive",
        tone === "warn" && "border-amber-300 bg-amber-50 text-amber-900",
        tone === "good" && "border-emerald-300 bg-emerald-50 text-emerald-900",
      )}
    >
      {children}
    </div>
  );
}
