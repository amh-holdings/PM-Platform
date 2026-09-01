// The CEO Report: where the project actually is, where the plan says it should
// be, when it finishes, and what it looks like on the ground.
//
// Deliberately carries NO money. Phil's call on 2026-09-01 is that the report
// ships as a progress report first and financials fold in later. The money
// derivation is built and tested but parked in `ceo-report-financials.ts`,
// which nothing on this page imports - so no dollar figure can reach the
// printed sheet by accident.
//
// This module is PURE. Rows in, report out, with the as-of date passed in
// rather than read from the clock, so every number is reproducible and
// testable. Fetching lives in `ceo-report-load.ts`; the screen and the print
// sheet both render this one object, so the page somebody approved and the PDF
// that left the building cannot disagree.
//
// The central claim - "we are here, we were supposed to be here" - is the one
// worth being careful about, because it is the easiest to fake. See
// `plannedPct`.

// ---------------------------------------------------------------- input rows

export type CeoProjectRow = {
  id: string;
  name: string;
  client: string | null;
  status: string | null;
  contract_value: number | null;
  ntp_date: string | null;
  cod_date: string | null;
  dc_capacity_mw: number | null;
  retainage_pct_default: number | null;
};

export type CeoTaskRow = {
  wbs_code: string | null;
  task_name: string | null;
  parent_wbs_code: string | null;
  phase: string | null;
  status: string | null;
  pct_complete: number | null;
  duration_days: number | null;
  start_date: string | null;
  end_date: string | null;
  baseline_start: string | null;
  baseline_end: string | null;
  is_milestone: boolean | null;
};

/** A site photograph, already signed by the loader. */
export type CeoPhoto = {
  key: string;
  /** ISO date the photo was taken. */
  day: string;
  /** Who or what it came from, e.g. "5.1.1.6 Construct Basin 1 ESC (AHC)". */
  who: string;
  caption: string | null;
  source: "inspection" | "cmlog" | "dpr";
  /** WBS code the photo evidences, when it is known. */
  taskKey: string | null;
  url: string | null;
};

export type CeoReportInput = {
  /** The date the report speaks as of. Progress is measured to this date. */
  asOf: string;
  project: CeoProjectRow;
  tasks: CeoTaskRow[];
  /**
   * The photographs that will print - already chosen by `selectPhotos` and
   * already signed. Selection happens in the loader so only these get signed
   * and resized; see `selectPhotos`.
   */
  photos: CeoPhoto[];
  /** How many photographs existed to choose from, for "6 of 228". */
  photoCandidateCount?: number;
};

// -------------------------------------------------------------------- checks

/**
 * Something the reader must know before trusting a figure above it.
 *
 * `blocker` means a number on this report could not be produced at all.
 * `warn` means it was produced but something upstream disagrees with itself.
 */
export type CheckSeverity = "ok" | "warn" | "blocker";

export type CeoCheck = {
  id: string;
  label: string;
  severity: CheckSeverity;
  detail: string;
};

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Percent of `whole` that `part` represents, or null when there is no whole. */
export function pctOf(part: number, whole: number): number | null {
  if (!Number.isFinite(whole) || whole === 0) return null;
  return (part / whole) * 100;
}

/** Whole-dollar money. Used only by the dormant financial module. */
export function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

// ------------------------------------------------------------------ calendar

/** ISO date to a UTC timestamp. Month is 1-based in ISO, 0-based in Date.UTC. */
function utcDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

/** Days from `from` to `to`, both ISO dates. Negative when `to` precedes. */
export function daysBetweenIso(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / 86_400_000);
}

/** `iso` shifted by n days, back as an ISO date. */
export function addDaysIso(iso: string, n: number): string {
  return new Date(utcDay(iso) + n * 86_400_000).toISOString().slice(0, 10);
}

const COMPLETE_STATUSES = new Set(["complete", "completed", "finished", "done"]);

/** A task's reported percent, treating an explicit Complete status as 100. */
export function taskPct(t: CeoTaskRow): number {
  if (COMPLETE_STATUSES.has((t.status ?? "").toLowerCase())) return 100;
  const p = t.pct_complete;
  if (p == null || !Number.isFinite(Number(p))) return 0;
  return Math.max(0, Math.min(100, Number(p)));
}

