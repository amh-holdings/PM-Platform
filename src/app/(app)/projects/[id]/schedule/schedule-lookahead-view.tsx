"use client";

import { Fragment, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  STALE_AFTER_DAYS,
  UNASSIGNED,
  buildLookahead,
  filterWeeks,
  groupBySection,
  lookaheadAssignees,
  lookaheadRows,
  lookaheadToPrintHtml,
  lookaheadToText,
  matchesAssignee,
  shortDate,
  staleDays,
  type LookaheadFlag,
  type LookaheadTask,
} from "@/lib/schedule-lookahead";
import { parseIso, todayIso, type CalendarLike } from "@/lib/schedule-calendar";
import type { CpmOutput } from "@/lib/schedule-cpm";
import type { TaskConstraintState } from "@/lib/schedule-constraints";

type Task = {
  wbs_code: string;
  task_name: string;
  assigned_to: string | null;
  pct_complete: number | null;
  status: string | null;
};

type Props = {
  tasks: Task[];
  cpm: CpmOutput;
  projectName: string;
  calendar: CalendarLike;
  constraintState: Map<string, TaskConstraintState>;
};

const FLAGS: { key: LookaheadFlag; label: string; tone: string }[] = [
  { key: "critical", label: "Critical", tone: "text-destructive" },
  { key: "blocked", label: "Blocked", tone: "text-destructive" },
  { key: "late", label: "Late", tone: "text-amber-700" },
  { key: "finishing", label: "Finishing this week", tone: "text-blue-700" },
];

function dowLetter(iso: string): string {
  return new Date(parseIso(iso)).toLocaleDateString("en-US", {
    weekday: "narrow",
    timeZone: "UTC",
  });
}

