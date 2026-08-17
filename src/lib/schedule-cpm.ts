// Critical path method over the schedule.
//
// Two passes run over the same dependency graph:
//
//   planned    - what the schedule says, ignoring progress. Produces early and
//                late dates, total and free float, and the critical path.
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
//
// Everything is calculated as of a DATA DATE, not as of today. An update that
// recalculates itself every time it is opened cannot be reproduced, compared
// against the previous update, or defended in a claim. The data date defaults
// to today so a project that has never set one behaves as before.

import {
  addWorkingDays,
  advance,
  durationInWorkingDays,
  parseIso,
  retreat,
  snapForward,
  subWorkingDays,
  todayIso,
  toCalendar,
  workingDaysBetween,
  type CalendarLike,
  type Calendar,
} from "@/lib/schedule-calendar";

export type RelType = "FS" | "SS" | "FF" | "SF";

// Hard date bounds, in the P6 sense. A task's start_date is a soft preference -
// the plan - and can be pushed by logic. A constraint cannot: it is the
// interconnection window, the permit expiry, the date in the contract.
export type DateConstraintType =
  | "SNET" // Start No Earlier Than
  | "SNLT" // Start No Later Than
  | "FNET" // Finish No Earlier Than
  | "FNLT" // Finish No Later Than
  | "MSO"  // Must Start On
  | "MFO"; // Must Finish On

export const DATE_CONSTRAINT_TYPES: DateConstraintType[] = [
  "SNET", "SNLT", "FNET", "FNLT", "MSO", "MFO",
];

export const DATE_CONSTRAINT_LABELS: Record<DateConstraintType, string> = {
  SNET: "Start no earlier than",
  SNLT: "Start no later than",
  FNET: "Finish no earlier than",
  FNLT: "Finish no later than",
  MSO: "Must start on",
  MFO: "Must finish on",
};

// The four DCMA counts as "hard" - they pin a date outright rather than
// bounding one side of it, and they can make float meaningless.
export const HARD_CONSTRAINTS = new Set<DateConstraintType>([
  "MSO", "MFO", "SNLT", "FNLT",
]);

export type CpmInput = {
  wbs_code: string;
  task_name?: string | null;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
  predecessors: string | null;
  pct_complete: number | null;
  status: string | null;
  is_milestone?: boolean | null;
  date_constraint_type?: string | null;
  date_constraint_date?: string | null;
};

export type Link = { pred: string; type: RelType; lag: number };

export type CpmResult = {
  wbs: string;
  duration: number;
  isMilestone: boolean;
  // Planned pass
  es: string;
  ef: string;
  ls: string;
  lf: string;
  totalFloat: number;
  // Days this task can slip without moving ANY successor's early start. Total
  // float says the project can absorb five days; free float says the foreman
  // can take two without phoning anyone. They are different questions and the
  // second is the one asked in the field.
  freeFloat: number;
  critical: boolean;
  nearCritical: boolean;
  // No predecessor and no successor. Such a task is its own late date, so it
  // computes to zero float - but zero float here means "measured against
  // nothing", not "driving the finish". Reporting it as critical put Fencing
  // Installation and Permit Closeout on the critical path of the civil scope
  // alongside the four tasks actually driving it.
  isolated: boolean;
  // Projected pass
  projectedStart: string;
  projectedEnd: string;
  slipDays: number;
  drivenBy: string | null;
  // Set when a hard constraint and the logic disagree.
  constraintViolation: string | null;
};

