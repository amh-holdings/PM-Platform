// What kind of task this is decides where its progress can come from.
//
// A construction activity is measured in the field and its percent complete
// comes only from approved daily reports. A deliverable is done when something
// arrives - a design package, a signed contract, a permit, a passed inspection
// - and no daily report will ever cover it. Procurement is equipment on order:
// a lead time running down and a truck arriving on site, against a purchase
// order rather than a field report.
//
// Null means not classified yet. Migration 0051 adds the column empty on
// purpose: the classification is reviewed per project before it is written.
// 0057 adds procurement.

export const TASK_TYPES = ["construction", "deliverable", "procurement"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  construction: "Construction",
  deliverable: "Deliverable",
  procurement: "Procurement",
};

export const TASK_TYPE_HELP =
  "Construction: measured in the field, progress from approved daily reports. " +
  "Deliverable: done when something is received - a design package, signed contract, permit or inspection. " +
  "Procurement: equipment on order, done when it is delivered to site.";

/**
 * Whether a percent can be typed in rather than taken from a field report.
 *
 * Construction cannot, and that is deliberate: a number somebody typed is a
 * number nobody can defend in a pay application, which is the whole reason the
 * schedule is sourced from approved daily reports.
 *
 * Neither of the other two has a report to take a percent from. A permit is
 * issued or it is not; a transformer is on site or it is not. Refusing the
 * edit there does not protect anything, it just leaves the row stuck on "No
 * report" forever, which is what Sweet Springs procurement has been doing.
 *
 * An unclassified row stays locked. Classify it first and the question
 * answers itself.
 */
export function progressCanBeSetByHand(taskType: string | null | undefined): boolean {
  return taskType === "deliverable" || taskType === "procurement";
}

/**
 * Whether the planned finish is a commitment rather than a span of measured
 * work. Both non-construction kinds are: the date holds while it is ahead and
 * the task is overdue once it has passed, rather than the forecast assuming
 * the whole duration is still to run.
 */
export function finishIsACommitment(taskType: string | null | undefined): boolean {
  return taskType === "deliverable" || taskType === "procurement";
}

/** The status value that means the task is finished. */
export const COMPLETE_STATUS = "Complete";

/**
 * The progress a status change implies, or null when it implies nothing.
 *
 * Zarina: "I should set the status complete and it will automatically update
 * that it is done." She is right, and the percent box plus a Done button
 * beside a Status column that already says Complete was two controls for one
 * fact.
 *
 * Only the two non-construction kinds. Construction progress comes from
 * approved field reports, and letting a status dropdown write 100% there would
 * put a number on a pay application that no report stands behind.
 *
 * It works in both directions. Setting Complete writes 100. Moving off
 * Complete on a row sitting at exactly 100 clears it back to no report, which
 * is what makes Undo behave: the undo sends the old status back and the
 * percent follows it rather than being stranded.
 *
 * A row already reading the right thing returns null so nothing is written.
 * A percent typed by hand that is not 100 is left alone when the status moves,
 * because a half-delivered order at 40% is a fact somebody entered, not a
 * leftover.
 */
export function progressFromStatus(input: {
  taskType: string | null | undefined;
  status: string | null | undefined;
  currentPct: number | null | undefined;
}): { pct_complete: number | null; status_source: string | null } | null {
  if (!progressCanBeSetByHand(input.taskType)) return null;

  const pct = input.currentPct == null ? null : Number(input.currentPct);
  const complete = (input.status ?? "").trim() === COMPLETE_STATUS;

  if (complete) {
    return pct === 100 ? null : { pct_complete: 100, status_source: "manual" };
  }
  return pct === 100 ? { pct_complete: null, status_source: null } : null;
}
