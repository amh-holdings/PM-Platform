// Schedule health assessment - the DCMA 14-point check, run over our own
// network rather than exported to a tool.
//
// The Defense Contract Management Agency published fourteen quantitative
// checks for whether a schedule is built well enough to be believed. They are
// the closest thing the industry has to a standard, and every serious tool
// implements them because "is this schedule any good" otherwise comes down to
// whoever is reading it.
//
// This exists because the civil review on 17 Aug 2026 found thirteen logic
// errors, one missing permit gate and one backwards link, and every one of
// them was found by hand. Nothing in that review needed judgement to DETECT -
// only to fix. So the detection belongs in the app, running on every schedule,
// every time, and the review document becomes something the system produces
// rather than something somebody writes on a Sunday.
//
// Each check reports a measured value, a verdict, the tasks responsible and
// what to do about it. A check that cannot be evaluated - BEI without a
// baseline - returns "na" and is excluded from the score rather than counted
// as a pass, because a schedule that cannot be measured is not a healthy one,
// it is an unmeasured one, and those are different claims.

import {
  parseIso,
  todayIso,
  toCalendar,
  workingDaysBetween,
  type CalendarLike,
} from "@/lib/schedule-calendar";
import {
  HARD_CONSTRAINTS,
  leavesOf,
  parsePredecessors,
  type CpmInput,
  type CpmOutput,
  type DateConstraintType,
  type RelType,
} from "@/lib/schedule-cpm";

export type HealthStatus = "pass" | "warn" | "fail" | "na";

export type HealthCheckId =
  | "logic"
  | "leads"
  | "lags"
  | "relationship_types"
  | "hard_constraints"
  | "high_float"
  | "negative_float"
  | "high_duration"
  | "invalid_dates"
  | "resources"
  | "missed_tasks"
  | "critical_path_test"
  | "cpli"
  | "bei";

export type AffectedTask = {
  wbs: string;
  name: string;
  note?: string;
};

export type HealthCheck = {
  id: HealthCheckId;
  name: string;
  /** What the check is actually asking, in one sentence. */
  question: string;
  status: HealthStatus;
  /** The measured number, for sorting and trending. */
  value: number;
  /** The measurement rendered for a human: "3 of 30 (10%)". */
  display: string;
  /** The DCMA threshold this is judged against. */
  threshold: string;
  /** Why it came out this way. */
  detail: string;
  /** What to do about it. */
  fix: string;
  /** Contribution to the overall score. */
  weight: number;
  affected: AffectedTask[];
};

export type HealthResult = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  dataDate: string;
  checks: HealthCheck[];
  /** Checks that failed or warned, worst first. Drives the worklist. */
  findings: HealthCheck[];
  taskCount: number;
  relationshipCount: number;
};

export type HealthInput = CpmInput & {
  task_name?: string | null;
  assigned_to?: string | null;
  baseline_end?: string | null;
};

// DCMA thresholds. Expressed as percentages of the relevant population except
// where the standard is a flat count.
const T = {
  logicPct: 5,
  leadCount: 0,
  lagPct: 5,
  fsPct: 90,
  hardConstraintPct: 5,
  highFloatPct: 5,
  highFloatDays: 44,
  negativeFloatCount: 0,
  highDurationPct: 5,
  highDurationDays: 44,
  invalidDateCount: 0,
  resourcePct: 100,
  missedTaskPct: 5,
  cpli: 0.95,
  bei: 0.95,
};

