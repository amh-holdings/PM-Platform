// Critical path method over the schedule.
//
// Two passes run over the same dependency graph:
//
//   planned    - what the schedule says, ignoring progress. Produces early and
//                late dates, total float, and the critical path.
//   projected  - what the field says, driven by approved report percentages.
//                A task half done with its finish date behind it pushes every
//                successor, which is what makes a slip visible the day it
//                happens instead of at the next monthly.
//
// Only leaf tasks take part. Summary rows have no duration of their own and
// including them would double-count every dependency they inherit.
//
// Predecessors are WBS codes with an optional relationship suffix and lag:
//   "5.1.1.1"        finish-to-start
//   "5.1.2.1SS"      start-to-start
//   "5.1.1.2FF+3"    finish-to-finish with three days of lag
// A reference to a task that no longer exists is skipped rather than treated
// as a missing constraint, so trimming the schedule cannot silently free up
// a task to start on day one.

import {
  addWorkingDays,
  durationInWorkingDays,
  parseIso,
  snapForward,
  todayIso,
  workingDaysBetween,
  type WorkWeek,
} from "@/lib/schedule-calendar";

export type RelType = "FS" | "SS" | "FF" | "SF";

export type CpmInput = {
  wbs_code: string;
  task_name?: string | null;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
  predecessors: string | null;
  pct_complete: number | null;
  status: string | null;
};

export type Link = { pred: string; type: RelType; lag: number };

export type CpmResult = {
  wbs: string;
  duration: number;
  // Planned pass
  es: string;
  ef: string;
  ls: string;
  lf: string;
  totalFloat: number;
  critical: boolean;
  // Projected pass
  projectedStart: string;
  projectedEnd: string;
  slipDays: number;
  drivenBy: string | null;
};

export type CpmOutput = {
  byWbs: Map<string, CpmResult>;
  plannedFinish: string | null;
  projectedFinish: string | null;
  finishSlipDays: number;
  criticalPath: string[];
  cycle: string[] | null;
  unscheduled: string[];
  // Tasks with no logic on either side. They do not set the project finish;
  // surfacing them is how the missing links get noticed and fixed.
  isolated: string[];
};

const REL_RE = /^([0-9.]+?)(FS|SS|FF|SF)?([+-]\d+)?$/i;

export function parsePredecessors(raw: string | null | undefined): Link[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const m = token.match(REL_RE);
      if (!m) return null;
      return {
        pred: m[1],
        type: (m[2]?.toUpperCase() as RelType) ?? "FS",
        lag: m[3] ? Number(m[3]) : 0,
      };
    })
    .filter((l): l is Link => l !== null);
}

export function serializeLink(l: Link): string {
  const type = l.type === "FS" ? "" : l.type;
  const lag = l.lag === 0 ? "" : l.lag > 0 ? `+${l.lag}` : `${l.lag}`;
  return `${l.pred}${type}${lag}`;
}

export function serializeLinks(links: Link[]): string | null {
  return links.length ? links.map(serializeLink).join(", ") : null;
}

// Would this set of predecessors close a loop? Run before saving, so a broken
// network cannot be written in the first place. The engine detects cycles too,
// but by then the whole schedule has already stopped calculating dates.
//
// Returns the tasks caught in the loop, or null when the edit is safe.
export function findCycleWith(
  tasks: { wbs_code: string; predecessors: string | null }[],
  editedWbs: string,
  editedLinks: Link[],
): string[] | null {
  const known = new Set(tasks.map((t) => t.wbs_code));
  const links = new Map<string, Link[]>();
  for (const t of tasks) {
    const l =
      t.wbs_code === editedWbs ? editedLinks : parsePredecessors(t.predecessors);
    links.set(t.wbs_code, l.filter((x) => known.has(x.pred)));
  }
  return topoSort(Array.from(known), links).cycle;
}

// A task is a leaf when no other task's WBS sits beneath it.
export function leavesOf<T extends { wbs_code: string }>(tasks: T[]): T[] {
  return tasks.filter(
    (t) => !tasks.some((o) => o.wbs_code !== t.wbs_code && o.wbs_code.startsWith(t.wbs_code + ".")),
  );
}

function durationOf(t: CpmInput, workWeek: WorkWeek): number {
  if (t.duration_days != null && t.duration_days > 0) return t.duration_days;
  if (t.start_date && t.end_date)
    return durationInWorkingDays(t.start_date, t.end_date, workWeek);
  return 1;
}

