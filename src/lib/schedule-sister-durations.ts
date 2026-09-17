// Durations learned from sister tasks.
//
// Sweet Springs builds two sediment basins out of the same seven steps, and
// both were scheduled with placeholder durations - Embankment at one day, then
// two. Basin 1's took eighteen. Basin 2 still says two, and every date behind
// it is built on that.
//
// A sister is a task with the same name under a sibling summary: Basin 1
// Embankment (5.1.1.6.5) and Basin 2 Embankment (5.1.1.7.5), Build Basin 1
// Dewatering and Build Basin 2 Dewatering. When one sister has shown how long
// the work really takes, the others are measured against it.
//
// Suggestions only. Applying one is a person's decision, because two tasks
// with the same name are not always the same size of job.

import { durationInWorkingDays, parseIso, type CalendarLike } from "@/lib/schedule-calendar";
import { leavesOf, type CpmInput } from "@/lib/schedule-cpm";

export type SisterSuggestion = {
  wbs: string;
  current: number | null;
  suggested: number;
  fromWbs: string;
  /** "took" for a finished sister, "tracking" for one nearly done. */
  basis: "took" | "tracking";
};

// A sister is trusted once it is finished, or nearly so with a recent report -
// early in a task the rate is too noisy to size another task off.
const TRACKING_MIN_PCT = 90;
// Below this gap the durations are close enough to leave alone.
const MIN_GAP_DAYS = 2;
const MIN_GAP_RATIO = 1.5;

function parentOf(wbs: string): string {
  const i = wbs.lastIndexOf(".");
  return i === -1 ? "" : wbs.slice(0, i);
}

function norm(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isComplete(t: CpmInput): boolean {
  return t.status === "Complete" || Number(t.pct_complete ?? 0) >= 100;
}

/** What a task has shown its work takes, or null when it has not shown enough. */
function measuredDuration(t: CpmInput, cal: CalendarLike): { days: number; basis: SisterSuggestion["basis"] } | null {
  if (!t.start_date) return null;
  if (isComplete(t)) {
    if (!t.end_date || parseIso(t.end_date) < parseIso(t.start_date)) return null;
    return { days: durationInWorkingDays(t.start_date, t.end_date, cal), basis: "took" };
  }
  const pct = Number(t.pct_complete ?? 0);
  if (pct < TRACKING_MIN_PCT || !t.last_progress_date) return null;
  if (parseIso(t.last_progress_date) < parseIso(t.start_date)) return null;
  const elapsed = durationInWorkingDays(t.start_date, t.last_progress_date, cal);
  return { days: Math.max(1, Math.round((elapsed * 100) / pct)), basis: "tracking" };
}

export function sisterDurationSuggestions(
  allTasks: CpmInput[],
  opts: { calendar?: CalendarLike } = {},
): SisterSuggestion[] {
  const leaves = leavesOf(allTasks);
  const out: SisterSuggestion[] = [];

  for (const target of leaves) {
    if (isComplete(target) || target.is_milestone || target.duration_days === 0) continue;
    const parent = parentOf(target.wbs_code);
    const grand = parentOf(parent);
    if (!parent) continue;

    // Sisters: same name, different parent, same grandparent.
    let best: { t: CpmInput; m: NonNullable<ReturnType<typeof measuredDuration>> } | null = null;
    for (const s of leaves) {
      if (s.wbs_code === target.wbs_code) continue;
      const sp = parentOf(s.wbs_code);
      if (sp === parent || parentOf(sp) !== grand) continue;
      if (norm(s.task_name) !== norm(target.task_name)) continue;
      const m = measuredDuration(s, opts.calendar);
      if (!m) continue;
      // A finished sister outranks one still tracking.
      if (!best || (m.basis === "took" && best.m.basis !== "took")) best = { t: s, m };
    }
    if (!best) continue;

    const current = target.duration_days ?? null;
    const suggested = best.m.days;
    if (current != null) {
      const gap = Math.abs(suggested - current);
      const ratio = Math.max(suggested, current) / Math.max(1, Math.min(suggested, current));
      if (gap < MIN_GAP_DAYS || ratio < MIN_GAP_RATIO) continue;
    }
    out.push({
      wbs: target.wbs_code,
      current,
      suggested,
      fromWbs: best.t.wbs_code,
      basis: best.m.basis,
    });
  }
  return out;
}