/**
 * The dates progress is measured against.
 *
 * Baseline dates win when a task carries them, because a baseline is the plan
 * as agreed and does not move when somebody re-dates the schedule. Current
 * dates are the fallback, and the report says which it used - measuring
 * against a schedule that has been dragged forward flatters the answer, and a
 * reader has to know that is what they are looking at.
 */
export function planWindow(t: CeoTaskRow): { start: string; end: string } | null {
  if (t.baseline_start && t.baseline_end) return { start: t.baseline_start, end: t.baseline_end };
  if (t.start_date && t.end_date) return { start: t.start_date, end: t.end_date };
  return null;
}

/**
 * Where the plan says one task should be on a given date.
 *
 * Straight line across its own window: nothing before it starts, everything
 * once its finish has passed, pro rata in between. This is the standard
 * planned-value curve, and it is the only honest way to answer "supposed to be
 * here" on a schedule with no cost loading - the alternative, weighting by
 * dollars, needs the cost data this report deliberately does not carry.
 */
export function plannedPct(t: CeoTaskRow, asOf: string): number | null {
  const w = planWindow(t);
  if (!w) return null;
  // Finish is tested BEFORE start, so a zero-duration milestone - where start
  // and end are the same day - reads as complete on its date rather than as
  // not yet begun. For any task with real duration the order does not matter.
  if (asOf >= w.end) return 100;
  if (asOf <= w.start) return 0;
  const span = daysBetweenIso(w.start, w.end);
  if (span <= 0) return 100;
  return Math.max(0, Math.min(100, (daysBetweenIso(w.start, asOf) / span) * 100));
}

/**
 * Duration-weighted mean, falling back to the unweighted mean when no task
 * carries a duration.
 */
function durationWeighted(
  items: Array<{ pct: number; durationDays: number | null }>,
): { pct: number; weightedByDuration: boolean } {
  if (items.length === 0) return { pct: 0, weightedByDuration: false };
  const unweighted = items.reduce((s, i) => s + i.pct, 0) / items.length;
  const known = items
    .map((i) => i.durationDays)
    .filter((d): d is number => d != null && Number.isFinite(d) && d > 0);
  if (known.length === 0) return { pct: round2(unweighted), weightedByDuration: false };

  const fallback = known.reduce((s, d) => s + d, 0) / known.length;
  let numer = 0;
  let denom = 0;
  for (const i of items) {
    const w =
      i.durationDays != null && Number.isFinite(i.durationDays) && i.durationDays > 0
        ? i.durationDays
        : fallback;
    numer += i.pct * w;
    denom += w;
  }
  return {
    pct: round2(denom > 0 ? numer / denom : unweighted),
    weightedByDuration: true,
  };
}

/** "5.1.1.8" -> "5.1". The discipline trunk. */
export function trunkOf(wbs: string | null): string | null {
  if (!wbs) return null;
  const parts = wbs.split(".");
  return parts.length >= 2 ? parts.slice(0, 2).join(".") : wbs;
}

/** The leaves of the WBS - tasks that are not a parent of some other task. */
export function leavesOf(tasks: CeoTaskRow[]): CeoTaskRow[] {
  const parents = new Set(
    tasks.map((t) => t.parent_wbs_code).filter((c): c is string => !!c),
  );
  return tasks.filter((t) => !t.wbs_code || !parents.has(t.wbs_code));
}

// ------------------------------------------------------------------ progress

export type AreaProgress = {
  /** The parent summary task's name - "Phase 1", "Fencing Installation". */
  area: string;
  taskCount: number;
  actualPct: number;
  plannedPct: number | null;
  variance: number | null;
  complete: number;
  inProgress: number;
  notStarted: number;
  start: string | null;
  finish: string | null;
};

export type LateTask = {
  wbs: string;
  name: string;
  actualPct: number;
  plannedPct: number | null;
  finish: string;
  daysLate: number;
};

export type Progress = {
  /** Where the job is: duration-weighted reported percent across leaves. */
  actualPct: number;
  /** Where the plan says it should be on the as-of date. */
  plannedPct: number | null;
  /** actual - planned. Negative is behind. */
  variance: number | null;
  /**
   * How far off the pace the job is, in days: the plan reached today's actual
   * percent on this date. Negative days means behind, positive means ahead.
   */
  daysOffPlan: number | null;
  /** The date the plan expected to be at today's actual percent. */
  planReachedActualOn: string | null;
  weightedByDuration: boolean;
  /** True when the plan is a real baseline rather than the current dates. */
  againstBaseline: boolean;
  leafCount: number;
  complete: number;
  inProgress: number;
  notStarted: number;
  areas: AreaProgress[];
  late: LateTask[];
};

