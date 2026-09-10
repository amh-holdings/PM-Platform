"use client";

// The timeline half of the schedule: geometry, the month header, and one row
// of bars.
//
// Split out of the Gantt so the bars can sit beside the editable grid rather
// than on a tab of their own. That separation was the whole reading problem:
// the columns that tell you a task's float were on one screen and the bar that
// shows you when it runs was on another, so adjusting a date meant leaving the
// view that told you whether the date was wrong.
//
// Everything here is presentational and driven by props. The state that
// matters - what is selected, what is collapsed, what is unsaved - belongs to
// the view that composes these, because the grid and the bars have to agree
// about it exactly.

import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { parseIso, toIso } from "@/lib/schedule-calendar";
import type { CpmResult } from "@/lib/schedule-cpm";

export const DAY_MS = 86_400_000;

/** Height of one row, shared by the grid and the bars so they line up. */
export const ROW_H = 30;

/** Height of the header strip, likewise shared. */
export const HEADER_H = 36;

export const ZOOMS = [
  { label: "Fit", px: 0 },
  { label: "Month", px: 3 },
  { label: "Week", px: 9 },
  { label: "Day", px: 26 },
] as const;

export type BarTask = {
  id: string;
  wbs_code: string;
  task_name: string;
  start_date: string | null;
  end_date: string | null;
  baseline_start?: string | null;
  baseline_end?: string | null;
  pct_complete: number | null;
};

export function shortDate(iso: string | null): string {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

export type Geometry = {
  min: number;
  max: number;
  days: number;
  dayPx: number;
  width: number;
  xOf: (iso: string) => number;
  wOf: (a: string, b: string) => number;
  months: { iso: string; x: number; label: string }[];
  /** Week boundaries, only worth drawing once a day is wide enough to see. */
  weeks: { iso: string; x: number; label: string }[];
};

/**
 * Pixel geometry for the timeline.
 *
 * The span covers every date the chart has to show, including projected
 * finishes, which reach past the planned dates whenever the job is running
 * late. "Fit" divides the available width across the span rather than using a
 * fixed per-day size, so a 13-month schedule and a 3-week one both land on
 * screen.
 */
export function useGanttGeometry(
  dates: readonly (string | null | undefined)[],
  zoom: number,
  availableWidth: number,
): Geometry {
  return useMemo(() => {
    const all: number[] = [];
    for (const d of dates) if (d) all.push(parseIso(d));
    if (!all.length) {
      const noop = () => 0;
      return {
        min: 0, max: 0, days: 1, dayPx: 1, width: 600,
        xOf: noop, wOf: () => 1, months: [], weeks: [],
      };
    }
    const min = Math.min(...all) - 3 * DAY_MS;
    const max = Math.max(...all) + 3 * DAY_MS;
    const days = Math.round((max - min) / DAY_MS) + 1;
    const dayPx = ZOOMS[zoom].px || Math.max(1.5, Math.max(availableWidth, 400) / Math.max(days, 1));
    const width = Math.max(600, days * dayPx);

    const xOf = (iso: string) => ((parseIso(iso) - min) / DAY_MS) * dayPx;
    const wOf = (a: string, b: string) =>
      Math.max(dayPx * 0.8, ((parseIso(b) - parseIso(a)) / DAY_MS + 1) * dayPx);

    const months: Geometry["months"] = [];
    {
      const d = new Date(min);
      let cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      while (cur <= max) {
        const iso = toIso(cur);
        months.push({ iso, x: xOf(iso), label: monthLabel(iso) });
        const nd = new Date(cur);
        cur = Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() + 1, 1);
      }
    }

    // Week rules and day-of-month numbers, so a bar can be read to the day
    // instead of guessed at between two month rules. Only drawn when a day is
    // wide enough that the labels are not a smear.
    const weeks: Geometry["weeks"] = [];
    if (dayPx >= 6) {
      let cur = min;
      // Step to the first Monday at or after the start of the span.
      const dow = new Date(cur).getUTCDay();
      cur += ((8 - dow) % 7) * DAY_MS;
      while (cur <= max) {
        const iso = toIso(cur);
        weeks.push({ iso, x: xOf(iso), label: String(new Date(cur).getUTCDate()) });
        cur += 7 * DAY_MS;
      }
    }

    return { min, max, days, dayPx, width, xOf, wOf, months, weeks };
  }, [dates, zoom, availableWidth]);
}

