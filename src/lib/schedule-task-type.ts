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
