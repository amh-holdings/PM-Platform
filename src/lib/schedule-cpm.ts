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
  snapBack,
  snapForward,
  subWorkingDays,
  todayIso,
  toCalendar,
  workingDaysBetween,
  type CalendarLike,
  type Calendar,
} from "@/lib/schedule-calendar";
import { finishIsACommitment } from "@/lib/schedule-task-type";

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
  /** "construction" | "deliverable" (0051). Null = not classified. */
  task_type?: string | null;
  date_constraint_type?: string | null;
  date_constraint_date?: string | null;
  // Progress history (schedule-progress-history.ts). Optional: a caller that
  // does not load it gets the plan-based forecast, which holds the dates the
  // live sync last wrote - so the answers agree either way.
  last_report_date?: string | null;
  last_progress_date?: string | null;
  status_source?: string | null;
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
  // How the projected finish was reached, for a started task: "pace" from its
  // reported rate of progress, "plan" from its duration, "held" on its own
  // finish date. Null for work not under way.
  forecastBasis: "pace" | "plan" | "held" | "committed" | "overdue" | null;
  // Working days a deliverable is past the date it was committed to, counted
  // at the data date. Zero for everything else - a construction activity that
  // is running long shows as slip against its own forecast, not as a package
  // that has not turned up.
  daysOverdue: number;
  // Set when a hard constraint and the logic disagree.
  constraintViolation: string | null;
  // Links this task's reported progress has already broken - it started before
  // an FS predecessor finished, say. The projection believes the field over
  // the logic; this is the record that it had to.
  outOfSequence: Link[];
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
  outOfSequence: { wbs: string; pred: string; type: RelType }[];
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
    // A summary link is really a link to everything under it, so the loop
    // check has to see it that way or a cycle through a branch gets through.
    links.set(
      t.wbs_code,
      expandSummaryLinks(l, tasks).filter((x) => known.has(x.pred)),
    );
  }
  return topoSort(Array.from(known), links).cycle;
}

// A task is a leaf when no other task's WBS sits beneath it.
export function leavesOf<T extends { wbs_code: string }>(tasks: T[]): T[] {
  return tasks.filter(
    (t) => !tasks.some((o) => o.wbs_code !== t.wbs_code && o.wbs_code.startsWith(t.wbs_code + ".")),
  );
}

// ---------------------------------------------------------------------------
// Linking to a whole branch.
//
// Zarina: "Should show parent line suggestion as well so they represent once
// all child task are done it will trigger a line."
//
// The picker only ever offered leaves, and the engine only ever scheduled
// them, so naming a summary as a predecessor did nothing at all. That also
// meant a row vanished from the picker the moment somebody added a child under
// it, which is what "we can't add predecessors that are just recently added"
// was: not the new row missing, the row it was added under.
//
// A summary predecessor means the branch. Finish-to-start against 4.4.7 is
// "after everything under 4.4.7 is finished", which is one link per leaf
// underneath - the engine already takes the latest of several predecessors, so
// fanning out says exactly that with no new machinery.
//
// Start-to-start and start-to-finish are NOT expanded this way. Against a
// branch they mean its EARLIEST start, and a fan-out takes the latest, so it
// would quietly schedule the opposite of what was asked. The editor does not
// offer them on a summary.
// ---------------------------------------------------------------------------

/** Relationship types a summary predecessor can carry. */
export const SUMMARY_REL_TYPES: RelType[] = ["FS", "FF"];

export function summaryCodesOf<T extends { wbs_code: string }>(
  tasks: T[],
): Set<string> {
  const codes = tasks.map((t) => t.wbs_code);
  const summaries = new Set<string>();
  for (const code of codes) {
    if (codes.some((o) => o !== code && o.startsWith(code + "."))) {
      summaries.add(code);
    }
  }
  return summaries;
}

export function leafCodesUnder<T extends { wbs_code: string }>(
  code: string,
  tasks: T[],
): string[] {
  const leaves = new Set(leavesOf(tasks).map((t) => t.wbs_code));
  return tasks
    .map((t) => t.wbs_code)
    .filter((c) => c.startsWith(code + ".") && leaves.has(c))
    .sort();
}

/**
 * Rewrite a task's links so a summary predecessor points at its leaves.
 *
 * A branch with nothing schedulable under it drops the link rather than
 * inventing one, the same way an unresolvable code always has. A duplicate -
 * the same leaf reached directly and through its parent - keeps the stronger
 * lag, because two links to one task is one constraint and the tighter of the
 * two is the real one.
 */
