"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { workingDaysBetween, type CalendarLike } from "@/lib/schedule-calendar";
import type { CpmOutput } from "@/lib/schedule-cpm";
import type { TaskConstraintState } from "@/lib/schedule-constraints";
import { TaskEditDialog, type TaskFormValues } from "./task-edit-dialog";

export type ScheduleTaskRow = TaskFormValues & {
  sort_order: number | null;
  level_code: number | null;
  pct_complete: number | null;
  status_source: string | null;
  last_dpr_at: string | null;
  baseline_start?: string | null;
  baseline_end?: string | null;
};

type Props = {
  projectId: string;
  tasks: ScheduleTaskRow[];
  cpm: CpmOutput;
  // Unscoped. Predecessor validation has to see the whole project, or a link
  // to a task outside the current scope filter reads as "not found".
  allTasks: ScheduleTaskRow[];
  calendar: CalendarLike;
  constraintState: Map<string, TaskConstraintState>;
  phase1Available: boolean;
};

const STATUS_TONE: Record<string, string> = {
  Complete: "bg-emerald-100 text-emerald-900",
  "In Progress": "bg-blue-100 text-blue-900",
  Awaiting: "bg-amber-100 text-amber-900",
  "Not Started": "bg-muted text-muted-foreground",
  Rejected: "bg-destructive/10 text-destructive",
  Approved: "bg-emerald-100 text-emerald-900",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
    timeZone: "UTC",
  });
}

// Weight a task's contribution to its parent's rolled-up percentage. Duration
// is the only size signal on the schedule - there are no quantities or values
// on these rows - so a two-week task counts more than a one-day task.
function weightOf(t: ScheduleTaskRow): number {
  if (t.duration_days != null && t.duration_days > 0) return t.duration_days;
  if (t.start_date && t.end_date) {
    const days = (Date.parse(t.end_date) - Date.parse(t.start_date)) / 86_400_000 + 1;
    if (Number.isFinite(days) && days > 0) return days;
  }
  return 1;
}

type Progress =
  | { kind: "reported"; pct: number; source: string | null; at: string | null }
  | { kind: "rolled"; pct: number; reported: number; leaves: number }
  | { kind: "none" };

// Progress for every row. Leaves report what the field reported and nothing
// more - a task with no approved report shows "no report" rather than a
// fabricated number, which is the whole point of sourcing the schedule from
// daily reports. Summary rows roll up their leaf descendants, weighted by
// duration, and say so.
function buildProgress(tasks: ScheduleTaskRow[]): Map<string, Progress> {
  const out = new Map<string, Progress>();
  const byPrefix = new Map<string, ScheduleTaskRow[]>();
  for (const t of tasks) {
    for (const other of tasks) {
      if (other.wbs_code === t.wbs_code) continue;
      if (!other.wbs_code.startsWith(t.wbs_code + ".")) continue;
      const list = byPrefix.get(t.wbs_code) ?? [];
      list.push(other);
      byPrefix.set(t.wbs_code, list);
    }
  }

  for (const t of tasks) {
    const descendants = byPrefix.get(t.wbs_code);
    if (!descendants?.length) {
      out.set(
        t.wbs_code,
        t.pct_complete != null
          ? {
              kind: "reported",
              pct: Number(t.pct_complete),
              source: t.status_source,
              at: t.last_dpr_at,
            }
          : { kind: "none" },
      );
      continue;
    }
    const leaves = descendants.filter((d) => !byPrefix.has(d.wbs_code));
    if (!leaves.length) { out.set(t.wbs_code, { kind: "none" }); continue; }
    let num = 0, den = 0, reported = 0;
    for (const leaf of leaves) {
      const w = weightOf(leaf);
      den += w;
      if (leaf.pct_complete != null) { num += Number(leaf.pct_complete) * w; reported++; }
    }
    out.set(t.wbs_code, {
      kind: "rolled",
      pct: den > 0 ? num / den : 0,
      reported,
      leaves: leaves.length,
    });
  }
  return out;
}