/** The month strip, and the week numbers under it once they fit. */
export function TimelineHeader({ geo }: { geo: Geometry }) {
  return (
    <div
      className="sticky top-0 z-20 border-b bg-muted/60 backdrop-blur"
      style={{ height: HEADER_H }}
    >
      {geo.months.map((m) => (
        <div
          key={m.iso}
          className="absolute top-0 border-l border-border/60 px-1.5 pt-1 text-[11px] font-medium text-muted-foreground"
          style={{ left: m.x }}
        >
          {m.label}
        </div>
      ))}
      {geo.weeks.map((w) => (
        <div
          key={w.iso}
          className="absolute bottom-0.5 text-[9px] tabular-nums text-muted-foreground/70"
          style={{ left: w.x + 1 }}
        >
          {w.label}
        </div>
      ))}
    </div>
  );
}

/** The vertical rules behind the bars: months, weeks, today, the data date. */
export function TimelineGrid({
  geo,
  today,
  dataDate,
}: {
  geo: Geometry;
  today: string;
  dataDate: string;
}) {
  const todayX = geo.xOf(today);
  const asOfX = geo.xOf(dataDate);
  return (
    <>
      {geo.months.map((m) => (
        <div
          key={m.iso}
          className="absolute top-0 bottom-0 w-px bg-border/60"
          style={{ left: m.x }}
        />
      ))}
      {geo.weeks.map((w) => (
        <div
          key={w.iso}
          className="absolute top-0 bottom-0 w-px bg-border/25"
          style={{ left: w.x }}
        />
      ))}
      {todayX >= 0 && todayX <= geo.width && (
        <div
          className="absolute top-0 bottom-0 z-10 w-px bg-blue-500"
          style={{ left: todayX }}
          title={`Today ${today}`}
        />
      )}
      {/* The data date, when it is not today. Every float and projection on the
          page is calculated from this line, so on a back-dated update it
          matters more than today does. */}
      {dataDate !== today && asOfX >= 0 && asOfX <= geo.width && (
        <div
          className="absolute top-0 bottom-0 z-10 w-px bg-violet-600"
          style={{ left: asOfX }}
          title={`Data date ${dataDate} - every calculation is as of here`}
        />
      )}
    </>
  );
}

export type BarRowProps = {
  task: BarTask;
  cpm: CpmResult | undefined;
  geo: Geometry;
  /** Dates to draw, which may be a pending drag or an unsaved edit. */
  start: string | null;
  end: string | null;
  /** True when what is drawn differs from what the database holds. */
  moved: boolean;
  editable: boolean;
  collapsed: boolean;
  onBeginDrag?: (e: React.MouseEvent, mode: "move" | "resize") => void;
};

/**
 * One row of bars.
 *
 * A summary has no dates of its own worth dragging - it spans its children -
 * so it draws as a thin spanning bar and refuses the pointer. A milestone is
 * an instant and draws as a diamond, because a one-day-wide rectangle reads as
 * work.
 */
