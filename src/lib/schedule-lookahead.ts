// Three-week look-ahead, generated from the schedule.
//
// This is the artifact the field actually runs on. Dennis Brookman writes his
// by hand in Outlook every week; the schedule already holds everything it needs
// to produce one, so it should come out of the system and go back to the sub
// rather than arriving as prose that somebody re-keys.
//
// Weeks run Monday to Sunday and are built from PROJECTED dates, not planned
// ones. A look-ahead that shows work in the week it was originally supposed to
// happen, rather than the week it will actually happen, is worse than none.

import {
  isWorkingDay,
  parseIso,
  toIso,
  todayIso,
  type CalendarLike,
} from "@/lib/schedule-calendar";
import type { CpmOutput } from "@/lib/schedule-cpm";

const DAY_MS = 86_400_000;

export type LookaheadTask = {
  wbs: string;
  name: string;
  assignedTo: string | null;
  start: string;
  end: string;
  pctComplete: number | null;
  critical: boolean;
  totalFloat: number;
  slipDays: number;
  // True when the task is already under way as of the first week.
  continuing: boolean;
  // True when its finish falls inside this week - the commitment that matters.
  finishing: boolean;
};

export type LookaheadWeek = {
  weekStart: string;
  weekEnd: string;
  label: string;
  workingDays: string[];
  tasks: LookaheadTask[];
};

export function mondayOf(iso: string): string {
  const ms = parseIso(iso);
  const dow = new Date(ms).getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  return toIso(ms - back * DAY_MS);
}

function weekLabel(start: string, end: string): string {
  const f = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  };
  return `${f(start)} - ${f(end)}`;
}

export function buildLookahead(
  tasks: {
    wbs_code: string;
    task_name: string;
    assigned_to: string | null;
    pct_complete: number | null;
    status: string | null;
  }[],
  cpm: CpmOutput,
  opts: {
    weeks?: number;
    /** As-of date. Falls back to the CPM data date, then to today. */
    dataDate?: string;
    calendar?: CalendarLike;
  } = {},
): LookaheadWeek[] {
  const weeks = opts.weeks ?? 3;
  const dataDate = opts.dataDate ?? cpm.dataDate ?? todayIso();
  const calendar = opts.calendar ?? 5;
  const first = mondayOf(dataDate);

  const out: LookaheadWeek[] = [];
  for (let w = 0; w < weeks; w++) {
    const startMs = parseIso(first) + w * 7 * DAY_MS;
    const weekStart = toIso(startMs);
    const weekEnd = toIso(startMs + 6 * DAY_MS);

    const workingDays: string[] = [];
    for (let d = 0; d < 7; d++) {
      const day = toIso(startMs + d * DAY_MS);
      if (isWorkingDay(day, calendar)) workingDays.push(day);
    }

    const inWeek: LookaheadTask[] = [];
    for (const t of tasks) {
      const c = cpm.byWbs.get(t.wbs_code);
      if (!c) continue; // summary rows are not work
      if (t.status === "Complete") continue;

      // Overlap test against the projected window, not the planned one.
      const s = parseIso(c.projectedStart);
      const e = parseIso(c.projectedEnd);
      if (e < startMs || s > startMs + 6 * DAY_MS) continue;

      inWeek.push({
        wbs: t.wbs_code,
        name: t.task_name,
        assignedTo: t.assigned_to,
        start: c.projectedStart,
        end: c.projectedEnd,
        pctComplete: t.pct_complete,
        critical: c.critical,
        totalFloat: c.totalFloat,
        slipDays: c.slipDays,
        continuing: s < startMs,
        finishing: e >= startMs && e <= startMs + 6 * DAY_MS,
      });
    }

    // Critical work first, then whatever finishes this week, then by start.
    inWeek.sort((a, b) => {
      if (a.critical !== b.critical) return a.critical ? -1 : 1;
      if (a.finishing !== b.finishing) return a.finishing ? -1 : 1;
      if (a.start !== b.start) return a.start < b.start ? -1 : 1;
      return a.wbs.localeCompare(b.wbs);
    });

    out.push({
      weekStart,
      weekEnd,
      label: weekLabel(weekStart, weekEnd),
      workingDays,
      tasks: inWeek,
    });
  }
  return out;
}

// Plain-text look-ahead, formatted the way the subs already write them so it
// can be pasted straight into an email without anyone reformatting it.
export function lookaheadToText(
  weeks: LookaheadWeek[],
  projectName: string,
): string {
  const lines: string[] = [`${projectName} - ${weeks.length}-week look-ahead`, ""];
  for (const w of weeks) {
    lines.push(`*${w.label}`);
    if (!w.tasks.length) {
      lines.push("  (no scheduled work)");
    } else {
      for (const t of w.tasks) {
        const bits: string[] = [];
        if (t.continuing) bits.push("continuing");
        if (t.finishing) bits.push("complete this week");
        if (t.critical) bits.push("critical");
        if (t.pctComplete != null) bits.push(`at ${t.pctComplete}%`);
        lines.push(
          `  ${t.wbs}  ${t.name}${bits.length ? ` (${bits.join(", ")})` : ""}`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