export type CpmOutput = {
  byWbs: Map<string, CpmResult>;
  dataDate: string;
  plannedFinish: string | null;
  projectedFinish: string | null;
  finishSlipDays: number;
  criticalPath: string[];
  cycle: string[] | null;
  unscheduled: string[];
  // Tasks with no logic on either side. They do not set the project finish;
  // surfacing them is how the missing links get noticed and fixed.
  isolated: string[];
  constraintViolations: { wbs: string; message: string }[];
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

export function isMilestoneTask(t: CpmInput): boolean {
  return !!t.is_milestone || t.duration_days === 0;
}

function durationOf(t: CpmInput, cal: Calendar): number {
  // A milestone marks an instant. It consumes no working time, so its start
  // and finish are the same day and it cannot itself be the reason anything
  // is late - only the logic through it can.
  if (isMilestoneTask(t)) return 0;
  if (t.duration_days != null && t.duration_days > 0) return t.duration_days;
  if (t.start_date && t.end_date)
    return durationInWorkingDays(t.start_date, t.end_date, cal);
  return 1;
}

function constraintOf(
  t: CpmInput,
): { type: DateConstraintType; date: string } | null {
  const type = t.date_constraint_type as DateConstraintType | null | undefined;
  const date = t.date_constraint_date;
  if (!type || !date) return null;
  if (!DATE_CONSTRAINT_TYPES.includes(type)) return null;
  return { type, date };
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
  if (duration === 0) return 0;
  const pct = Math.max(0, Math.min(100, Number(t.pct_complete ?? 0)));
  return Math.max(1, Math.ceil(duration * (1 - pct / 100)));
}

// Given a finish date and a duration, the start that produces it.
function backIntoStart(finish: string, duration: number, cal: Calendar): string {
  return subWorkingDays(finish, Math.max(0, duration - 1), cal);
}

// The earliest START a link permits for the successor, given where the
// predecessor lands. One function so the forward pass, the projected pass and
// the free-float calculation cannot drift apart - which is exactly how the
// backward pass came to ignore lag on SS, FF and SF links.
function candidateStart(
  type: RelType,
  lag: number,
  predStart: string,
  predEnd: string,
  succDuration: number,
  cal: Calendar,
): string {
  switch (type) {
    case "SS":
      // succ.ES >= pred.ES + lag
      return advance(predStart, lag, cal);
    case "FF":
      // succ.EF >= pred.EF + lag; back into the start that produces it.
      return backIntoStart(advance(predEnd, lag, cal), succDuration, cal);
    case "SF":
      // succ.EF >= pred.ES + lag
      return backIntoStart(advance(predStart, lag, cal), succDuration, cal);
    default:
      // FS - succ.ES >= pred.EF + 1 + lag, the working day after it finishes.
      return advance(predEnd, 1 + lag, cal);
  }
}

// The latest FINISH a link permits for the predecessor, given where the
// successor's late dates land. The exact mirror of candidateStart, which is
// the property the previous implementation lost: it dropped the lag term on
// SS, FF and SF, and read the successor's late START rather than its late
// FINISH on SF. Any schedule using overlapping logic - which after the civil
// review is most of Sweet Springs - had wrong float and therefore a wrong
// critical path.
function candidateFinish(
  type: RelType,
  lag: number,
  succLs: string,
  succLf: string,
  predDuration: number,
  cal: Calendar,
): string {
  switch (type) {
    case "SS":
      // pred.LS <= succ.LS - lag
      return addWorkingDays(retreat(succLs, lag, cal), predDuration, cal);
    case "FF":
      // pred.LF <= succ.LF - lag
      return retreat(succLf, lag, cal);
    case "SF":
      // pred.LS <= succ.LF - lag
      return addWorkingDays(retreat(succLf, lag, cal), predDuration, cal);
    default:
      // FS - pred.LF <= succ.LS - 1 - lag
      return retreat(succLs, 1 + lag, cal);
  }
}

export type CpmOptions = {
  calendar?: CalendarLike;
  /** As-of date. Defaults to today. */
  dataDate?: string;
  /** @deprecated use dataDate */
  today?: string;
  /** Float at or below this, but above zero, reads as near-critical. */
  nearCriticalDays?: number;
};

export function computeCpm(
  allTasks: CpmInput[],
  opts: CpmOptions = {},
): CpmOutput {
  const cal = toCalendar(opts.calendar ?? 5);
  const dataDate = opts.dataDate ?? opts.today ?? todayIso();
  const nearCriticalDays = opts.nearCriticalDays ?? 5;

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
  const constraintViolations: { wbs: string; message: string }[] = [];

  if (cycle) {
    return {
      byWbs: results,
      dataDate,
      plannedFinish: null,
      projectedFinish: null,
      finishSlipDays: 0,
      criticalPath: [],
      cycle,
      unscheduled: [],
      isolated: [],
      constraintViolations: [],
    };
  }

  const dur = new Map<string, number>();
  const cons = new Map<string, { type: DateConstraintType; date: string } | null>();
  for (const t of tasks) {
    dur.set(t.wbs_code, durationOf(t, cal));
    cons.set(t.wbs_code, constraintOf(t));
  }

  const violationOf = new Map<string, string>();
  const flag = (wbs: string, message: string) => {
    if (violationOf.has(wbs)) return;
    violationOf.set(wbs, message);
    constraintViolations.push({ wbs, message });
  };

  // ---- forward pass, planned ----
  const es = new Map<string, string>();
  const ef = new Map<string, string>();
  for (const wbs of order) {
    const t = byWbs.get(wbs)!;
    const d = dur.get(wbs)!;
    let start = t.start_date ? snapForward(t.start_date, cal) : null;

    for (const l of links.get(wbs) ?? []) {
      const ps = es.get(l.pred);
      const pe = ef.get(l.pred);
      if (!ps || !pe) continue;
      const candidate = candidateStart(l.type, l.lag, ps, pe, d, cal);
      if (!start || parseIso(candidate) > parseIso(start)) start = candidate;
    }

    if (!start) { unscheduled.push(wbs); start = snapForward(dataDate, cal); }

    // Hard constraints are applied AFTER logic, and a constraint that pulls a
    // task earlier than its logic allows is reported rather than obeyed. The
    // engine will not invent a sequence that cannot be built; it says the two
    // disagree and leaves the call to a human.
    const c = cons.get(wbs);
    if (c) {
      const logicStart = start;
      if (c.type === "SNET") {
        const bound = snapForward(c.date, cal);
        if (parseIso(bound) > parseIso(start)) start = bound;
      } else if (c.type === "MSO") {
        const bound = snapForward(c.date, cal);
        if (parseIso(bound) < parseIso(logicStart)) {
          flag(wbs, `Must start on ${c.date}, but its predecessors do not free it until ${logicStart}.`);
        }
        start = bound;
      } else if (c.type === "MFO") {
        const bound = snapForward(c.date, cal);
        const forced = backIntoStart(bound, d, cal);
        if (parseIso(forced) < parseIso(logicStart)) {
          flag(wbs, `Must finish on ${c.date}, which requires starting ${forced}, but its predecessors do not free it until ${logicStart}.`);
        }
        start = forced;
      }
    }

    es.set(wbs, start);
    let finish = addWorkingDays(start, d, cal);

    if (c) {
      if (c.type === "FNET") {
        const bound = snapForward(c.date, cal);
        if (parseIso(bound) > parseIso(finish)) {
          finish = bound;
          es.set(wbs, backIntoStart(bound, d, cal));
        }
      } else if (c.type === "MFO") {
        finish = snapForward(c.date, cal);
      } else if (c.type === "SNLT" && parseIso(start) > parseIso(c.date)) {
        flag(wbs, `Start no later than ${c.date}, but the earliest it can start is ${start}.`);
      } else if (c.type === "FNLT" && parseIso(finish) > parseIso(c.date)) {
        flag(wbs, `Finish no later than ${c.date}, but the earliest it can finish is ${finish}.`);
      }
    }

    ef.set(wbs, finish);
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
  const isolatedSet = new Set(
    order.filter(
      (w) => (links.get(w) ?? []).length === 0 && (successors.get(w) ?? []).length === 0,
    ),
  );
  const isolated = Array.from(isolatedSet);
  const networked = order.filter((w) => !isolatedSet.has(w));
  const finishFrom = networked.length ? networked : order;

  const plannedFinish =
    finishFrom.length > 0
      ? finishFrom.map((w) => ef.get(w)!).sort((a, b) => parseIso(b) - parseIso(a))[0]
      : null;

  const lf = new Map<string, string>();
  const lsMap = new Map<string, string>();
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
      const candidate = candidateFinish(s.type, s.lag, sLs, sLf, d, cal);
      if (!latestFinish || parseIso(candidate) < parseIso(latestFinish))
        latestFinish = candidate;
    }

    // A late-side constraint caps the late dates. This is what makes negative
    // float appear where it should: an FNLT the logic cannot meet drives the
    // whole chain behind it negative, which is the signal that the date is at
    // risk rather than merely tight.
    const c = cons.get(wbs);
    if (c) {
      let bound: string | null = null;
      if (c.type === "FNLT" || c.type === "MFO") bound = c.date;
      else if (c.type === "SNLT" || c.type === "MSO")
        bound = addWorkingDays(c.date, d, cal);
      if (bound && (!latestFinish || parseIso(bound) < parseIso(latestFinish)))
        latestFinish = bound;
    }

    const finish = latestFinish ?? ef.get(wbs)!;
    lf.set(wbs, finish);
    lsMap.set(wbs, backIntoStart(finish, d, cal));
  }

  // ---- free float ----
  // How far this task can move before it moves a successor. With no successors
  // it is bounded by the project finish instead, which is total float.
  const freeFloat = new Map<string, number>();
  for (const wbs of order) {
    const succs = successors.get(wbs) ?? [];
    if (!succs.length) {
      freeFloat.set(wbs, workingDaysBetween(ef.get(wbs)!, lf.get(wbs)!, cal));
      continue;
    }
    let min: number | null = null;
    for (const s of succs) {
      const sEs = es.get(s.succ);
      if (!sEs) continue;
      const required = candidateStart(
        s.type, s.lag, es.get(wbs)!, ef.get(wbs)!, dur.get(s.succ)!, cal,
      );
      const slack = workingDaysBetween(required, sEs, cal);
      if (min === null || slack < min) min = slack;
    }
    freeFloat.set(wbs, min ?? 0);
  }

  // ---- forward pass, projected from field progress ----
  const pStart = new Map<string, string>();
  const pEnd = new Map<string, string>();
  const drivenBy = new Map<string, string | null>();
  const workStart = snapForward(dataDate, cal);

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

    // Earliest this task could start given only its own plan and the data date.
    let start = started
      ? (t.start_date ?? workStart)
      : snapForward(t.start_date ?? workStart, cal);
    if (!started && parseIso(start) < parseIso(workStart)) start = workStart;

    // A predecessor can only push a task later, never earlier.
    let depStart: string | null = null;
    let driver: string | null = null;
    for (const l of links.get(wbs) ?? []) {
      const predEnd = pEnd.get(l.pred);
      const predStart = pStart.get(l.pred);
      if (!predEnd || !predStart) continue;
      const candidate = candidateStart(l.type, l.lag, predStart, predEnd, d, cal);
      if (!depStart || parseIso(candidate) > parseIso(depStart)) {
        depStart = candidate;
        driver = l.pred;
      }
    }

    let end: string;
    if (started) {
      // Under way. The plan stands while its finish is still ahead of the data
      // date; only once that date has passed do we forecast from remaining work.
      end =
        plannedEnd && parseIso(plannedEnd) >= parseIso(workStart)
          ? plannedEnd
          : addWorkingDays(workStart, remainingDuration(t, d), cal);
    } else {
      // Not started. If a predecessor pushes it, or its own start has already
      // slipped past, it runs its full duration from wherever it can begin.
      if (depStart && parseIso(depStart) > parseIso(start)) start = depStart;
      end =
        plannedEnd &&
        parseIso(start) <= parseIso(t.start_date ?? start) &&
        parseIso(plannedEnd) >= parseIso(start)
          ? plannedEnd
          : addWorkingDays(start, d, cal);
    }

    // A dependency landing after the forecast finish drags the finish with it.
    if (depStart && parseIso(depStart) > parseIso(end)) {
      end = addWorkingDays(depStart, d, cal);
      if (!started) start = depStart;
    }

    // Early-side constraints hold in the projection too - a task cannot be
    // forecast to start before the window that lets it start at all.
    const c = cons.get(wbs);
    if (c && !started) {
      if (c.type === "SNET" || c.type === "MSO") {
        const bound = snapForward(c.date, cal);
        if (parseIso(bound) > parseIso(start)) {
          start = bound;
          end = addWorkingDays(start, d, cal);
        }
      }
    }
    if (c && (c.type === "FNET" || c.type === "MFO")) {
      const bound = snapForward(c.date, cal);
      if (parseIso(bound) > parseIso(end)) end = bound;
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
    const totalFloat = workingDaysBetween(ef.get(wbs)!, lf.get(wbs)!, cal);
    // Free float can never exceed total float. Imposed start dates can make the
    // raw successor slack read higher, which would tell a foreman he has room
    // the project does not have.
    const free = Math.min(freeFloat.get(wbs) ?? totalFloat, totalFloat);
    const loose = isolatedSet.has(wbs);
    results.set(wbs, {
      wbs,
      duration: dur.get(wbs)!,
      isMilestone: isMilestoneTask(t),
      isolated: loose,
      es: es.get(wbs)!,
      ef: ef.get(wbs)!,
      ls: lsMap.get(wbs)!,
      lf: lf.get(wbs)!,
      totalFloat,
      freeFloat: free,
      critical: totalFloat <= 0 && !loose,
      nearCritical: !loose && totalFloat > 0 && totalFloat <= nearCriticalDays,
      projectedStart: pStart.get(wbs)!,
      projectedEnd: pEnd.get(wbs)!,
      slipDays: t.end_date
        ? workingDaysBetween(t.end_date, pEnd.get(wbs)!, cal)
        : 0,
      drivenBy: drivenBy.get(wbs) ?? null,
      constraintViolation: violationOf.get(wbs) ?? null,
    });
  }

  const criticalPath = order
    .filter((w) => !isolatedSet.has(w) && results.get(w)?.critical)
    .sort((a, b) => parseIso(es.get(a)!) - parseIso(es.get(b)!));

  return {
    byWbs: results,
    dataDate,
    plannedFinish,
    projectedFinish,
    finishSlipDays:
      plannedFinish && projectedFinish
        ? workingDaysBetween(plannedFinish, projectedFinish, cal)
        : 0,
    criticalPath,
    cycle: null,
    unscheduled,
    isolated,
    constraintViolations,
  };
}