export function ScheduleTable({
  projectId,
  tasks,
  cpm,
  allTasks,
  calendar,
  constraintState,
  phase1Available,
}: Props) {
  const [phaseFilter, setPhaseFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [hideComplete, setHideComplete] = useState(false);
  const [hideInternal, setHideInternal] = useState(false);
  const [reportedOnly, setReportedOnly] = useState(false);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [slippingOnly, setSlippingOnly] = useState(false);
  const [blockedOnly, setBlockedOnly] = useState(false);

  const phaseOptions = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.phase).filter(Boolean))) as string[],
    [tasks],
  );
  const statusOptions = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.status).filter(Boolean))) as string[],
    [tasks],
  );

  const progress = useMemo(() => buildProgress(tasks), [tasks]);
  const anyBaseline = useMemo(() => tasks.some((t) => t.baseline_end), [tasks]);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      const c = cpm.byWbs.get(t.wbs_code);
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (statusFilter && t.status !== statusFilter) return false;
      if (hideComplete && t.status === "Complete") return false;
      if (hideInternal && t.is_internal) return false;
      if (reportedOnly && t.status_source !== "dpr") return false;
      if (criticalOnly && !c?.critical) return false;
      if (slippingOnly && !(c && c.slipDays > 0)) return false;
      if (blockedOnly && !(constraintState.get(t.wbs_code)?.open ?? 0)) return false;
      return true;
    });
  }, [
    tasks, cpm, phaseFilter, statusFilter, hideComplete,
    hideInternal, reportedOnly, criticalOnly, slippingOnly,
    blockedOnly, constraintState,
  ]);

  const counts = useMemo(() => {
    let critical = 0, nearCritical = 0, slipping = 0, blocked = 0;
    for (const t of tasks) {
      const c = cpm.byWbs.get(t.wbs_code);
      if (c?.critical) critical++;
      if (c?.nearCritical) nearCritical++;
      if (c && c.slipDays > 0) slipping++;
      if (constraintState.get(t.wbs_code)?.open) blocked++;
    }
    return { total: tasks.length, critical, nearCritical, slipping, blocked };
  }, [tasks, cpm, constraintState]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Tasks" value={counts.total} />
        <Stat label="On critical path" value={counts.critical} tone="destructive" />
        <Stat
          label="Near critical"
          value={counts.nearCritical}
          tone="amber"
          hint="5 working days of float or less - the tasks that become critical next"
        />
        <Stat label="Projected late" value={counts.slipping} tone="amber" />
        <Stat label="Blocked" value={counts.blocked} tone="destructive" hint="has an open constraint" />
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">Phase</label>
          <select
            value={phaseFilter}
            onChange={(e) => setPhaseFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">All</option>
            {phaseOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">All</option>
            {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <Check label="Critical only" checked={criticalOnly} onChange={setCriticalOnly} />
        <Check label="Slipping only" checked={slippingOnly} onChange={setSlippingOnly} />
        <Check label="Blocked only" checked={blockedOnly} onChange={setBlockedOnly} />
        <Check label="Field-reported only" checked={reportedOnly} onChange={setReportedOnly} />
        <Check label="Hide complete" checked={hideComplete} onChange={setHideComplete} />
        <Check label="Hide internal" checked={hideInternal} onChange={setHideInternal} />
        <span className="ml-auto text-xs text-muted-foreground">
          Showing {filtered.length} of {tasks.length}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-3 font-medium">Code</th>
              <th className="px-3 py-3 font-medium">Task</th>
              <th className="px-3 py-3 font-medium">Assigned</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="w-44 px-3 py-3 font-medium">Progress</th>
              <th className="px-3 py-3 font-medium">Start</th>
              <th className="px-3 py-3 font-medium">Finish</th>
              <th className="px-3 py-3 font-medium">Projected</th>
              <th className="px-3 py-3 text-right font-medium" title="Total float over free float. Total is how far the project can absorb; free is how far this task can move without touching a successor.">
                Float
              </th>
              {anyBaseline && <th className="px-3 py-3 text-right font-medium">vs Base</th>}
              <th className="px-3 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={anyBaseline ? 11 : 10} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No tasks match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((t) => {
                const indent = Math.max(0, (t.level_code ?? 1) - 1) * 14;
                const p = progress.get(t.wbs_code) ?? { kind: "none" as const };
                const c = cpm.byWbs.get(t.wbs_code);
                const isSummary = p.kind === "rolled";
                const variance =
                  t.baseline_end && t.end_date
                    ? workingDaysBetween(t.baseline_end, t.end_date, calendar)
                    : null;
                const blocked = constraintState.get(t.wbs_code);

                return (
                  <tr
                    key={t.id}
                    className={cn(
                      "hover:bg-muted/30",
                      c?.critical && "bg-destructive/5",
                      !c?.critical && c?.nearCritical && "bg-amber-50/50",
                    )}
                  >
                    <td className="px-3 py-2.5 font-mono text-xs">{t.wbs_code}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5" style={{ paddingLeft: indent }}>
                        {c?.isMilestone && (
                          <span
                            className="text-xs text-foreground/70"
                            title="Milestone - marks an instant, consumes no working days"
                          >
                            &#9670;
                          </span>
                        )}
                        <span className={cn("font-medium", isSummary && "text-muted-foreground")}>
                          {t.task_name}
                        </span>
                        {c?.critical && (
                          <span className="rounded bg-destructive/10 px-1 text-[10px] font-medium text-destructive">
                            CRITICAL
                          </span>
                        )}
                        {!c?.critical && c?.nearCritical && (
                          <span
                            className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-900"
                            title={`${c.totalFloat} working days of float - this becomes critical next`}
                          >
                            NEAR
                          </span>
                        )}
                        {c?.isolated && (
                          <span
                            className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground"
                            title="No predecessor and no successor. Its float is measured against itself, so it is neither critical nor safe - it is simply not connected to the job."
                          >
                            UNLINKED
                          </span>
                        )}
                        {t.date_constraint_type && (
                          <span
                            className="rounded bg-blue-100 px-1 text-[10px] font-medium text-blue-900"
                            title={`${t.date_constraint_type} ${t.date_constraint_date}`}
                          >
                            {t.date_constraint_type}
                          </span>
                        )}
                        {c?.constraintViolation && (
                          <span
                            className="rounded bg-destructive/10 px-1 text-[10px] font-medium text-destructive"
                            title={c.constraintViolation}
                          >
                            CONFLICT
                          </span>
                        )}
                        {blocked && blocked.open > 0 && (
                          <span
                            className={cn(
                              "rounded px-1 text-[10px] font-medium",
                              blocked.overdue > 0
                                ? "bg-destructive/10 text-destructive"
                                : "bg-amber-100 text-amber-900",
                            )}
                            title={
                              blocked.overdue > 0
                                ? `${blocked.open} open constraint${blocked.open === 1 ? "" : "s"}, ${blocked.overdue} past need-by`
                                : `${blocked.open} open constraint${blocked.open === 1 ? "" : "s"}${blocked.nextNeedBy ? `, next due ${blocked.nextNeedBy}` : ""}`
                            }
                          >
                            BLOCKED {blocked.open}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{t.assigned_to ?? "-"}</td>
                    <td className="px-3 py-2.5">
                      {t.status ? (
                        <span className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          STATUS_TONE[t.status] ?? "bg-muted text-muted-foreground",
                        )}>
                          {t.status}
                        </span>
                      ) : "-"}
                    </td>
                    <td className="px-3 py-2.5"><ProgressCell progress={p} /></td>
                    <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(t.start_date)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {t.end_date ? fmtDate(t.end_date) : <span className="text-amber-700">Needs date</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {c ? (
                        <div className="flex items-center gap-1.5">
                          <span className={cn(c.slipDays > 0 && "font-medium text-amber-700")}>
                            {fmtDate(c.projectedEnd)}
                          </span>
                          {c.slipDays > 0 && (
                            <span className="text-[11px] text-amber-700">+{c.slipDays}d</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {c ? (
                        <div>
                          <span className={cn(
                            c.isolated ? "text-muted-foreground"
                              : c.totalFloat <= 0 ? "font-medium text-destructive"
                              : c.nearCritical ? "text-amber-700"
                              : "text-muted-foreground",
                          )}>
                            {c.isolated ? "-" : `${c.totalFloat}d`}
                          </span>
                          {/* Free float only earns its place when it differs -
                              showing "5d / 5d" on every row is noise. */}
                          {!c.isolated && c.freeFloat !== c.totalFloat && (
                            <div
                              className="text-[11px] text-muted-foreground"
                              title="Free float - days this task can slip before it moves a successor"
                            >
                              {c.freeFloat}d free
                            </div>
                          )}
                        </div>
                      ) : <span className="text-muted-foreground">-</span>}
                    </td>
                    {anyBaseline && (
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {variance == null ? (
                          <span className="text-[11px] text-muted-foreground">no base</span>
                        ) : (
                          <span className={cn(
                            variance > 0 ? "font-medium text-destructive"
                              : variance < 0 ? "text-emerald-700"
                              : "text-muted-foreground",
                          )}>
                            {variance > 0 ? `+${variance}d` : variance < 0 ? `${variance}d` : "on"}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-right">
                      <TaskEditDialog
                        projectId={projectId}
                        task={t}
                        phaseOptions={phaseOptions}
                        statusOptions={statusOptions}
                        allTasks={allTasks}
                        phase1Available={phase1Available}
                        trigger={<Button variant="ghost" size="sm">Edit</Button>}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Progress comes from approved field reports only - a task with no approved
        report shows &ldquo;No report&rdquo; rather than an estimated percentage.
        Summary rows roll up their leaf tasks weighted by duration. Projected
        dates and float are calculated from the whole dependency network in
        working days, skipping weekends, holidays and any days recorded on the
        project calendar. Float is shown as total over free: total is how much
        the project can absorb, free is how far this task can move before it
        moves something else.
      </p>
    </div>
  );
}

function Check({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function ProgressCell({ progress }: { progress: Progress }) {
  if (progress.kind === "none") {
    return <span className="text-xs text-muted-foreground">No report</span>;
  }
  const pct = Math.max(0, Math.min(100, progress.pct));
  const rolled = progress.kind === "rolled";
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", rolled ? "bg-muted-foreground/50" : "bg-emerald-500")}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="w-9 text-right text-xs font-medium tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {rolled
          ? `Rolled up - ${progress.reported} of ${progress.leaves} reported`
          : progress.source === "dpr"
            ? <span className="text-emerald-700">Field report{progress.at ? ` ${fmtDate(progress.at.slice(0, 10))}` : ""}</span>
            : <span className="text-amber-700">Set manually</span>}
      </div>
    </div>
  );
}

function Stat({
  label, value, tone, hint,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "blue" | "destructive" | "amber";
  hint?: string;
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3 shadow-sm" title={hint}>
      <div className={cn(
        "text-2xl font-semibold tabular-nums",
        tone === "emerald" && "text-emerald-700",
        tone === "blue" && "text-blue-700",
        tone === "amber" && "text-amber-700",
        tone === "destructive" && "text-destructive",
      )}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