export function ScheduleLookaheadView({
  tasks,
  cpm,
  projectName,
  calendar,
  constraintState,
}: Props) {
  const [weeks, setWeeks] = useState(3);
  const [assignee, setAssignee] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [flag, setFlag] = useState<LookaheadFlag | null>(null);
  const [copied, setCopied] = useState(false);

  const today = todayIso();

  // Week one is the week we are in, not the week of the data date. The bars
  // still come from the projection; the banner below says when that is old.
  const lookahead = useMemo(
    () => buildLookahead(tasks, cpm, { weeks, calendar, dataDate: today }),
    [tasks, cpm, weeks, calendar, today],
  );
  const stale = staleDays(cpm.dataDate, today);

  const allRows = useMemo(() => lookaheadRows(lookahead), [lookahead]);
  const assignees = useMemo(() => lookaheadAssignees(allRows), [allRows]);
  const sections = useMemo(() => groupBySection(allRows), [allRows]);

  const isBlocked = (t: LookaheadTask) => (constraintState.get(t.wbs)?.open ?? 0) > 0;
  const hasFlag = (t: LookaheadTask, f: LookaheadFlag) =>
    f === "critical"
      ? t.critical
      : f === "blocked"
        ? isBlocked(t)
        : f === "late"
          ? t.slipDays > 0
          : t.finishing;

  // Assignee and section narrow what the counts are counted over; the flag
  // chip is the last cut, so its own count never reads zero after clicking.
  const baseKeep = (t: LookaheadTask) =>
    matchesAssignee(t, assignee) && !hidden.has(t.wbs.split(".")[0]);
  const base = allRows.filter(baseKeep);
  const counts = Object.fromEntries(
    FLAGS.map((f) => [f.key, base.filter((t) => hasFlag(t, f.key)).length]),
  ) as Record<LookaheadFlag, number>;
  const keep = (t: LookaheadTask) => baseKeep(t) && (!flag || hasFlag(t, flag));
  const rows = base.filter((t) => !flag || hasFlag(t, flag));
  const groups = groupBySection(rows);

  const days = lookahead.flatMap((w, i) =>
    w.workingDays.map((d, j) => ({ d, week: i, startsWeek: i > 0 && j === 0 })),
  );

  const assigneeLabel = assignee === UNASSIGNED ? "Unassigned" : assignee;
  const subtitle = [
    assignee ? assigneeLabel : "",
    flag ? FLAGS.find((f) => f.key === flag)!.label : "",
    hidden.size ? `excluding ${Array.from(hidden).sort().join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" - ");
  const filtered = filterWeeks(lookahead, keep);

  async function copy() {
    const text = lookaheadToText(
      filtered,
      subtitle ? `${projectName} (${subtitle})` : projectName,
    );
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  function print() {
    const html = lookaheadToPrintHtml(filtered, {
      projectName,
      subtitle,
      generated: shortDate(today),
    });
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    apply(next);
  };

  const cols = 5 + days.length;
  // Fewer weeks, wider days, so three weeks fills the table instead of
  // leaving the activity column to soak up the width.
  const dayWidth = weeks <= 2 ? "min-w-[3rem]" : weeks === 3 ? "min-w-[2.5rem]" : weeks === 4 ? "min-w-[2rem]" : "min-w-[1.5rem]";

  return (
    <div className="space-y-3">
      {stale > STALE_AFTER_DAYS && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          The schedule was last updated as of {shortDate(cpm.dataDate)} ({stale} days ago).
          The bars below are projected from that date, so check progress before sending
          this out.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border bg-card p-1">
          {[2, 3, 4, 6].map((w) => (
            <button
              key={w}
              onClick={() => setWeeks(w)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium",
                weeks === w ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {w} week
            </button>
          ))}
        </div>
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className="h-8 rounded-md border bg-card px-2 text-xs"
          aria-label="Filter by responsible party"
        >
          <option value="">Everyone</option>
          {assignees.map((a) => (
            <option key={a} value={a}>
              {a === UNASSIGNED ? "Unassigned" : a}
            </option>
          ))}
        </select>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy as text"}
        </Button>
        <Button variant="outline" size="sm" onClick={print}>
          Print / PDF
        </Button>
      </div>

      {/* What needs talking about. Each count filters to just those rows. */}
      <div className="flex flex-wrap items-center gap-2">
        {FLAGS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFlag(flag === f.key ? null : f.key)}
            disabled={counts[f.key] === 0 && flag !== f.key}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs disabled:opacity-40",
              flag === f.key ? "border-foreground bg-muted font-medium" : "bg-card hover:bg-muted",
            )}
          >
            <span className={cn("font-semibold", counts[f.key] > 0 && f.tone)}>
              {counts[f.key]}
            </span>{" "}
            {f.label}
          </button>
        ))}
        {flag && (
          <button onClick={() => setFlag(null)} className="text-xs text-muted-foreground underline">
            Show all
          </button>
        )}
      </div>

      {/* Which WBS sections to include. Off removes them from the screen,
          the copied text and the print, e.g. procurement in a field meeting. */}
      {sections.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Sections:</span>
          {sections.map((s) => {
            const off = hidden.has(s.code);
            return (
              <button
                key={s.code}
                onClick={() => toggle(hidden, s.code, setHidden)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px]",
                  off ? "bg-transparent text-muted-foreground line-through" : "bg-card font-medium",
                )}
                title={off ? "Show this section" : "Hide this section"}
              >
                {/* Code apart from the name: "0 Contracts" beside "0
                    Critical" read as a count of zero. */}
                <span className="font-mono text-muted-foreground">{s.code}</span>
                {s.label !== s.code && ` ${s.label.slice(s.code.length + 1)}`}
              </button>
            );
          })}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/40">
              <th rowSpan={2} className="border-b px-2 py-1.5 text-left font-semibold">WBS</th>
              <th rowSpan={2} className="min-w-[240px] border-b px-2 py-1.5 text-left font-semibold">Activity</th>
              <th rowSpan={2} className="border-b px-2 py-1.5 text-left font-semibold">Responsible</th>
              <th rowSpan={2} className="border-b px-2 py-1.5 text-left font-semibold">Start</th>
              <th rowSpan={2} className="border-b px-2 py-1.5 text-left font-semibold">Finish</th>
              {lookahead.map((w, i) => (
                <th
                  key={w.weekStart}
                  colSpan={Math.max(1, w.workingDays.length)}
                  className="border-b border-l px-1 py-1 text-center font-semibold"
                >
                  <div>{w.label}</div>
                  <div className="text-[10px] font-normal text-muted-foreground">
                    {i === 0 ? "This week" : `Week ${i + 1}`}
                  </div>
                </th>
              ))}
            </tr>
            <tr className="bg-muted/40">
              {days.map(({ d, startsWeek }) => (
                <th
                  key={d}
                  className={cn(
                    dayWidth,
                    "border-b px-0 py-0.5 text-center text-[10px] font-normal leading-tight text-muted-foreground",
                    startsWeek && "border-l",
                    d === today && "bg-primary/15 font-semibold text-foreground",
                  )}
                >
                  {dowLetter(d)}
                  <br />
                  {Number(d.slice(8))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr>
                <td colSpan={cols} className="px-3 py-8 text-center text-muted-foreground">
                  {allRows.length ? "No work matches these filters." : "No scheduled work in this window."}
                </td>
              </tr>
            )}
            {groups.map((sec) => {
              const isCollapsed = collapsed.has(sec.code);
              const critical = sec.tasks.filter((t) => t.critical).length;
              return (
                <Fragment key={sec.code}>
                  <tr className="bg-muted/60">
                    <td colSpan={cols} className="border-t px-2 py-1">
                      <button
                        onClick={() => toggle(collapsed, sec.code, setCollapsed)}
                        className="flex items-center gap-2 text-left font-semibold"
                      >
                        <span className="w-3 text-muted-foreground">{isCollapsed ? "▸" : "▾"}</span>
                        {sec.label}
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {sec.tasks.length} task{sec.tasks.length === 1 ? "" : "s"}
                        </span>
                        {critical > 0 && (
                          <span className="text-[10px] font-medium text-destructive">
                            {critical} critical
                          </span>
                        )}
                      </button>
                    </td>
                  </tr>
                  {!isCollapsed &&
                    sec.tasks.map((t) => {
                      const blocked = constraintState.get(t.wbs);
                      return (
                        <tr key={t.wbs} className="border-t align-top hover:bg-muted/20">
                          <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                            {t.wbs}
                          </td>
                          <td className="px-2 py-1.5">
                            {/* The parent names it: a dozen rows read "Lead
                                Time", and the branch says which equipment. */}
                            {t.parent && (
                              <div className="truncate text-[10px] text-muted-foreground" title={t.parent}>
                                {t.parent}
                              </div>
                            )}
                            <div className="font-medium leading-tight">{t.name}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px]">
                              {t.critical && (
                                <span className="rounded bg-destructive/10 px-1 font-medium text-destructive">
                                  CRITICAL
                                </span>
                              )}
                              {!t.critical && t.totalFloat > 0 && t.totalFloat <= 5 && (
                                <span className="rounded bg-amber-100 px-1 font-medium text-amber-900">
                                  NEAR
                                </span>
                              )}
                              {blocked && blocked.open > 0 && (
                                <span
                                  className={cn(
                                    "rounded px-1 font-medium",
                                    blocked.overdue > 0
                                      ? "bg-destructive/10 text-destructive"
                                      : "bg-amber-100 text-amber-900",
                                  )}
                                  title={
                                    blocked.nextNeedBy
                                      ? `${blocked.open} open, next needed by ${blocked.nextNeedBy}`
                                      : `${blocked.open} open constraint${blocked.open === 1 ? "" : "s"}`
                                  }
                                >
                                  BLOCKED {blocked.open}
                                </span>
                              )}
                              {t.pctComplete != null && (
                                <span className="text-emerald-700">at {t.pctComplete}%</span>
                              )}
                              {t.slipDays > 0 && <span className="text-amber-700">{t.slipDays}d late</span>}
                              {t.finishing && (
                                <span className="font-medium text-blue-700">finishes this week</span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">{t.assignedTo ?? "-"}</td>
                          <td className="whitespace-nowrap px-2 py-1.5">
                            {shortDate(t.start)}
                            {t.continuing && (
                              <div className="text-[10px] text-muted-foreground">under way</div>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5">{shortDate(t.end)}</td>
                          {days.map(({ d, startsWeek }, i) => {
                            const on = d >= t.start && d <= t.end;
                            const prevOn = i > 0 && days[i - 1].d >= t.start && days[i - 1].d <= t.end;
                            const nextOn =
                              i < days.length - 1 && days[i + 1].d >= t.start && days[i + 1].d <= t.end;
                            return (
                              <td
                                key={d}
                                className={cn(
                                  "px-0 py-1.5 align-middle",
                                  startsWeek && "border-l",
                                  d === today && "bg-primary/10",
                                )}
                              >
                                {on && (
                                  <div
                                    className={cn(
                                      "h-3",
                                      t.critical ? "bg-destructive/80" : "bg-blue-500/70",
                                      !prevOn && "ml-0.5 rounded-l",
                                      !nextOn && "mr-0.5 rounded-r",
                                    )}
                                  />
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Bars are projected dates, so work shows in the week it will actually happen. Red is
        critical path.
      </p>
    </div>
  );
}
