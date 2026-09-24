// Keep a task's Start and Finish equal to what the schedule forecasts right now.
//
// The schedule used to carry three sets of dates: a baseline, a "plan" in
// start_date / end_date that only moved when someone pressed Reflow, and a
// live projection beside it. Phil's call on 2026-09-17: the platform is not
// ready for baselines, and a plan that sits on last week's dates while the
// forecast column moves reads as a schedule that is not updating. So Start and
// Finish ARE the forecast, rewritten from approved field reports and the logic
// every time it could have changed. A baseline can be layered back on top later
// - it has its own columns and nothing here touches them.
//
// This is the old Reflow button, run automatically. It is a fixed point: the
// projection of a synced schedule is the schedule itself, so running it twice
// writes nothing the second time. That property is what makes it safe to run on
// every page load, and the tests hold it to that.
//
// What this means for editing. A task with predecessors takes its dates from
// them - set its duration and its links, not its start. A date that genuinely
// cannot move (a mobilization, a delivery, a permit window) is a date
// constraint. A task with no predecessors keeps the dates typed on it, and a
// started task keeps its actual start.

import { type CalendarLike } from "@/lib/schedule-calendar";
import { computeCpm, leavesOf, type CpmInput } from "@/lib/schedule-cpm";

export type DateSync = { wbs: string; start: string; end: string };

export function planScheduleSync(
  allTasks: CpmInput[],
  opts: { calendar?: CalendarLike; dataDate: string },
): DateSync[] {
  const cpm = computeCpm(allTasks, { calendar: opts.calendar, dataDate: opts.dataDate });
  // A loop in the logic means there is no forecast to sync to. Leave the dates
  // alone; the schedule page already says the network is broken.
  if (cpm.cycle) return [];

  const leaves = leavesOf(allTasks);
  const next = new Map<string, { start: string; end: string }>();
  for (const t of leaves) {
    const c = cpm.byWbs.get(t.wbs_code);
    if (!c) continue;
    // A deliverable that is past due keeps the dates it was given. Its forecast
    // has rolled up to the data date - the package could arrive tomorrow - but
    // writing that back would overwrite the date the engineer committed to, and
    // a day later it would overwrite it again. The commitment is the record;
    // the roll is the forecast, and successors already read the forecast.
    if (c.forecastBasis === "overdue" && t.start_date && t.end_date) {
      next.set(t.wbs_code, { start: t.start_date, end: t.end_date });
      continue;
    }
    next.set(t.wbs_code, { start: c.projectedStart, end: c.projectedEnd });
  }

  // A summary row spans its work. Its own stored dates are display only - the
  // engine never reads them - so they follow the leaves beneath it.
  const leafCodes = Array.from(next.keys());
  for (const s of allTasks) {
    if (next.has(s.wbs_code)) continue;
    const kids = leafCodes
      .filter((w) => w.startsWith(s.wbs_code + "."))
      .map((w) => next.get(w)!);
    if (!kids.length) continue;
    next.set(s.wbs_code, {
      start: kids.map((k) => k.start).sort()[0],
      end: kids.map((k) => k.end).sort().pop()!,
    });
  }

  const out: DateSync[] = [];
  for (const t of allTasks) {
    const n = next.get(t.wbs_code);
    if (!n) continue;
    if (n.start === t.start_date && n.end === t.end_date) continue;
    out.push({ wbs: t.wbs_code, start: n.start, end: n.end });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A typed date the forecast is about to take back.
//
// Zarina, four rounds into this: "Still not reflecting." The save banner read
// "4.4.2.2 Delivery: Start Oct 5, 26, Finish Oct 5, 26" and the row still said
// Nov 18. Both were true. The write landed, and then the schedule page ran
// this sync on the next load and put the forecast back, because 4.4.2.2 takes
// its dates from a predecessor.
//
// That is the design above and it is the right one: a schedule whose dates
// ignore its own logic is a spreadsheet. What was wrong is that nothing said
// so. She typed a date, was told it saved, and watched it revert, with the
// only explanation buried in a source comment.
//
// So a save that writes a date the forecast will recompute now says what will
// happen and what would actually hold it.
// ---------------------------------------------------------------------------

export type ForecastOverwrite = {
  wbs: string;
  taskName: string | null;
  /** What was just saved. */
  typed: { start: string | null; end: string | null };
  /** What the next page load will put back. */
  forecast: { start: string; end: string };
};

/**
 * Which of the dates just written will not survive the next sync.
 *
 * Run over the task set as it stands AFTER the save, so it answers the only
 * question that matters: given what is now stored, what will the forecast
 * change back? A row the sync agrees with is not reported, which is why a
 * task with no predecessors never appears here.
 */
export function datesTheForecastWillReplace(input: {
  /** Every task, with the just-saved values already applied. */
  allTasks: CpmInput[];
  /** WBS codes whose start or end this save wrote. */
  touchedWbs: readonly string[];
  calendar?: CalendarLike;
  dataDate: string;
}): ForecastOverwrite[] {
  if (input.touchedWbs.length === 0) return [];
  const touched = new Set(input.touchedWbs);
  const plan = planScheduleSync(input.allTasks, {
    calendar: input.calendar,
    dataDate: input.dataDate,
  });
  const byWbs = new Map(input.allTasks.map((t) => [t.wbs_code, t]));

  const out: ForecastOverwrite[] = [];
  for (const entry of plan) {
    if (!touched.has(entry.wbs)) continue;
    const task = byWbs.get(entry.wbs);
    out.push({
      wbs: entry.wbs,
      taskName: (task as { task_name?: string | null } | undefined)?.task_name ?? null,
      typed: { start: task?.start_date ?? null, end: task?.end_date ?? null },
      forecast: { start: entry.start, end: entry.end },
    });
  }
  return out;
}

/**
 * One line for the save banner, or null when every date will hold.
 *
 * Names the row, what is coming back, and the two things that would actually
 * make a date stick. Telling somebody their edit will be undone without
 * telling them what to do instead is only half an answer.
 */
export function describeForecastOverwrite(
  overwrites: readonly ForecastOverwrite[],
  formatDate: (iso: string) => string,
): string | null {
  if (overwrites.length === 0) return null;
  const first = overwrites[0];
  const name = `${first.wbs}${first.taskName ? ` ${first.taskName}` : ""}`;
  const more =
    overwrites.length > 1
      ? ` The same goes for ${overwrites.length - 1} other row${overwrites.length - 1 === 1 ? "" : "s"}.`
      : "";
  // Two reasons a date gets taken back, and the wording has to cover both: the
  // row is driven by a predecessor, or its start is behind the data date and
  // no field report says it began, so the forecast rolls it forward. Naming
  // only links would send somebody hunting for a predecessor that is not there.
  return (
    `Heads up: the forecast will put ${name} back to ` +
    `${formatDate(first.forecast.start)} - ${formatDate(first.forecast.end)} ` +
    `on the next load. Start and Finish follow the logic and the data date, so ` +
    `a typed date only holds on a row nothing drives. To pin this one, set a ` +
    `date constraint on it; otherwise change the duration, the link, or report ` +
    `it started.${more}`
  );
}
