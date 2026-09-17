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
    if (c) next.set(t.wbs_code, { start: c.projectedStart, end: c.projectedEnd });
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