/**
 * Where the project is against where it was supposed to be.
 *
 * Both sides are duration-weighted over LEAF tasks only. Summary rows
 * ("Civil Construction", "Phase 1") are containers whose percent rolls up the
 * leaves beneath them, so counting both weights the same work twice.
 *
 * `daysOffPlan` is the number that survives a hallway conversation. A variance
 * of "-12 points" means nothing to most readers; "the plan expected to be here
 * on 12 August, which was 20 days ago" is the same fact in a form a CEO can
 * act on. It is found by walking the planned curve day by day to the first
 * date it reaches today's actual percent.
 */
export function computeProgress(
  tasks: CeoTaskRow[],
  asOf: string,
  checks: CeoCheck[],
): Progress {
  // Milestones are events, not work, and they are excluded from percent
  // complete on purpose. A contract milestone carries no duration, and
  // `durationWeighted` gives a task with no duration the AVERAGE weight of the
  // others rather than none - so dropping four completion milestones into the
  // schedule would silently push percent complete down as if a third of the
  // job had appeared out of nowhere. They belong in the dates section, where
  // the question is "will we hit it", not "how much of it is built".
  const leaves = leavesOf(tasks).filter((t) => !t.is_milestone);

  const actual = durationWeighted(
    leaves.map((t) => ({ pct: taskPct(t), durationDays: t.duration_days })),
  );

  const plannable = leaves.filter((t) => planWindow(t) != null);
  const planned =
    plannable.length === 0
      ? null
      : durationWeighted(
          plannable.map((t) => ({
            pct: plannedPct(t, asOf) ?? 0,
            durationDays: t.duration_days,
          })),
        ).pct;

  const againstBaseline =
    plannable.length > 0 && plannable.every((t) => t.baseline_start && t.baseline_end);

  if (leaves.length > 0 && !againstBaseline) {
    checks.push({
      id: "no-baseline",
      label: "Measured against the current schedule, not a baseline",
      severity: "warn",
      detail:
        "No baseline is set on this schedule, so 'supposed to be here' is read off the dates " +
        "the schedule carries today. If those dates have been moved to follow the work, the " +
        "comparison will look better than the job is. Setting a baseline fixes this and needs " +
        "no change to this report.",
    });
  }

  if (plannable.length < leaves.length) {
    checks.push({
      id: "tasks-without-dates",
      label: "Some tasks have no dates",
      severity: "warn",
      detail:
        `${leaves.length - plannable.length} of ${leaves.length} tasks carry no start and finish, ` +
        `so they are counted in progress but contribute nothing to the plan.`,
    });
  }

  // Walk the planned curve to find when it hit today's actual percent.
  const { daysOffPlan, planReachedActualOn } = pacing(plannable, actual.pct, asOf);

  const late: LateTask[] = leaves
    .filter((t) => t.end_date && t.end_date < asOf && taskPct(t) < 100)
    .map((t) => ({
      wbs: t.wbs_code ?? "-",
      name: t.task_name ?? "-",
      actualPct: taskPct(t),
      plannedPct: plannedPct(t, asOf),
      finish: t.end_date as string,
      daysLate: daysBetweenIso(t.end_date as string, asOf),
    }))
    .sort((a, b) => b.daysLate - a.daysLate);

  if (late.length > 0) {
    checks.push({
      id: "late-tasks",
      label: "Tasks past their finish date",
      severity: "warn",
      detail:
        `${late.length} task${late.length === 1 ? " has" : "s have"} passed the scheduled finish ` +
        `with work outstanding, the oldest by ${late[0].daysLate} days. Either the work slipped ` +
        `or the schedule has not been updated; both are worth knowing which.`,
    });
  }

  // Roll up by the PARENT summary task's name. Every Sweet Springs row carries
  // phase "Construction", so grouping on `phase` yields one row that says
  // nothing; the parent task is the breakdown a reader recognises.
  const nameByWbs = new Map<string, string>();
  for (const t of tasks) if (t.wbs_code) nameByWbs.set(t.wbs_code, t.task_name ?? t.wbs_code);

  const byArea = new Map<string, CeoTaskRow[]>();
  for (const t of leaves) {
    const key =
      (t.parent_wbs_code ? nameByWbs.get(t.parent_wbs_code) : null) ||
      t.phase?.trim() ||
      trunkOf(t.wbs_code) ||
      "Other";
    byArea.set(key, [...(byArea.get(key) ?? []), t]);
  }

  const areas: AreaProgress[] = Array.from(byArea.entries())
    .map(([area, rows]) => {
      const a = durationWeighted(
        rows.map((t) => ({ pct: taskPct(t), durationDays: t.duration_days })),
      );
      const datedRows = rows.filter((t) => planWindow(t) != null);
      const p =
        datedRows.length === 0
          ? null
          : durationWeighted(
              datedRows.map((t) => ({
                pct: plannedPct(t, asOf) ?? 0,
                durationDays: t.duration_days,
              })),
            ).pct;
      const starts = rows.map((t) => t.start_date).filter((d): d is string => !!d).sort();
      const finishes = rows.map((t) => t.end_date).filter((d): d is string => !!d).sort();
      return {
        area,
        taskCount: rows.length,
        actualPct: a.pct,
        plannedPct: p,
        variance: p == null ? null : round2(a.pct - p),
        complete: rows.filter((t) => taskPct(t) >= 100).length,
        inProgress: rows.filter((t) => taskPct(t) > 0 && taskPct(t) < 100).length,
        notStarted: rows.filter((t) => taskPct(t) === 0).length,
        start: starts[0] ?? null,
        finish: finishes[finishes.length - 1] ?? null,
      };
    })
    .sort((a, b) => (a.start ?? "9999").localeCompare(b.start ?? "9999"));

  const complete = leaves.filter((t) => taskPct(t) >= 100).length;
  const inProgress = leaves.filter((t) => taskPct(t) > 0 && taskPct(t) < 100).length;

  return {
    actualPct: actual.pct,
    plannedPct: planned,
    variance: planned == null ? null : round2(actual.pct - planned),
    daysOffPlan,
    planReachedActualOn,
    weightedByDuration: actual.weightedByDuration,
    againstBaseline,
    leafCount: leaves.length,
    complete,
    inProgress,
    notStarted: leaves.length - complete - inProgress,
    areas,
    late,
  };
}