export function expandSummaryLinks<T extends { wbs_code: string }>(
  links: readonly Link[],
  tasks: T[],
): Link[] {
  const summaries = summaryCodesOf(tasks);
  if (summaries.size === 0) return [...links];

  const out: Link[] = [];
  const byPred = new Map<string, number>();
  const push = (link: Link) => {
    const key = `${link.pred}|${link.type}`;
    const at = byPred.get(key);
    if (at === undefined) {
      byPred.set(key, out.length);
      out.push(link);
      return;
    }
    if (link.lag > out[at].lag) out[at] = link;
  };

  for (const link of links) {
    if (!summaries.has(link.pred) || !SUMMARY_REL_TYPES.includes(link.type)) {
      push(link);
      continue;
    }
    for (const leaf of leafCodesUnder(link.pred, tasks)) {
      push({ pred: leaf, type: link.type, lag: link.lag });
    }
  }
  return out;
}

export function isMilestoneTask(t: CpmInput): boolean {
  return !!t.is_milestone || t.duration_days === 0;
}

function durationOf(t: CpmInput, cal: Calendar): number {
  // A milestone marks an instant. It consumes no working time, so its start
  // and finish are the same day and it cannot itself be the reason anything
  // is late - only the logic through it can.
  if (isMilestoneTask(t)) return 0;
  // duration_days first, then the span between the dates.
  //
  // This order was worth questioning, because nothing used to keep the two in
  // agreement - a dragged Gantt bar wrote start and finish and left the
  // duration behind, so the engine forecast from a number the bar on screen
  // contradicted. reconcileDates now closes that on every write path, so the
  // two can only disagree on rows written before it existed.
  //
  // The order stays as it was on purpose. Where they do disagree on Sweet
  // Springs the gap is not a rounding error, it is effort against elapsed
  // time: a one-day culvert whose window runs three weeks because it waited on
  // an inspection. Reading the span as the duration would silently restate 24
  // tasks as several times the work they are. assessSchedule reports the
  // disagreement instead, and a human decides which number was meant.
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

// A deliverable is not measured, it is received: a design package, a signed
// contract, a permit, a passed inspection. Percent complete never arrives for
// one, so forecasting "duration times the percent left" from the data date is
// wrong twice over - it invents remaining work nobody reported, and it moves a
// date the engineer committed to. Sussex 30% Design was the case that showed
// it: a 9/14 submission read as 10/8 the moment the 14th passed.
//
// So its own dates are a commitment. They hold while the date is still ahead,
// and once it has passed the task is overdue - the forecast rolls to the data
// date and moves a day at a time, because the package could arrive tomorrow.
// Logic still governs: a predecessor landing later pushes it like anything
// else, and a task waiting on a chain takes its dates from the chain.
// Procurement behaves the same way and joined it in 0057: a transformer with
// a twenty-week lead time is a committed date, not twenty weeks of measurable
// work on site.
function isDeliverable(t: CpmInput): boolean {
  return finishIsACommitment(t.task_type);
}

// Remaining duration for work already under way, used only to forecast a task
// that is ALREADY LATE. A percentage reports progress, not productivity: a task
// at 85% of a ten-day duration has not earned the right to finish in a day and
// a half. So this is never used to pull a finish date earlier than the plan -
// see the projected pass, which holds the planned finish while it is still in
// the future and only forecasts from remaining work once it has passed.
//
// A percent that arrives with a measured rate behind it is different: the
// crew HAS shown its productivity. That case goes through paceRemaining, which
// may move a finish either way.
function remainingDuration(t: CpmInput, duration: number): number {
  if (isComplete(t)) return 0;
  if (duration === 0) return 0;
  const pct = Math.max(0, Math.min(100, Number(t.pct_complete ?? 0)));
  return Math.max(1, Math.ceil(duration * (1 - pct / 100)));
}

// Has reported progress already broken this link? FS and SS are about when the
// successor may START, so any progress on it counts. FF is about when it may
// FINISH, so only completion does. SF is too rare to be worth a rule.
function breaksLink(t: CpmInput, pred: CpmInput, type: RelType): boolean {
  if (!hasStarted(t) && !isComplete(t)) return false;
  switch (type) {
    case "FS":
      return !isComplete(pred);
    case "SS":
      return !hasStarted(pred) && !isComplete(pred);
    case "FF":
      return isComplete(t) && !isComplete(pred);
    default:
      return false;
  }
}

// Forecasting from pace.
//
// Plan-based remaining work - duration times the percent left - ignores how
// the work is actually going. Basin 1 Embankment was a 1-day task that took
// eighteen, and the forecast said nothing until its finish date had already
// passed, because until then it simply held the planned finish.
//
// Pace is the percent reported divided by the working days it took. It is only
// used when it can be trusted:
//   - the percent went up within the last PACE_FRESH_DAYS working days. A stale
//     percent says the reports stopped, not that the crew slowed down; Rough
//     Road at 10% for two weeks would otherwise forecast into next year.
//   - at least PACE_MIN_PCT done and PACE_MIN_DAYS elapsed, so one early report
//     does not set the rate for the whole task.
// It is blended with the plan, weighted by percent complete: at 20% done the
// plan still carries most of the answer, at 90% the field does.
export const PACE_FRESH_DAYS = 5;
const PACE_MIN_PCT = 10;
const PACE_MIN_DAYS = 3;

export function paceRemaining(
  t: CpmInput,
  duration: number,
  dataDate: string,
  cal: Calendar,
): number | null {
  if (isComplete(t) || duration === 0) return null;
  const pct = Number(t.pct_complete ?? 0);
  if (pct < PACE_MIN_PCT || pct >= 100) return null;
  if (!t.start_date || !t.last_progress_date) return null;
  if (workingDaysBetween(t.last_progress_date, dataDate, cal) > PACE_FRESH_DAYS) return null;
  if (parseIso(t.last_progress_date) < parseIso(t.start_date)) return null;
  const elapsed = durationInWorkingDays(t.start_date, t.last_progress_date, cal);
  if (elapsed < PACE_MIN_DAYS) return null;
  const byPace = ((100 - pct) * elapsed) / pct;
  const byPlan = duration * (1 - pct / 100);
  const w = pct / 100;
  return Math.max(1, Math.ceil(w * byPace + (1 - w) * byPlan));
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
      // Summary predecessors resolve to the leaves under them BEFORE the
      // unknown-code filter, which only knows about leaves.
      expandSummaryLinks(parsePredecessors(t.predecessors), allTasks).filter(
        (l) => known.has(l.pred),
      ),
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
      outOfSequence: [],
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
  const outOfSequenceOf = new Map<string, Link[]>();
  const forecastBasisOf = new Map<string, CpmResult["forecastBasis"]>();
  const outOfSequence: { wbs: string; pred: string; type: RelType }[] = [];

  for (const wbs of order) {
    const t = byWbs.get(wbs)!;
    const d = dur.get(wbs)!;

    const broken = (links.get(wbs) ?? []).filter((l) =>
      breaksLink(t, byWbs.get(l.pred)!, l.type),
    );
    outOfSequenceOf.set(wbs, broken);
    for (const l of broken) outOfSequence.push({ wbs, pred: l.pred, type: l.type });

    if (isComplete(t)) {
      // Finished. Hold the recorded dates; nothing downstream waits on it.
      //
      // Except a finish still in the future, which cannot be true of work that
      // is done. It happens whenever a task is closed out by hand - Status set
      // to Complete in the grid - rather than by a report, which records its
      // own actual finish. Left alone, Basin 1 Riser marked complete on 9/17
      // would keep its forecast 9/23 finish and hold everything behind it until
      // the 24th. Done means done by the data date.
      const today = snapBack(dataDate, cal);
      let finish = t.end_date ?? ef.get(wbs)!;
      if (parseIso(finish) > parseIso(today)) finish = today;
      let begun = t.start_date ?? es.get(wbs)!;
      if (parseIso(begun) > parseIso(finish)) begun = finish;
      pStart.set(wbs, begun);
      pEnd.set(wbs, finish);
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

    // Where the predecessors let this task start (or, once it has started,
    // finish).
    //
    // Once a task has started, the links that govern its START are spent: the
    // start happened, so FS and SS have nothing left to say. Holding them was
    // "retained logic", and on Sweet Springs it forecast Basin 2 Embankment -
    // reported at 5% - to wait for Basin 1 to be seeded, which pushed County
    // Inspection two weeks past what the crew on site was actually doing. The
    // field report wins. FF and SF still bound the FINISH, because "the
    // entrance is not complete until the culvert is in" stays true after the
    // entrance starts. The links the field broke are reported, not hidden.
    let depStart: string | null = null;
    let depFinish: string | null = null;
    let driver: string | null = null;
    for (const l of links.get(wbs) ?? []) {
      const predEnd = pEnd.get(l.pred);
      const predStart = pStart.get(l.pred);
      if (!predEnd || !predStart) continue;
      if (started) {
        if (l.type === "FS" || l.type === "SS") continue;
        // FF: succ.EF >= pred.EF + lag.  SF: succ.EF >= pred.ES + lag.
        const bound = advance(l.type === "FF" ? predEnd : predStart, l.lag, cal);
        if (!depFinish || parseIso(bound) > parseIso(depFinish)) {
          depFinish = bound;
          driver = l.pred;
        }
        continue;
      }
      const candidate = candidateStart(l.type, l.lag, predStart, predEnd, d, cal);
      if (!depStart || parseIso(candidate) > parseIso(depStart)) {
        depStart = candidate;
        driver = l.pred;
      }
    }

    let end: string;
    let basis: CpmResult["forecastBasis"] = null;
    if (started) {
      // Under way. With a pace worth trusting, forecast from it. Otherwise the
      // plan stands while its finish is still ahead of the data date, and only
      // once that date has passed do we forecast from remaining work.
      const pace = isDeliverable(t) ? null : paceRemaining(t, d, dataDate, cal);
      if (isDeliverable(t)) {
        // Committed while the date is ahead; overdue once it is behind.
        if (plannedEnd && parseIso(plannedEnd) >= parseIso(workStart)) {
          end = plannedEnd;
          basis = "committed";
        } else {
          end = workStart;
          basis = "overdue";
        }
      } else if (pace != null) {
        end = addWorkingDays(workStart, pace, cal);
        basis = "pace";
      } else if (plannedEnd && parseIso(plannedEnd) >= parseIso(workStart)) {
        end = plannedEnd;
        basis = "held";
      } else {
        end = addWorkingDays(workStart, remainingDuration(t, d), cal);
        basis = "plan";
      }
      if (depFinish && parseIso(depFinish) > parseIso(end)) end = depFinish;
      else driver = null;
    } else if (depStart) {
      // Not started, and tied into the network. Its logic decides when it can
      // begin - earlier than the plan as well as later. The planned start is
      // only where the predecessors USED to land; holding it as a floor meant
      // Basin 2 Embankment reporting early moved nothing behind it until
      // somebody reflowed by hand. A start that genuinely cannot come earlier -
      // a mobilization date, a delivery, a permit window - is a date
      // constraint (SNET), which still holds below.
      start = parseIso(depStart) > parseIso(workStart) ? depStart : workStart;
      end = addWorkingDays(start, d, cal);
    } else {
      // Not started, nothing driving it. The planned dates are all that anchor
      // it, so they stand unless they have already slipped past the data date.
      if (isDeliverable(t) && plannedEnd) {
        // Nothing is driving it but its own commitment, so the commitment is
        // the forecast - including the start, which is not pushed to today the
        // way remaining work would be.
        if (t.start_date) start = t.start_date;
        end =
          parseIso(plannedEnd) >= parseIso(workStart) ? plannedEnd : workStart;
        basis = parseIso(plannedEnd) >= parseIso(workStart) ? "committed" : "overdue";
      } else {
        end =
        plannedEnd &&
        parseIso(start) <= parseIso(t.start_date ?? start) &&
        parseIso(plannedEnd) >= parseIso(start)
          ? plannedEnd
          : addWorkingDays(start, d, cal);
      }
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

    // An overdue deliverable keeps a start in the past and a finish that has
    // rolled up to the data date. Anything else that leaves start after finish
    // is bad data, and the engine should not pass it on.
    if (parseIso(start) > parseIso(end)) start = end;

    pStart.set(wbs, start);
    pEnd.set(wbs, end);
    drivenBy.set(wbs, driver);
    forecastBasisOf.set(wbs, basis);
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
      forecastBasis: forecastBasisOf.get(wbs) ?? null,
      daysOverdue:
        forecastBasisOf.get(wbs) === "overdue" && t.end_date
          ? Math.max(0, workingDaysBetween(t.end_date, dataDate, cal))
          : 0,
      constraintViolation: violationOf.get(wbs) ?? null,
      outOfSequence: outOfSequenceOf.get(wbs) ?? [],
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
    outOfSequence,
  };
}