export function BarRow({
  task,
  cpm,
  geo,
  start,
  end,
  moved,
  editable,
  collapsed,
  onBeginDrag,
}: BarRowProps) {
  const isSummary = !cpm;
  const pct = Math.max(0, Math.min(100, Number(task.pct_complete ?? 0)));
  const canDrag = editable && !isSummary && !!start && !!end;

  // A projected finish beyond the planned one is drawn as an amber tail so the
  // slip is visible without reading a number.
  const slipTail =
    cpm && end && !moved && parseIso(cpm.projectedEnd) > parseIso(end)
      ? { from: end, to: cpm.projectedEnd }
      : null;

  return (
    <>
      {task.baseline_start && task.baseline_end && (
        <div
          className="absolute rounded-sm bg-muted-foreground/30"
          style={{
            left: geo.xOf(task.baseline_start),
            width: geo.wOf(task.baseline_start, task.baseline_end),
            top: ROW_H - 8,
            height: 3,
          }}
          title={`Baseline ${shortDate(task.baseline_start)} - ${shortDate(task.baseline_end)}`}
        />
      )}

      {/* Where the bar was before this drag, so the size of the move is
          visible while making it. */}
      {moved && task.start_date && task.end_date && (
        <div
          className="absolute rounded-sm border border-dashed border-muted-foreground/50"
          style={{
            left: geo.xOf(task.start_date),
            width: geo.wOf(task.start_date, task.end_date),
            top: 7,
            height: 13,
          }}
          title={`Was ${shortDate(task.start_date)} - ${shortDate(task.end_date)}`}
        />
      )}

      {slipTail && (
        <div
          className="absolute rounded-r-sm bg-amber-400/70"
          style={{
            left: geo.xOf(slipTail.from),
            width: geo.wOf(slipTail.from, slipTail.to),
            top: 8,
            height: 11,
          }}
          title={`Projected finish ${shortDate(slipTail.to)} (${cpm!.slipDays} working days late)`}
        />
      )}

      {start && cpm?.isMilestone && (
        <div
          onMouseDown={(e) => onBeginDrag?.(e, "move")}
          className={cn(
            "absolute rotate-45",
            cpm.critical ? "bg-destructive" : "bg-foreground/80",
            editable && "cursor-grab active:cursor-grabbing",
          )}
          style={{ left: geo.xOf(start) - 4, width: 9, height: 9, top: ROW_H / 2 - 5 }}
          title={`${task.wbs_code} ${task.task_name}\nMilestone ${shortDate(start)}\nFloat ${cpm.totalFloat}d`}
        />
      )}

      {start && end && !cpm?.isMilestone && (
        <div
          onMouseDown={(e) => canDrag && onBeginDrag?.(e, "move")}
          className={cn(
            "absolute rounded-sm",
            isSummary
              ? "bg-foreground/70"
              : cpm?.critical
                ? "bg-destructive/80"
                : cpm?.nearCritical
                  ? "bg-amber-500/80"
                  : "bg-blue-500/80",
            moved && "ring-2 ring-amber-500",
            canDrag && "cursor-grab active:cursor-grabbing",
          )}
          style={{
            left: geo.xOf(start),
            width: geo.wOf(start, end),
            top: isSummary ? 11 : 8,
            height: isSummary ? 6 : 11,
          }}
          title={
            `${task.wbs_code} ${task.task_name}\n${shortDate(start)} - ${shortDate(end)}` +
            (cpm
              ? `\nFloat ${cpm.totalFloat}d total, ${cpm.freeFloat}d free${cpm.critical ? " (critical)" : cpm.nearCritical ? " (near critical)" : ""}`
              : collapsed
                ? "\nCollapsed branch - expand to drag the tasks inside it"
                : "\nSummary - spans the tasks beneath it")
          }
        >
          <div className="h-full overflow-hidden rounded-sm">
            {!isSummary && pct > 0 && (
              <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
            )}
          </div>
          {canDrag && (
            <div
              onMouseDown={(e) => onBeginDrag?.(e, "resize")}
              className="absolute -right-1 top-0 h-full w-2 cursor-ew-resize"
              title="Drag to change the finish date"
            />
          )}
        </div>
      )}

      {!start && !end && cpm && (
        <div
          className="absolute rounded-sm border border-dashed border-amber-500 bg-amber-100/50"
          style={{
            left: geo.xOf(cpm.projectedStart),
            width: geo.wOf(cpm.projectedStart, cpm.projectedEnd),
            top: 8,
            height: 11,
          }}
          title="No planned dates - showing projection only"
        />
      )}
    </>
  );
}

export function Legend() {
  const items = [
    { cls: "bg-blue-500/80", label: "Planned" },
    { cls: "bg-emerald-500", label: "Complete" },
    { cls: "bg-destructive/80", label: "Critical path" },
    { cls: "bg-amber-500/80", label: "Near critical" },
    { cls: "bg-amber-400/70", label: "Projected slip" },
    { cls: "bg-muted-foreground/30", label: "Baseline" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className={cn("inline-block h-2 w-4 rounded-sm", i.cls)} />
          {i.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rotate-45 bg-foreground/80" />
        Milestone
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-px bg-blue-500" />
        Today
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-px bg-violet-600" />
        Data date
      </span>
    </div>
  );
}