function pct(n: number, of: number): number {
  return of > 0 ? (n / of) * 100 : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function isComplete(t: CpmInput): boolean {
  return t.status === "Complete" || Number(t.pct_complete ?? 0) >= 100;
}

function nameOf(t: HealthInput): string {
  return t.task_name ?? t.wbs_code;
}

export function assessSchedule(
  allTasks: HealthInput[],
  cpm: CpmOutput,
  opts: { calendar?: CalendarLike; dataDate?: string } = {},
): HealthResult {
  const cal = toCalendar(opts.calendar ?? 5);
  const dataDate = opts.dataDate ?? cpm.dataDate ?? todayIso();

  const tasks = leavesOf(allTasks);
  const known = new Set(tasks.map((t) => t.wbs_code));
  const byWbs = new Map(tasks.map((t) => [t.wbs_code, t]));

  // Relationships, and the successor side of each, built once.
  type Rel = { from: string; to: string; type: RelType; lag: number };
  const rels: Rel[] = [];
  const hasPred = new Set<string>();
  const hasSucc = new Set<string>();
  for (const t of tasks) {
    for (const l of parsePredecessors(t.predecessors)) {
      if (!known.has(l.pred)) continue;
      rels.push({ from: l.pred, to: t.wbs_code, type: l.type, lag: l.lag });
      hasPred.add(t.wbs_code);
      hasSucc.add(l.pred);
    }
  }

  const incomplete = tasks.filter((t) => !isComplete(t));
  const checks: HealthCheck[] = [];

  const add = (c: HealthCheck) => checks.push(c);

  // Verdict helper for "lower is better, measured as a percentage".
  const verdictPct = (v: number, limit: number): HealthStatus =>
    v <= limit ? "pass" : v <= limit * 2 ? "warn" : "fail";

  // ---- 1. Logic ----------------------------------------------------------
  // Every task needs something driving it and something waiting on it. The
  // project's own start and finish are the two legitimate exceptions, so one
  // task may open the network and any task finishing on the project finish
  // date may close it.
  {
    const openers = tasks
      .filter((t) => !hasPred.has(t.wbs_code))
      .sort((a, b) => {
        const ax = cpm.byWbs.get(a.wbs_code)?.es ?? "9999";
        const bx = cpm.byWbs.get(b.wbs_code)?.es ?? "9999";
        return ax < bx ? -1 : 1;
      });
    const projectStart = openers[0]?.wbs_code;

    const affected: AffectedTask[] = [];
    for (const t of tasks) {
      const c = cpm.byWbs.get(t.wbs_code);
      const missingPred = !hasPred.has(t.wbs_code) && t.wbs_code !== projectStart;
      const missingSucc =
        !hasSucc.has(t.wbs_code) &&
        !(cpm.plannedFinish && c && c.ef === cpm.plannedFinish);
      if (!missingPred && !missingSucc) continue;
      affected.push({
        wbs: t.wbs_code,
        name: nameOf(t),
        note:
          missingPred && missingSucc
            ? "no predecessor and no successor"
            : missingPred
              ? "no predecessor"
              : "no successor",
      });
    }
    const value = round1(pct(affected.length, tasks.length));
    add({
      id: "logic",
      name: "Logic",
      question: "Is every task driven by something and driving something?",
      status: verdictPct(value, T.logicPct),
      value,
      display: `${affected.length} of ${tasks.length} (${value}%)`,
      threshold: `<= ${T.logicPct}%`,
      detail: affected.length
        ? `${affected.length} task${affected.length === 1 ? "" : "s"} float free of the network. A slip on one of these moves nothing, and nothing moves them.`
        : "Every task is tied into the network on both sides.",
      fix: "Add the missing predecessor or successor on Edit. A task with no successor is the more dangerous of the two - it means nothing on the job is waiting for it, which is almost never true.",
      weight: 3,
      affected,
    });
  }

  // ---- 2. Leads (negative lag) -------------------------------------------
  // Zero tolerance. A lead says a successor may start before its predecessor
  // has finished, which is nearly always an overlap that should have been
  // written as start-to-start with a positive lag. Leads also break the
  // backward pass in most tools and make float unreliable.
  {
    const leads = rels.filter((r) => r.lag < 0);
    const affected = leads.map((r) => ({
      wbs: r.to,
      name: nameOf(byWbs.get(r.to)!),
      note: `${r.type}${r.lag} on ${r.from}`,
    }));
    add({
      id: "leads",
      name: "Leads",
      question: "Does any link use a negative lag?",
      status: leads.length === 0 ? "pass" : "fail",
      value: leads.length,
      display: `${leads.length} of ${rels.length} link${rels.length === 1 ? "" : "s"}`,
      threshold: "0",
      detail: leads.length
        ? "A lead lets work start before the thing it depends on has finished. Almost always this should be a start-to-start link with positive lag instead, which says the same thing without corrupting float."
        : "No negative lags.",
      fix: "Re-express as SS with a positive lag: instead of 'B starts 2 days before A finishes', write 'B starts 3 days after A starts'.",
      weight: 2,
      affected,
    });
  }

  // ---- 3. Lags -----------------------------------------------------------
  {
    const lags = rels.filter((r) => r.lag > 0);
    const value = round1(pct(lags.length, rels.length));
    const affected = lags.slice(0, 40).map((r) => ({
      wbs: r.to,
      name: nameOf(byWbs.get(r.to)!),
      note: `${r.type}+${r.lag} on ${r.from}`,
    }));
    add({
      id: "lags",
      name: "Lags",
      question: "Is waiting time hidden inside links instead of shown as work?",
      status: verdictPct(value, T.lagPct),
      value,
      display: `${lags.length} of ${rels.length} (${value}%)`,
      threshold: `<= ${T.lagPct}%`,
      detail: lags.length
        ? "Lag is invisible time. It cannot be progressed, resourced or reported on, and nobody is accountable for it."
        : "No lag on any link.",
      fix: "Where the lag represents real elapsed work - curing, drying, a delivery in transit - make it a task with a duration so it can be tracked. Keep lag only for genuine waiting.",
      weight: 1,
      affected,
    });
  }

  // ---- 4. Relationship types ---------------------------------------------
  // DCMA wants FS to dominate. Our own failure mode was the opposite of the
  // usual one: the Smartsheet import made EVERY link finish-to-start when the
  // work plainly overlapped, so this check reads in both directions.
  {
    const counts: Record<RelType, number> = { FS: 0, SS: 0, FF: 0, SF: 0 };
    for (const r of rels) counts[r.type]++;
    const fsPct = round1(pct(counts.FS, rels.length));
    const sfCount = counts.SF;

    let status: HealthStatus;
    let detail: string;
    if (!rels.length) {
      status = "na";
      detail = "No relationships to assess.";
    } else if (sfCount > 0) {
      status = "fail";
      detail = `${sfCount} start-to-finish link${sfCount === 1 ? "" : "s"}. SF is almost always a mistake - it says a task cannot finish until another starts, which is rarely what anyone means.`;
    } else if (fsPct >= T.fsPct) {
      status = "pass";
      detail = `${fsPct}% finish-to-start, which is the expected shape.`;
    } else if (fsPct >= 50) {
      status = "warn";
      detail = `${fsPct}% finish-to-start. Overlapping logic is legitimate on civil work, but this much of it is worth a look.`;
    } else {
      status = "fail";
      detail = `Only ${fsPct}% finish-to-start. A network built mostly on overlaps has very little that actually constrains anything, so the critical path becomes unstable.`;
    }

    add({
      id: "relationship_types",
      name: "Relationship types",
      question: "Is the network built on finish-to-start logic?",
      status,
      value: fsPct,
      display: `FS ${counts.FS}, SS ${counts.SS}, FF ${counts.FF}, SF ${counts.SF}`,
      threshold: `>= ${T.fsPct}% FS, 0 SF`,
      detail,
      fix: "Check that each link type matches how the work actually runs. Concurrent work is SS; work that has to finish together is FF; SF should almost always be re-drawn.",
      weight: 2,
      affected: rels
        .filter((r) => r.type === "SF")
        .map((r) => ({
          wbs: r.to,
          name: nameOf(byWbs.get(r.to)!),
          note: `SF link from ${r.from}`,
        })),
    });
  }

  // ---- 5. Hard constraints -----------------------------------------------
  {
    const constrained = tasks.filter((t) => {
      const c = t.date_constraint_type as DateConstraintType | null | undefined;
      return c ? HARD_CONSTRAINTS.has(c) : false;
    });
    const value = round1(pct(constrained.length, tasks.length));
    add({
      id: "hard_constraints",
      name: "Hard constraints",
      question: "Are dates pinned in place instead of driven by logic?",
      status: verdictPct(value, T.hardConstraintPct),
      value,
      display: `${constrained.length} of ${tasks.length} (${value}%)`,
      threshold: `<= ${T.hardConstraintPct}%`,
      detail: constrained.length
        ? "A hard constraint overrides the network. Too many and the schedule stops calculating and starts merely recording what somebody typed."
        : "No hard constraints. Every date comes from the logic.",
      fix: "Keep hard constraints for genuine external gates - an interconnection window, a permit expiry, a contract milestone. Everything else should be driven by its predecessors.",
      weight: 2,
      affected: constrained.map((t) => ({
        wbs: t.wbs_code,
        name: nameOf(t),
        note: `${t.date_constraint_type} ${t.date_constraint_date}`,
      })),
    });
  }

  // ---- 6. High float -----------------------------------------------------
  {
    const high = incomplete.filter((t) => {
      const c = cpm.byWbs.get(t.wbs_code);
      return c ? c.totalFloat > T.highFloatDays : false;
    });
    const value = round1(pct(high.length, incomplete.length));
    add({
      id: "high_float",
      name: "High float",
      question: "Do any tasks have so much slack that their logic looks wrong?",
      status: verdictPct(value, T.highFloatPct),
      value,
      display: `${high.length} of ${incomplete.length} (${value}%)`,
      threshold: `<= ${T.highFloatPct}% over ${T.highFloatDays} days`,
      detail: high.length
        ? `Float above ${T.highFloatDays} working days usually means a missing successor rather than genuine slack - the task is not connected to anything that would pull it forward.`
        : "No task carries an implausible amount of slack.",
      fix: "Look for the missing successor. If the slack is real, say so in the task description so the next person does not go hunting for it.",
      weight: 2,
      affected: high.map((t) => ({
        wbs: t.wbs_code,
        name: nameOf(t),
        note: `${cpm.byWbs.get(t.wbs_code)!.totalFloat}d float`,
      })),
    });
  }

  // ---- 7. Negative float -------------------------------------------------
  {
    const neg = incomplete.filter((t) => {
      const c = cpm.byWbs.get(t.wbs_code);
      return c ? c.totalFloat < 0 : false;
    });
    add({
      id: "negative_float",
      name: "Negative float",
      question: "Is anything already impossible?",
      status: neg.length === 0 ? "pass" : "fail",
      value: neg.length,
      display: `${neg.length} task${neg.length === 1 ? "" : "s"}`,
      threshold: "0",
      detail: neg.length
        ? "Negative float means the work cannot be done in the time left. It does not resolve itself - either the plan changes or the date does."
        : "Nothing is behind its own late dates.",
      fix: "Recover the time, re-sequence, or move the constrained date. Recording it and carrying on is the one option that does not work.",
      weight: 3,
      affected: neg
        .sort(
          (a, b) =>
            (cpm.byWbs.get(a.wbs_code)?.totalFloat ?? 0) -
            (cpm.byWbs.get(b.wbs_code)?.totalFloat ?? 0),
        )
        .map((t) => ({
          wbs: t.wbs_code,
          name: nameOf(t),
          note: `${cpm.byWbs.get(t.wbs_code)!.totalFloat}d float`,
        })),
    });
  }

  // ---- 8. High duration --------------------------------------------------
  {
    const long = incomplete.filter((t) => {
      const c = cpm.byWbs.get(t.wbs_code);
      if (!c || c.isMilestone) return false;
      return c.duration > T.highDurationDays;
    });
    const value = round1(pct(long.length, incomplete.length));
    add({
      id: "high_duration",
      name: "High duration",
      question: "Are any tasks too long to manage?",
      status: verdictPct(value, T.highDurationPct),
      value,
      display: `${long.length} of ${incomplete.length} (${value}%)`,
      threshold: `<= ${T.highDurationPct}% over ${T.highDurationDays} days`,
      detail: long.length
        ? `A task longer than ${T.highDurationDays} working days cannot be usefully progressed - it sits at "in progress" for months and tells you nothing.`
        : "No task runs longer than a manageable window.",
      fix: "Break it into stages with their own finishes. Mass Grading by area beats one Mass Grading bar.",
      weight: 1,
      affected: long.map((t) => ({
        wbs: t.wbs_code,
        name: nameOf(t),
        note: `${cpm.byWbs.get(t.wbs_code)!.duration}d`,
      })),
    });
  }

  // ---- 9. Invalid dates --------------------------------------------------
  // Actuals cannot be in the future and forecasts cannot be in the past. Both
  // mean the schedule has not been statused against the data date.
  {
    const affected: AffectedTask[] = [];
    for (const t of tasks) {
      if (isComplete(t) && t.end_date && parseIso(t.end_date) > parseIso(dataDate)) {
        affected.push({
          wbs: t.wbs_code,
          name: nameOf(t),
          note: `complete, but finishes ${t.end_date} - after the data date`,
        });
        continue;
      }
      const started = Number(t.pct_complete ?? 0) > 0 || t.status === "In Progress";
      if (!started && !isComplete(t) && t.start_date && parseIso(t.start_date) < parseIso(dataDate)) {
        affected.push({
          wbs: t.wbs_code,
          name: nameOf(t),
          note: `not started, but was due to start ${t.start_date}`,
        });
      }
    }
    add({
      id: "invalid_dates",
      name: "Invalid dates",
      question: "Is the schedule statused against the data date?",
      status: affected.length === 0 ? "pass" : affected.length <= 2 ? "warn" : "fail",
      value: affected.length,
      display: `${affected.length} task${affected.length === 1 ? "" : "s"}`,
      threshold: "0",
      detail: affected.length
        ? `Work left of the data date (${dataDate}) has to be actual and work right of it has to be forecast. These rows are on the wrong side of that line.`
        : `Every task sits on the correct side of the data date (${dataDate}).`,
      fix: "Either record the progress that has happened, or move the dates to when the work will actually run. Leaving a start date in the past on a task nobody has begun quietly makes the whole forecast optimistic.",
      weight: 3,
      affected,
    });
  }

  // ---- 10. Resources -----------------------------------------------------
  // We do not cost-load, so this is read as "does someone own this task".
  // An unowned task is one nobody will report on.
  {
    const unowned = incomplete.filter((t) => !t.assigned_to?.trim());
    const covered = round1(pct(incomplete.length - unowned.length, incomplete.length));
    add({
      id: "resources",
      name: "Assignment",
      question: "Does every remaining task have somebody's name on it?",
      status: unowned.length === 0 ? "pass" : covered >= 80 ? "warn" : "fail",
      value: covered,
      display: `${incomplete.length - unowned.length} of ${incomplete.length} assigned (${covered}%)`,
      threshold: `${T.resourcePct}%`,
      detail: unowned.length
        ? "An unassigned task has nobody to report it, nobody to chase and nobody to blame when it slips."
        : "Every remaining task is assigned.",
      fix: "Set 'Assigned to' on Edit. It also drives who sees the task on the look-ahead.",
      weight: 1,
      affected: unowned.map((t) => ({ wbs: t.wbs_code, name: nameOf(t) })),
    });
  }

  // ---- 11. Missed tasks --------------------------------------------------
  {
    const withBaseline = tasks.filter((t) => t.baseline_end);
    if (!withBaseline.length) {
      add({
        id: "missed_tasks",
        name: "Missed tasks",
        question: "How much of the baseline has been missed?",
        status: "na",
        value: 0,
        display: "no baseline",
        threshold: `<= ${T.missedTaskPct}%`,
        detail: "No task carries baseline dates, so there is nothing to have missed. Until a baseline is set, schedule variance cannot be computed and a delay claim has nothing to point at.",
        fix: "Set the baseline once the logic review is done.",
        weight: 2,
        affected: [],
      });
    } else {
      const due = withBaseline.filter(
        (t) => t.baseline_end && parseIso(t.baseline_end) <= parseIso(dataDate),
      );
      const missed = due.filter((t) => !isComplete(t));
      const value = round1(pct(missed.length, due.length));
      add({
        id: "missed_tasks",
        name: "Missed tasks",
        question: "How much of the baseline has been missed?",
        status: verdictPct(value, T.missedTaskPct),
        value,
        display: `${missed.length} of ${due.length} due (${value}%)`,
        threshold: `<= ${T.missedTaskPct}%`,
        detail: missed.length
          ? "These were committed to finish by now and have not. Each one is either a recovery item or a change to explain."
          : "Everything the baseline committed to by now has finished.",
        fix: "Work the recovery list, or record why the date moved. A missed task with no reason attached is the one that costs you the claim.",
        weight: 2,
        affected: missed.map((t) => ({
          wbs: t.wbs_code,
          name: nameOf(t),
          note: `baselined to finish ${t.baseline_end}`,
        })),
      });
    }
  }

  // ---- 12. Critical path test --------------------------------------------
  // Does a continuous critical path actually reach the project finish? A
  // schedule can compute float and still have no path, which means the finish
  // date is not being driven by anything.
  {
    const cp = cpm.criticalPath;
    const last = cp.length ? cpm.byWbs.get(cp[cp.length - 1]) : null;
    const reaches = !!(last && cpm.plannedFinish && last.ef === cpm.plannedFinish);
    const status: HealthStatus = !cp.length ? "fail" : reaches ? "pass" : "warn";
    add({
      id: "critical_path_test",
      name: "Critical path test",
      question: "Is there an unbroken critical path to the finish?",
      status,
      value: cp.length,
      display: `${cp.length} task${cp.length === 1 ? "" : "s"}`,
      threshold: "continuous to the finish",
      detail: !cp.length
        ? "No critical path. Nothing in the network is driving the finish date, which means the finish date is not a forecast."
        : reaches
          ? `The path runs ${cp.length} tasks and lands on the project finish.`
          : "A critical path exists but does not reach the project finish, so something off the path is setting the date.",
      fix: "Usually a missing link. Check the tasks flagged under Logic first - a free-floating task near the end of the job is the common cause.",
      weight: 3,
      affected: cp.slice(0, 40).map((w) => ({
        wbs: w,
        name: nameOf(byWbs.get(w)!),
        note: `${cpm.byWbs.get(w)!.es} to ${cpm.byWbs.get(w)!.ef}`,
      })),
    });
  }

  // ---- 13. CPLI ----------------------------------------------------------
  // Critical Path Length Index: how much the remaining critical path would
  // have to compress to hit the finish. 1.0 is on plan, below 0.95 is trouble.
  {
    if (!cpm.plannedFinish) {
      add({
        id: "cpli",
        name: "CPLI",
        question: "Can the remaining critical path still make the date?",
        status: "na",
        value: 0,
        display: "no finish date",
        threshold: `>= ${T.cpli}`,
        detail: "The schedule has no calculable finish.",
        fix: "Fix the logic errors above first.",
        weight: 2,
        affected: [],
      });
    } else {
      const cpl = Math.max(1, workingDaysBetween(dataDate, cpm.plannedFinish, cal));
      // Project total float is the worst float in the network - a constrained
      // finish that cannot be met shows up here as negative.
      let worst = 0;
      for (const t of incomplete) {
        const c = cpm.byWbs.get(t.wbs_code);
        if (c && c.totalFloat < worst) worst = c.totalFloat;
      }
      const cpli = round1(((cpl + worst) / cpl) * 100) / 100;
      add({
        id: "cpli",
        name: "CPLI",
        question: "Can the remaining critical path still make the date?",
        status: cpli >= 1 ? "pass" : cpli >= T.cpli ? "warn" : "fail",
        value: cpli,
        display: `${cpli.toFixed(2)}`,
        threshold: `>= ${T.cpli}`,
        detail:
          cpli >= 1
            ? `${cpl} working days of critical path remain and the dates support it.`
            : `The critical path needs to run ${Math.round((1 - cpli) * 100)}% faster than planned to hold the date. That efficiency has to come from somewhere specific.`,
        fix: "Compress the path, re-sequence, or move the date. CPLI below 1.0 with no recovery plan attached is a date that will move on its own later.",
        weight: 2,
        affected: [],
      });
    }
  }

  // ---- 14. BEI -----------------------------------------------------------
  // Baseline Execution Index: tasks actually finished over tasks the baseline
  // said would be finished by now. Below 0.95 and the job is falling behind
  // faster than the schedule is admitting.
  {
    const withBaseline = tasks.filter((t) => t.baseline_end);
    const due = withBaseline.filter(
      (t) => t.baseline_end && parseIso(t.baseline_end) <= parseIso(dataDate),
    );
    if (!due.length) {
      add({
        id: "bei",
        name: "BEI",
        question: "Is work finishing at the rate the baseline assumed?",
        status: "na",
        value: 0,
        display: withBaseline.length ? "nothing due yet" : "no baseline",
        threshold: `>= ${T.bei}`,
        detail: withBaseline.length
          ? "The baseline has nothing due by the data date, so there is no rate to measure yet."
          : "No baseline, so execution rate cannot be measured.",
        fix: "Set the baseline once the logic review is done.",
        weight: 2,
        affected: [],
      });
    } else {
      const done = due.filter((t) => isComplete(t)).length;
      const bei = round1((done / due.length) * 100) / 100;
      add({
        id: "bei",
        name: "BEI",
        question: "Is work finishing at the rate the baseline assumed?",
        status: bei >= T.bei ? "pass" : bei >= 0.8 ? "warn" : "fail",
        value: bei,
        display: `${bei.toFixed(2)} (${done} of ${due.length})`,
        threshold: `>= ${T.bei}`,
        detail:
          bei >= T.bei
            ? "Work is completing at roughly the rate the baseline assumed."
            : `Only ${done} of the ${due.length} tasks the baseline expected to be finished by now are done. The finish date will move unless the rate changes.`,
        fix: "BEI is the earliest honest signal of a slip. Treat a sustained reading below 0.9 as a forecast, not a report.",
        weight: 2,
        affected: [],
      });
    }
  }

  // ---- score -------------------------------------------------------------
  // Weighted, excluding checks that could not be evaluated. A warn is worth
  // half a pass, which keeps the score responsive without letting a single
  // amber reading read as a failure.
  let earned = 0;
  let possible = 0;
  for (const c of checks) {
    if (c.status === "na") continue;
    possible += c.weight;
    earned += c.weight * (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0);
  }
  const score = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  const grade: HealthResult["grade"] =
    score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

  const rank: Record<HealthStatus, number> = { fail: 0, warn: 1, pass: 2, na: 3 };
  const findings = checks
    .filter((c) => c.status === "fail" || c.status === "warn")
    .sort((a, b) => rank[a.status] - rank[b.status] || b.weight - a.weight);

  return {
    score,
    grade,
    dataDate,
    checks,
    findings,
    taskCount: tasks.length,
    relationshipCount: rels.length,
  };
}

// Plain-text health report, formatted for pasting into an email. The civil
// review was written by hand and mailed; this is the same artifact, generated.
export function healthToText(
  health: HealthResult,
  projectName: string,
): string {
  const lines: string[] = [
    `${projectName} - schedule health`,
    `Data date ${health.dataDate}  |  score ${health.score}/100 (${health.grade})  |  ${health.taskCount} tasks, ${health.relationshipCount} links`,
    "",
  ];
  for (const c of health.checks) {
    const mark =
      c.status === "pass" ? "OK  " : c.status === "warn" ? "WARN" : c.status === "fail" ? "FAIL" : "n/a ";
    lines.push(`${mark}  ${c.name}: ${c.display}  (target ${c.threshold})`);
  }
  if (health.findings.length) {
    lines.push("", "What to fix", "-----------");
    for (const f of health.findings) {
      lines.push(`* ${f.name} - ${f.detail}`);
      lines.push(`  ${f.fix}`);
      for (const a of f.affected.slice(0, 12)) {
        lines.push(`    ${a.wbs}  ${a.name}${a.note ? ` (${a.note})` : ""}`);
      }
      if (f.affected.length > 12)
        lines.push(`    ... and ${f.affected.length - 12} more`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
