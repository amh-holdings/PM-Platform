// The month retainage is released, from the contract's release event.
//
// projects.retainage_release_event has been captured on the edit form since the
// project settings existed, and the cash flow ignored it. Retainage was dumped
// into "the last month anything else happens, plus one", which on Sweet Springs
// put a $146,687 receipt in Apr 2027 against a contract that releases at Final
// Completion - 2027-06-02 on the schedule. Three months early, on the single
// largest receipt left in the job.
//
// The date comes from the schedule rather than a stored field, because the
// schedule is where completion dates live and move. Mechanical Completion,
// Placed in Service, Substantial Completion and Final Completion are all tasks
// under 5.4 on Sweet Springs, and they shift when the job shifts. A date copied
// into projects would be stale the first time the schedule moved.
//
// Falls back in order: the schedule milestone, then the guaranteed date on the
// project, then null. Null means the caller keeps its old behaviour, so a
// project with no release event set is unaffected.

import { addMonthsIso, monthIsoFromDate, shiftByDaysToMonth } from "@/lib/cashflow";

export type ReleaseEvent =
  | "substantial_completion"
  | "final_completion"
  | "cod_plus_30"
  | "cod_plus_60";

export type ReleaseTask = { task_name: string; end_date: string | null };

export type ReleaseResolution = {
  /** YYYY-MM-01 the retainage is released, or null if it cannot be resolved. */
  month: string | null;
  /** Where the date came from, for the note under the number. */
  source: "schedule" | "guaranteed_date" | "cod" | null;
  /** The task or field the date came from. */
  via: string | null;
  /** Why there is no month, when there isn't one. */
  why: string | null;
};

/**
 * Matches a completion milestone by name. Deliberately name-based: these tasks
 * carry no flag saying which completion they are, and the WBS code they sit at
 * changes every time the schedule is rebaselined - Sweet Springs' moved from
 * 5.1.2.x to 5.4.x in the civil-only rebaseline, which is exactly how the owner
 * SOV lost its links. A name survives a renumber.
 */
function findMilestone(tasks: readonly ReleaseTask[], pattern: RegExp): ReleaseTask | null {
  const hits = tasks.filter((t) => t.end_date && pattern.test(t.task_name));
  if (hits.length === 0) return null;
  // The latest, so a summary row and its leaf do not disagree, and so a
  // "Substantial Completion" punch task cannot pre-empt the real milestone.
  return hits.reduce((a, b) => ((b.end_date ?? "") > (a.end_date ?? "") ? b : a));
}

export function resolveRetainageRelease(input: {
  event: string | null | undefined;
  tasks: readonly ReleaseTask[];
  codDate?: string | null;
  guaranteedSubstantialCompletion?: string | null;
}): ReleaseResolution {
  const event = (input.event ?? "").trim() as ReleaseEvent | "";
  if (!event) {
    return { month: null, source: null, via: null, why: "no release event is set on the project" };
  }

  if (event === "cod_plus_30" || event === "cod_plus_60") {
    const days = event === "cod_plus_30" ? 30 : 60;
    if (input.codDate) {
      return {
        month: shiftByDaysToMonth(monthIsoFromDate(input.codDate), days),
        source: "cod",
        via: `COD ${input.codDate} plus ${days} days`,
        why: null,
      };
    }
    return {
      month: null,
      source: null,
      via: null,
      why: `releases ${days} days after COD and the project has no COD date`,
    };
  }

  if (event === "substantial_completion") {
    const task = findMilestone(input.tasks, /substantial\s+completion/i);
    if (task?.end_date) {
      return { month: monthIsoFromDate(task.end_date), source: "schedule", via: task.task_name, why: null };
    }
    if (input.guaranteedSubstantialCompletion) {
      return {
        month: monthIsoFromDate(input.guaranteedSubstantialCompletion),
        source: "guaranteed_date",
        via: "the guaranteed substantial completion date",
        why: null,
      };
    }
    return {
      month: null,
      source: null,
      via: null,
      why: "releases at substantial completion and the schedule has no such milestone",
    };
  }

  // final_completion
  const task = findMilestone(input.tasks, /final\s+completion/i);
  if (task?.end_date) {
    return { month: monthIsoFromDate(task.end_date), source: "schedule", via: task.task_name, why: null };
  }
  // Substantial completion plus a year is the usual warranty tail, but guessing
  // it would put a six-figure receipt in a month nobody chose. Named instead.
  return {
    month: null,
    source: null,
    via: null,
    why: "releases at final completion and the schedule has no Final Completion milestone",
  };
}

/** One line explaining where the release month came from. */
export function describeRelease(at: ReleaseResolution, ownerTermsDays: number): string {
  if (!at.month) return `Retainage has no release month: it ${at.why}.`;
  const owner = ownerTermsDays > 0 ? shiftByDaysToMonth(at.month, ownerTermsDays) : at.month;
  const label = (iso: string) => iso.slice(0, 7);
  const from =
    at.source === "schedule"
      ? `the schedule's ${at.via}`
      : at.source === "cod"
        ? at.via
        : at.via ?? "the project settings";
  const ownerPart =
    owner === at.month
      ? ""
      : `, and the owner's share lands ${label(owner)} on Net ${ownerTermsDays}`;
  return `Retainage releases ${label(at.month)}, from ${from}${ownerPart}.`;
}

/** The month the owner's retainage reaches the bank, terms applied. */
export function ownerReleaseMonth(releaseMonth: string, ownerTermsDays: number): string {
  return ownerTermsDays > 0 ? shiftByDaysToMonth(releaseMonth, ownerTermsDays) : releaseMonth;
}

/** Kept for the fallback path: the old behaviour, last active month plus one. */
export function fallbackReleaseMonth(lastBucketMonth: string): string {
  return addMonthsIso(lastBucketMonth, 1);
}
