"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { computeCpm } from "@/lib/schedule-cpm";
import {
  makeCalendar,
  todayIso,
  workingDaysBetween,
  type CalendarException,
} from "@/lib/schedule-calendar";
import { assessSchedule } from "@/lib/schedule-health";
import {
  constraintsByTask,
  summarizeConstraints,
  type ScheduleConstraint,
} from "@/lib/schedule-constraints";
import { SCOPE_ORDER, scopeOf, type TaskScope } from "@/lib/schedule-scope";
import {
  applyProjectedDates,
  setScheduleBaseline,
  setScheduleDataDate,
  takeScheduleUpdate,
} from "../schedule-actions";
import { ScheduleTable, type ScheduleTaskRow } from "./schedule-table";
import { ScheduleGantt } from "./schedule-gantt";
import { ScheduleLookaheadView } from "./schedule-lookahead-view";
import { ScheduleHealthView, type ScheduleUpdateRow } from "./schedule-health-view";
import { ScheduleConstraintsView } from "./schedule-constraints-view";
import { CalendarDialog, type CalendarExceptionRow } from "./calendar-dialog";

type Props = {
  projectId: string;
  projectName: string;
  tasks: ScheduleTaskRow[];
  baselineAvailable: boolean;
  phase1Available: boolean;
  dataDate: string | null;
  workWeek: 5 | 6;
  calendarExceptions: CalendarExceptionRow[];
  calendarAvailable: boolean;
  constraints: ScheduleConstraint[];
  constraintsAvailable: boolean;
  updates: ScheduleUpdateRow[];
  updatesAvailable: boolean;
};