/**
 * Translate a percentage gap into days.
 *
 * Walks the planned curve from the earliest planned start to the latest
 * planned finish, looking for the first day the plan reaches `actualPct`. That
 * date against the as-of date is how far off the pace the job is running.
 *
 * Returns nulls rather than a guess when the job has not started, when the
 * plan never reaches the actual percent (the job is ahead of its own final
 * date), or when there are no dates to walk.
 */
function pacing(
  plannable: CeoTaskRow[],
  actualPct: number,
  asOf: string,
): { daysOffPlan: number | null; planReachedActualOn: string | null } {
  if (plannable.length === 0) return { daysOffPlan: null, planReachedActualOn: null };

  const windows = plannable.map(planWindow).filter((w): w is { start: string; end: string } => !!w);
  const first = windows.map((w) => w.start).sort()[0];
  const last = windows.map((w) => w.end).sort().reverse()[0];
  if (!first || !last) return { daysOffPlan: null, planReachedActualOn: null };

  const span = daysBetweenIso(first, last);
  if (span < 0) return { daysOffPlan: null, planReachedActualOn: null };

  const curveAt = (d: string): number =>
    durationWeighted(
      plannable.map((t) => ({ pct: plannedPct(t, d) ?? 0, durationDays: t.duration_days })),
    ).pct;

  for (let i = 0; i <= span; i++) {
    const d = addDaysIso(first, i);
    if (curveAt(d) >= actualPct) {
      return { daysOffPlan: daysBetweenIso(asOf, d), planReachedActualOn: d };
    }
  }
  // The plan never gets as high as the job already is: running ahead of its own
  // finish. Reporting a day count here would be inventing one.
  return { daysOffPlan: null, planReachedActualOn: null };
}

// --------------------------------------------------------------------- dates