// Kahn's algorithm. Returns null when the graph contains a cycle, along with
// the tasks still holding unmet dependencies - which is what the user needs to
// see to break it.
function topoSort(
  nodes: string[],
  links: Map<string, Link[]>,
): { order: string[]; cycle: string[] | null } {
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  const succ = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const n of nodes) {
    for (const l of links.get(n) ?? []) {
      if (!indeg.has(l.pred)) continue;
      indeg.set(n, (indeg.get(n) ?? 0) + 1);
      succ.get(l.pred)!.push(n);
    }
  }
  const queue = nodes.filter((n) => (indeg.get(n) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const s of succ.get(n) ?? []) {
      indeg.set(s, (indeg.get(s) ?? 0) - 1);
      if ((indeg.get(s) ?? 0) === 0) queue.push(s);
    }
  }
  if (order.length !== nodes.length)
    return { order, cycle: nodes.filter((n) => (indeg.get(n) ?? 0) > 0) };
  return { order, cycle: null };
}

function isComplete(t: CpmInput): boolean {
  return t.status === "Complete" || Number(t.pct_complete ?? 0) >= 100;
}

function hasStarted(t: CpmInput): boolean {
  return Number(t.pct_complete ?? 0) > 0 || t.status === "In Progress";
}

// Remaining duration for work already under way, used only to forecast a task
// that is ALREADY LATE. A percentage reports progress, not productivity: a task
// at 85% of a ten-day duration has not earned the right to finish in a day and
// a half. So this is never used to pull a finish date earlier than the plan -
// see the projected pass, which holds the planned finish while it is still in
// the future and only forecasts from remaining work once it has passed.
function remainingDuration(t: CpmInput, duration: number): number {
  if (isComplete(t)) return 0;
  const pct = Math.max(0, Math.min(100, Number(t.pct_complete ?? 0)));
  return Math.max(1, Math.ceil(duration * (1 - pct / 100)));
}