type View = "table" | "gantt" | "lookahead" | "health" | "constraints";

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
  phase1Available,
  dataDate,
  workWeek,
  calendarExceptions,
  calendarAvailable,
  constraints,
  constraintsAvailable,
  updates,
  updatesAvailable,
}: Props) {
  const [view, setView] = useState<View>("table");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [dateDraft, setDateDraft] = useState(dataDate ?? "");

  const effectiveDataDate = dataDate ?? todayIso();

  const calendar = useMemo(
    () =>
      makeCalendar(
        workWeek,
        calendarExceptions as unknown as CalendarException[],
      ),
    [workWeek, calendarExceptions],
  );

  const scopeCounts = useMemo(() => {
    const m = new Map<TaskScope, number>();
    for (const t of tasks) m.set(scopeOf(t), (m.get(scopeOf(t)) ?? 0) + 1);
    return m;
  }, [tasks]);

  const [scopeFilter, setScopeFilter] = useState<string>(
    scopeCounts.get("Civil") ? "Civil" : "",
  );

  // CPM runs over EVERY task, always. Running it over the scope filter dropped
  // any predecessor pointing outside the filter, because a link to an unknown
  // task is discarded - so the Civil view was calculating float and a critical
  // path as if civil had no external constraints at all. The filter is a lens
  // on the results, never an input to them.
  const cpm = useMemo(
    () => computeCpm(tasks, { calendar, dataDate: effectiveDataDate }),
    [tasks, calendar, effectiveDataDate],
  );

  const scoped = useMemo(
    () => (scopeFilter ? tasks.filter((t) => scopeOf(t) === scopeFilter) : tasks),
    [tasks, scopeFilter],
  );

  // Health is a property of the whole schedule, not of a scope. A logic gap
  // between civil and electrical is invisible from inside either one.
  const health = useMemo(
    () => assessSchedule(tasks, cpm, { calendar, dataDate: effectiveDataDate }),
    [tasks, cpm, calendar, effectiveDataDate],
  );

  const constraintState = useMemo(
    () => constraintsByTask(constraints, effectiveDataDate, calendar),
    [constraints, effectiveDataDate, calendar],
  );

  const constraintSummary = useMemo(
    () => summarizeConstraints(constraints, effectiveDataDate, calendar),
    [constraints, effectiveDataDate, calendar],
  );

  const baselineStats = useMemo(() => {
    const withBaseline = scoped.filter((t) => t.baseline_end);
    let behind = 0;
    let worst = 0;
    for (const t of withBaseline) {
      if (!t.end_date || !t.baseline_end) continue;
      const v = workingDaysBetween(t.baseline_end, t.end_date, calendar);
      if (v > 0) behind++;
      if (v > worst) worst = v;
    }
    return { count: withBaseline.length, total: scoped.length, behind, worst };
  }, [scoped, calendar]);

  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    onOk: () => string,
  ) {
    setMsg(null);
    startTransition(async () => {
      const res = await fn();
      setMsg(res.ok ? onOk() : `Failed: ${res.error}`);
      if (res.ok) router.refresh();
    });
  }

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

  const slip = cpm.finishSlipDays;
  const lastUpdate = updates[0] ?? null;

  return (
    <div className="space-y-4">
      {/* Forecast banner - the numbers that matter, side by side. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
        <button
          onClick={() => setView("health")}
          className="rounded-lg border bg-card px-4 py-3 text-left shadow-sm transition hover:border-foreground/30"
        >
          <div className="text-xs text-muted-foreground">Schedule health</div>
          <div
            className={cn(
              "text-lg font-semibold",
              health.score >= 80
                ? "text-emerald-700"
                : health.score >= 60
                  ? "text-amber-700"
                  : "text-destructive",
            )}
          >
            {health.score}/100 <span className="text-sm font-normal">({health.grade})</span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {health.findings.length
              ? `${health.findings.length} check${health.findings.length === 1 ? "" : "s"} to clear`
              : "all checks pass"}
          </div>
        </button>
        <button
          onClick={() => setView("constraints")}
          disabled={!constraintsAvailable}
          className="rounded-lg border bg-card px-4 py-3 text-left shadow-sm transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <div className="text-xs text-muted-foreground">Open constraints</div>
          <div
            className={cn(
              "text-lg font-semibold",
              !constraintsAvailable
                ? "text-muted-foreground"
                : constraintSummary.overdue > 0
                  ? "text-destructive"
                  : constraintSummary.open > 0
                    ? "text-amber-700"
                    : "text-emerald-700",
            )}
          >
            {!constraintsAvailable ? "Not enabled" : constraintSummary.open}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {!constraintsAvailable
              ? "run migration 0034"
              : constraintSummary.overdue > 0
                ? `${constraintSummary.overdue} past need-by, ${constraintSummary.blockedTasks} tasks blocked`
                : constraintSummary.open > 0
                  ? `${constraintSummary.blockedTasks} task${constraintSummary.blockedTasks === 1 ? "" : "s"} blocked`
                  : "nothing in the way"}
          </div>
        </button>
      </div>

      {/* Data date - the as-of line everything is calculated against. */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">
            Data date
          </label>
          <input
            type="date"
            value={dateDraft}
            onChange={(e) => setDateDraft(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          />
          {dateDraft !== (dataDate ?? "") && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run(
                  () => setScheduleDataDate(projectId, dateDraft || null),
                  () =>
                    dateDraft
                      ? `Data date set to ${dateDraft}. Every calculation is now as of that date.`
                      : "Data date cleared. Calculations follow today again.",
                )
              }
            >
              Apply
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground">
            {dataDate
              ? "calculations are as of this date"
              : `following today (${todayIso()})`}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {workWeek === 6 ? "6-day week" : "5-day week"}
            {calendarExceptions.length
              ? `, ${calendarExceptions.length} calendar exception${calendarExceptions.length === 1 ? "" : "s"}`
              : ""}
          </span>
          <CalendarDialog
            projectId={projectId}
            workWeek={workWeek}
            exceptions={calendarExceptions}
            available={calendarAvailable}
            trigger={
              <Button variant="outline" size="sm">
                Calendar
              </Button>
            }
          />
          {updatesAvailable && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(
                  () => takeScheduleUpdate(projectId),
                  () =>
                    `Update captured at data date ${effectiveDataDate}. The task set is frozen and cannot be edited.`,
                )
              }
              title="Freeze the whole schedule as it stands at the data date"
            >
              Take update
            </Button>
          )}
        </div>
      </div>

      {cpm.cycle && (
        <Banner tone="bad">
          Circular dependency between {cpm.cycle.join(", ")}. Dates cannot be
          calculated until the loop is broken.
        </Banner>
      )}
      {cpm.constraintViolations.length > 0 && (
        <Banner tone="bad">
          {cpm.constraintViolations.length} date constraint
          {cpm.constraintViolations.length === 1 ? "" : "s"} the logic cannot
          meet. {cpm.constraintViolations[0].message}
          {cpm.constraintViolations.length > 1 && (
            <> See the Health tab for the rest.</>
          )}
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
              ["health", "Health"],
              ["constraints", "Constraints"],
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
              {v === "health" && health.findings.length > 0 && (
                <span className="ml-1.5 rounded-full bg-destructive/15 px-1.5 text-[10px] font-semibold text-destructive">
                  {health.findings.length}
                </span>
              )}
              {v === "constraints" && constraintSummary.open > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-900">
                  {constraintSummary.open}
                </span>
              )}
            </button>
          ))}
        </div>

        {view !== "health" && (
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
        )}

        <div className="ml-auto flex items-center gap-2">
          {view !== "health" && drifted.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(
                  () => applyProjectedDates(projectId, drifted),
                  () =>
                    `Reflowed ${drifted.length} task${drifted.length === 1 ? "" : "s"} onto projected dates. Baseline untouched, so the variance is still visible.`,
                )
              }
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

      {!phase1Available && (
        <Banner tone="warn">
          Migration 0033 has not been applied, so date constraints, milestones,
          the project calendar and schedule updates are unavailable. Everything
          else works; the engine falls back to a 5-day week and today&rsquo;s date.
        </Banner>
      )}

      {view === "table" && (
        <ScheduleTable
          projectId={projectId}
          tasks={scoped}
          cpm={cpm}
          allTasks={tasks}
          calendar={calendar}
          constraintState={constraintState}
          phase1Available={phase1Available}
        />
      )}
      {view === "gantt" && <ScheduleGantt tasks={scoped} cpm={cpm} />}
      {view === "lookahead" && (
        <ScheduleLookaheadView
          tasks={scoped}
          cpm={cpm}
          projectName={projectName}
          calendar={calendar}
          constraintState={constraintState}
        />
      )}
      {view === "health" && (
        <ScheduleHealthView
          health={health}
          cpm={cpm}
          projectName={projectName}
          projectId={projectId}
          updates={updates}
          updatesAvailable={updatesAvailable}
          baselineAvailable={baselineAvailable}
        />
      )}
      {view === "constraints" && (
        <ScheduleConstraintsView
          projectId={projectId}
          projectName={projectName}
          constraints={constraints}
          available={constraintsAvailable}
          dataDate={effectiveDataDate}
          calendar={calendar}
          tasks={tasks}
          summary={constraintSummary}
        />
      )}

      {lastUpdate && (
        <p className="text-xs text-muted-foreground">
          Last schedule update captured at data date {fmt(lastUpdate.data_date)}
          {lastUpdate.projected_finish
            ? `, projecting ${fmt(lastUpdate.projected_finish)}`
            : ""}
          . See Health for the full history.
        </p>
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