export type KeyDate = {
  label: string;
  date: string | null;
  /** Where the date came from, so a schedule date is not read as a contract one. */
  source: "contract" | "schedule" | "milestone";
  /** Days from the as-of date. Negative is in the past. */
  daysAway: number | null;
  done: boolean;
  /**
   * Days between the last of the scheduled WORK and this milestone. Positive
   * means the work is projected to finish after the date - the milestone is
   * threatened. Null when there is no work finish to compare against, or when
   * the milestone is already met.
   *
   * This is the comparison a completion date exists for. "Substantial
   * Completion 15 March" on its own is a diary entry; "Substantial Completion
   * 15 March, work currently lands 2 April, 18 days late" is a decision.
   */
  vsWorkFinish: number | null;
};

export type Dates = {
  /** Earliest scheduled start across the leaves. */
  start: string | null;
  /** Latest scheduled finish - when the job currently lands. */
  finish: string | null;
  /** The same finish as the plan had it, when a baseline exists. */
  baselineFinish: string | null;
  /** Days the current finish has moved past the baseline finish. */
  finishSlipDays: number | null;
  /** Calendar days from as-of to the finish. */
  daysRemaining: number | null;
  /** Share of the schedule window elapsed. */
  timeElapsedPct: number | null;
  /** Completion milestones, earliest first. */
  milestones: KeyDate[];
  /** Contract dates held on the project record (NTP, COD). */
  contract: KeyDate[];
  /** The last of the scheduled WORK, milestones excluded. */
  workFinish: string | null;
  /** Milestones the current work finish already runs past. */
  threatened: KeyDate[];
};