export function computeCpm(
  allTasks: CpmInput[],
  opts: { workWeek?: WorkWeek; today?: string } = {},
): CpmOutput {
  const workWeek = opts.workWeek ?? 5;
  const today = opts.today ?? todayIso();

  const tasks = leavesOf(allTasks);
  const byWbs = new Map(tasks.map((t) => [t.wbs_code, t]));
  const known = new Set(tasks.map((t) => t.wbs_code));

  const links = new Map<string, Link[]>();
  for (const t of tasks) {
    links.set(
      t.wbs_code,
      parsePredecessors(t.predecessors).filter((l) => known.has(l.pred)),
    );
  }

  const { order, cycle } = topoSort(Array.from(known), links);
  const results = new Map<string, CpmResult>();
  const unscheduled: string[] = [];

  if (cycle) {
    return {
      byWbs: results,
      plannedFinish: null,
      projectedFinish: null,
      finishSlipDays: 0,
      criticalPath: [],
      cycle,
      unscheduled: [],
      isolated: [],
    };
  }

  const dur = new Map<string, number>();
  for (const t of tasks) dur.set(t.wbs_code, durationOf(t, workWeek));

  // ---- forward pass, planned ----
  const es = new Map<string, string>();
  const ef = new Map<string, string>();
  for (const wbs of order) {
    const t = byWbs.get(wbs)!;
    const d = dur.get(wbs)!;
    const ls = t.start_date;
    let start = ls ? snapForward(ls, workWeek) : null;

    for (const l of links.get(wbs) ?? []) {
      const pStart = es.get(l.pred);
      const pEnd = ef.get(l.pred);
      if (!pStart || !pEnd) continue;
      let candidate: string;
      switch (l.type) {
        case "SS":
          candidate = addWorkingDays(pStart, 1 + l.lag, workWeek);
          break;
        case "FF":
          // Finish no earlier than the predecessor's finish; back into a start.
          candidate = addWorkingDays(pEnd, 1 + l.lag, workWeek);
          candidate = backIntoStart(candidate, d, workWeek);
          break;
        case "SF":
          candidate = backIntoStart(addWorkingDays(pStart, 1 + l.lag, workWeek), d, workWeek);
          break;
        default:
          candidate = addWorkingDays(pEnd, 2 + l.lag, workWeek);
      }
      if (!start || parseIso(candidate) > parseIso(start)) start = candidate;
    }

    if (!start) { unscheduled.push(wbs); start = snapForward(today, workWeek); }
    es.set(wbs, start);
    ef.set(wbs, addWorkingDays(start, d, workWeek));
  }

  // ---- backward pass ----
  const successors = new Map<string, { succ: string; type: RelType; lag: number }[]>();
  for (const wbs of order) successors.set(wbs, []);
  for (const wbs of order)
    for (const l of links.get(wbs) ?? [])
      successors.get(l.pred)?.push({ succ: wbs, type: l.type, lag: l.lag });

  // A task with no predecessors and no successors is a free-floating milestone,
  // not work. Sweet Springs carries "Permit Closeout" pinned to July 2027 with
  // nothing tying it to the job; letting it set the project finish gave every
  // real task about 230 days of float and made the critical path a single
  // milestone. The finish is taken from tasks that are actually part of the
  // network, and the loose milestones are reported separately.
  const isolated = order.filter(
    (w) => (links.get(w) ?? []).length === 0 && (successors.get(w) ?? []).length === 0,
  );
  const networked = order.filter((w) => !isolated.includes(w));
  const finishFrom = networked.length ? networked : order;

  const plannedFinish =
    finishFrom.length > 0
      ? finishFrom.map((w) => ef.get(w)!).sort((a, b) => parseIso(b) - parseIso(a))[0]
      : null;

  const lf = new Map<string, string>();
  const lsMap = new Map<string, string>();
  const isolatedSet = new Set(isolated);
  for (const wbs of order.slice().reverse()) {
    const d = dur.get(wbs)!;
    // An isolated milestone sits outside the network, so measuring it against
    // the work finish is meaningless - Permit Closeout nine months out would
    // read as 204 days behind. It is its own late date, giving it zero float
    // and keeping it off the critical path.
    let latestFinish = isolatedSet.has(wbs) ? ef.get(wbs)! : plannedFinish;
    for (const s of successors.get(wbs) ?? []) {
      const sLs = lsMap.get(s.succ);
      const sLf = lf.get(s.succ);
      if (!sLs || !sLf) continue;
      let candidate: string;
      switch (s.type) {
        case "SS":
          candidate = addWorkingDays(backIntoStart(sLs, 1, workWeek), d, workWeek);
          break;
        case "FF":
          candidate = sLf;
          break;
        case "SF":
          candidate = sLs;
          break;
        default:
          candidate = subWorkingDays(sLs, 1 + s.lag, workWeek);
      }
      if (!latestFinish || parseIso(candidate) < parseIso(latestFinish))
        latestFinish = candidate;
    }
    const finish = latestFinish ?? ef.get(wbs)!;
    lf.set(wbs, finish);
    lsMap.set(wbs, backIntoStart(finish, d, workWeek));
  }

  // ---- forward pass, projected from field progress ----
  const pStart = new Map<string, string>();
  const pEnd = new Map<string, string>();
  const drivenBy = new Map<string, string | null>();
  const workStart = snapForward(today, workWeek);

  for (const wbs of order) {
    const t = byWbs.get(wbs)!;
    const d = dur.get(wbs)!;

    if (isComplete(t)) {
      // Finished. Hold the recorded dates; nothing downstream waits on it.
      pStart.set(wbs, t.start_date ?? es.get(wbs)!);
      pEnd.set(wbs, t.end_date ?? ef.get(wbs)!);
      drivenBy.set(wbs, null);
      continue;
    }

    const started = hasStarted(t);
    const plannedEnd = t.end_date;

    // Earliest this task could start given only its own plan and today.
    let start = started
      ? (t.start_date ?? workStart)
      : snapForward(t.start_date ?? workStart, workWeek);
    if (!started && parseIso(start) < parseIso(workStart)) start = workStart;

    // A predecessor can only push a task later, never earlier.
    let depStart: string | null = null;
    let driver: string | null = null;
    for (const l of links.get(wbs) ?? []) {
      const predEnd = pEnd.get(l.pred);
      const predStart = pStart.get(l.pred);
      if (!predEnd || !predStart) continue;
      let candidate: string;
      switch (l.type) {
        case "SS":
          candidate = addWorkingDays(predStart, 1 + l.lag, workWeek);
          break;
        case "FF":
          candidate = backIntoStart(addWorkingDays(predEnd, 1 + l.lag, workWeek), d, workWeek);
          break;
        case "SF":
          candidate = backIntoStart(addWorkingDays(predStart, 1 + l.lag, workWeek), d, workWeek);
          break;
        default:
          candidate = addWorkingDays(predEnd, 2 + l.lag, workWeek);
      }
      if (!depStart || parseIso(candidate) > parseIso(depStart)) {
        depStart = candidate;
        driver = l.pred;
      }
    }

    let end: string;
    if (started) {
      // Under way. The plan stands while its finish is still ahead of us;
      // only once that date has passed do we forecast from remaining work.
      end =
        plannedEnd && parseIso(plannedEnd) >= parseIso(workStart)
          ? plannedEnd
          : addWorkingDays(workStart, remainingDuration(t, d), workWeek);
    } else {
      // Not started. If a predecessor pushes it, or its own start has already
      // slipped past, it runs its full duration from wherever it can begin.
      if (depStart && parseIso(depStart) > parseIso(start)) start = depStart;
      end =
        plannedEnd &&
        parseIso(start) <= parseIso(t.start_date ?? start) &&
        parseIso(plannedEnd) >= parseIso(start)
          ? plannedEnd
          : addWorkingDays(start, d, workWeek);
    }

    // A dependency landing after the forecast finish drags the finish with it.
    if (depStart && parseIso(depStart) > parseIso(end)) {
      end = addWorkingDays(depStart, d, workWeek);
      if (!started) start = depStart;
    }

    pStart.set(wbs, start);
    pEnd.set(wbs, end);
    drivenBy.set(wbs, driver);
  }

  const projectedFinish =
    finishFrom.length > 0
      ? finishFrom.map((w) => pEnd.get(w)!).sort((a, b) => parseIso(b) - parseIso(a))[0]
      : null;

  for (const wbs of order) {
    const t = byWbs.get(wbs)!;
    const totalFloat = workingDaysBetween(ef.get(wbs)!, lf.get(wbs)!, workWeek);
    results.set(wbs, {
      wbs,
      duration: dur.get(wbs)!,
      es: es.get(wbs)!,
      ef: ef.get(wbs)!,
      ls: lsMap.get(wbs)!,
      lf: lf.get(wbs)!,
      totalFloat,
      critical: totalFloat <= 0,
      projectedStart: pStart.get(wbs)!,
      projectedEnd: pEnd.get(wbs)!,
      slipDays: t.end_date
        ? workingDaysBetween(t.end_date, pEnd.get(wbs)!, workWeek)
        : 0,
      drivenBy: drivenBy.get(wbs) ?? null,
    });
  }

  const criticalPath = order
    .filter((w) => !isolatedSet.has(w) && results.get(w)?.critical)
    .sort((a, b) => parseIso(es.get(a)!) - parseIso(es.get(b)!));

  return {
    byWbs: results,
    plannedFinish,
    projectedFinish,
    finishSlipDays:
      plannedFinish && projectedFinish
        ? workingDaysBetween(plannedFinish, projectedFinish, workWeek)
        : 0,
    criticalPath,
    cycle: null,
    unscheduled,
    isolated,
  };
}

// Given a finish date and a duration, the start that produces it.
function backIntoStart(finish: string, duration: number, workWeek: WorkWeek): string {
  return subWorkingDays(finish, Math.max(0, duration - 1), workWeek);
}

function subWorkingDays(iso: string, days: number, workWeek: WorkWeek): string {
  let ms = parseIso(iso);
  let left = days;
  while (left > 0) {
    ms -= 86_400_000;
    const d = new Date(ms).toISOString().slice(0, 10);
    if (isWorking(d, workWeek)) left--;
  }
  let out = new Date(ms).toISOString().slice(0, 10);
  while (!isWorking(out, workWeek)) {
    ms -= 86_400_000;
    out = new Date(ms).toISOString().slice(0, 10);
  }
  return out;
}

// Local alias so the backward pass does not import the calendar twice.
function isWorking(iso: string, workWeek: WorkWeek): boolean {
  const dow = new Date(parseIso(iso)).getUTCDay();
  if (dow === 0) return false;
  if (dow === 6 && workWeek === 5) return false;
  return snapForward(iso, workWeek) === iso;
}