export function computeDates(
  project: CeoProjectRow,
  tasks: CeoTaskRow[],
  asOf: string,
): Dates {
  const leaves = leavesOf(tasks);
  const starts = leaves.map((t) => t.start_date).filter((d): d is string => !!d).sort();
  const finishes = leaves.map((t) => t.end_date).filter((d): d is string => !!d).sort();
  const start = starts[0] ?? null;
  const finish = finishes[finishes.length - 1] ?? null;

  // The end of the WORK, with milestones taken out. A completion milestone
  // dated beyond the last activity would otherwise become the project's finish
  // and hide the fact that the work lands earlier - or, worse, later.
  const workFinishes = leaves
    .filter((t) => !t.is_milestone)
    .map((t) => t.end_date)
    .filter((d): d is string => !!d)
    .sort();
  const workFinish = workFinishes[workFinishes.length - 1] ?? null;

  const baseFinishes = leaves
    .map((t) => t.baseline_end)
    .filter((d): d is string => !!d)
    .sort();
  const baselineFinish = baseFinishes[baseFinishes.length - 1] ?? null;

  const milestones: KeyDate[] = tasks
    .filter((t) => t.is_milestone && t.end_date)
    .map((t) => {
      const done = taskPct(t) >= 100;
      return {
        label: t.task_name ?? t.wbs_code ?? "Milestone",
        date: t.end_date,
        source: "milestone" as const,
        daysAway: daysBetweenIso(asOf, t.end_date as string),
        done,
        vsWorkFinish:
          done || !workFinish ? null : daysBetweenIso(t.end_date as string, workFinish),
      };
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const contract: KeyDate[] = [
    { label: "Notice to proceed", date: project.ntp_date, source: "contract" as const },
    { label: "Commercial operation", date: project.cod_date, source: "contract" as const },
  ]
    .filter((d) => d.date)
    .map((d) => {
      const done = (d.date as string) <= asOf;
      return {
        ...d,
        daysAway: daysBetweenIso(asOf, d.date as string),
        done,
        vsWorkFinish:
          done || !workFinish ? null : daysBetweenIso(d.date as string, workFinish),
      };
    });

  const elapsed =
    start && finish && daysBetweenIso(start, finish) > 0
      ? Math.max(
          0,
          Math.min(100, (daysBetweenIso(start, asOf) / daysBetweenIso(start, finish)) * 100),
        )
      : null;

  return {
    start,
    finish,
    baselineFinish,
    finishSlipDays:
      baselineFinish && finish ? daysBetweenIso(baselineFinish, finish) : null,
    daysRemaining: finish ? daysBetweenIso(asOf, finish) : null,
    timeElapsedPct: elapsed == null ? null : round2(elapsed),
    milestones,
    contract,
    workFinish,
    threatened: [...contract, ...milestones].filter(
      (k) => k.vsWorkFinish != null && k.vsWorkFinish > 0,
    ),
  };
}

// -------------------------------------------------------------------- photos

/**
 * Which photographs print.
 *
 * Newest first, at most one per activity so a heavily-inspected task does not
 * fill the page, and AHC's own photos ahead of a sub's for the same activity -
 * our verification is the stronger evidence. Once every activity has had a
 * turn the remaining slots fill with whatever is newest, so a short list is
 * still a full page.
 */
export function selectPhotos(candidates: CeoPhoto[], limit: number): CeoPhoto[] {
  // Deliberately does NOT require a signed URL. Selection runs BEFORE signing so
  // the loader signs six photographs rather than every one on the project - on
  // Sweet Springs that is 6 requests instead of 228, and it is what makes a
  // per-photo resize affordable. See `loadPhotos`.
  const byRecency = [...candidates].sort((a, b) => {
    const d = b.day.localeCompare(a.day);
    if (d !== 0) return d;
    // AHC verification photos outrank the sub's submission for the same day.
    const rank = (p: CeoPhoto) => (p.who.includes("(AHC)") ? 0 : 1);
    return rank(a) - rank(b);
  });

  const picked: CeoPhoto[] = [];
  const seenActivity = new Set<string>();
  for (const p of byRecency) {
    if (picked.length >= limit) break;
    const activity = p.taskKey ?? `${p.source}:${p.day}`;
    if (seenActivity.has(activity)) continue;
    seenActivity.add(activity);
    picked.push(p);
  }
  for (const p of byRecency) {
    if (picked.length >= limit) break;
    if (!picked.includes(p)) picked.push(p);
  }
  return picked;
}

// ----------------------------------------------------------------- the report

export type CeoReport = {
  asOf: string;
  project: {
    id: string;
    name: string;
    client: string | null;
    status: string | null;
    capacityMw: number | null;
  };
  progress: Progress;
  dates: Dates;
  photos: CeoPhoto[];
  photoCount: number;
  checks: CeoCheck[];
  /** The one-paragraph read, assembled from the numbers above. */
  headline: string;
};

const SEVERITY_RANK: Record<CheckSeverity, number> = { blocker: 0, warn: 1, ok: 2 };

export function buildCeoReport(input: CeoReportInput): CeoReport {
  const checks: CeoCheck[] = [];

  if (input.tasks.length === 0) {
    checks.push({
      id: "no-schedule",
      label: "No schedule",
      severity: "blocker",
      detail:
        "This project has no schedule tasks, so there is nothing to report progress against.",
    });
  }

  const progress = computeProgress(input.tasks, input.asOf, checks);
  const dates = computeDates(input.project, input.tasks, input.asOf);

  // A schedule that models one branch of a wider contract describes that branch
  // only. Saying so matters more here than on a money report, because "62%
  // complete" reads as the whole job unless it is qualified.
  const trunks = Array.from(
    new Set(leavesOf(input.tasks).map((t) => trunkOf(t.wbs_code)).filter((t): t is string => !!t)),
  ).sort();
  if (trunks.length === 1 && progress.leafCount > 0) {
    checks.push({
      id: "partial-scope",
      label: "The schedule covers one branch of the work",
      severity: "warn",
      detail:
        `All ${progress.leafCount} tasks sit under WBS ${trunks[0]}. Percent complete below ` +
        `describes that branch, not the whole contract - scope that is not in the schedule is ` +
        `neither counted as done nor as outstanding.`,
    });
  }

  // Completion dates are the obligations the contract is judged on, and a
  // report that silently omits them reads as though there are none.
  if (dates.milestones.length === 0) {
    checks.push({
      id: "no-completion-milestones",
      label: "No completion milestones are recorded",
      severity: "blocker",
      detail:
        "Mechanical Completion, Substantial Completion, Placed in Service and Final Completion " +
        "are line items on the schedule of values but carry no dates anywhere in the platform, " +
        "so this report cannot say whether the job is tracking to hit them. Add them to the " +
        "schedule as milestones and they appear here automatically.",
    });
  }

  // A milestone the work already runs past is the most consequential thing this
  // report can surface, so each one is raised on its own rather than summarised.
  for (const k of dates.threatened) {
    checks.push({
      id: `milestone-threatened-${k.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      label: `${k.label} is at risk`,
      severity: "blocker",
      detail:
        `${k.label} is dated ${longDate(k.date)}, but the scheduled work does not finish until ` +
        `${longDate(dates.workFinish)} - ${k.vsWorkFinish} days past it. Measured off the ` +
        `schedule as it stands today, so it moves as the schedule does.`,
    });
  }

  if (input.photos.length === 0) {
    checks.push({
      id: "no-photos",
      label: "No site photographs",
      severity: "warn",
      detail:
        "No inspection or daily-log photographs were found for this project, so the report has " +
        "nothing to show of the work itself.",
    });
  }

  checks.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const photos = input.photos.filter((p) => p.url);

  return {
    asOf: input.asOf,
    project: {
      id: input.project.id,
      name: input.project.name,
      client: input.project.client,
      status: input.project.status,
      capacityMw: input.project.dc_capacity_mw,
    },
    progress,
    dates,
    photos,
    photoCount: input.photoCandidateCount ?? photos.length,
    checks,
    headline: headlineFor(progress, dates),
  };
}

/** Plain-English date, matching the rest of the app's printed reports. */
export function longDate(iso: string | null): string {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The paragraph a CEO reads if they read nothing else.
 *
 * Built from the figures rather than written, so it cannot drift from the
 * tables underneath it. Each clause drops when its input is unavailable.
 */
export function headlineFor(progress: Progress, dates: Dates): string {
  const parts: string[] = [];

  if (progress.leafCount > 0) {
    parts.push(
      `The job is ${progress.actualPct.toFixed(1)}% complete across ${progress.leafCount} tasks - ` +
        `${progress.complete} finished, ${progress.inProgress} under way, ` +
        `${progress.notStarted} not started.`,
    );
  }

  if (progress.plannedPct != null && progress.variance != null) {
    const behind = progress.variance < 0;
    const gap = Math.abs(progress.variance).toFixed(1);
    let s = `The plan says it should be ${progress.plannedPct.toFixed(1)}%, so it is ${gap} points ${behind ? "behind" : "ahead of"} where it should be`;
    if (progress.daysOffPlan != null && progress.planReachedActualOn) {
      s += `${behind ? " - " : " - "}the pace it is running is the pace the plan expected on ${longDate(progress.planReachedActualOn)}, ${Math.abs(progress.daysOffPlan)} days ${progress.daysOffPlan < 0 ? "ago" : "from now"}`;
    }
    parts.push(`${s}.`);
  }

  if (dates.finish) {
    const remaining =
      dates.daysRemaining == null
        ? ""
        : ` - ${Math.abs(dates.daysRemaining)} days ${dates.daysRemaining < 0 ? "past that date" : "away"}`;
    parts.push(`It currently finishes ${longDate(dates.finish)}${remaining}.`);
  }

  if (dates.finishSlipDays != null && dates.finishSlipDays !== 0) {
    parts.push(
      `That is ${Math.abs(dates.finishSlipDays)} days ${dates.finishSlipDays > 0 ? "later than" : "earlier than"} the baseline finish.`,
    );
  }

  if (progress.late.length > 0) {
    parts.push(
      `${progress.late.length} task${progress.late.length === 1 ? " is" : "s are"} past ` +
        `${progress.late.length === 1 ? "its" : "their"} finish date, the oldest by ` +
        `${progress.late[0].daysLate} days.`,
    );
  }

  // Completion dates lead the closing sentence when one is threatened: it is the
  // only thing on this report with a contractual consequence attached.
  if (dates.threatened.length > 0) {
    const worst = dates.threatened.reduce((a, b) =>
      (b.vsWorkFinish ?? 0) > (a.vsWorkFinish ?? 0) ? b : a,
    );
    parts.push(
      `${worst.label} is dated ${longDate(worst.date)} and the work is not projected to finish ` +
        `until ${longDate(dates.workFinish)} - ${worst.vsWorkFinish} days past it.`,
    );
  } else if (dates.milestones.length === 0) {
    parts.push(
      "No completion milestones are on record, so nothing here speaks to the contract dates.",
    );
  }

  return parts.join(" ");
}
