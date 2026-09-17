// What kind of task this is decides where its progress can come from.
//
// A construction activity is measured in the field and its percent complete
// comes only from approved daily reports. A deliverable is done when something
// arrives - a design package, a signed contract, a permit, a passed inspection
// - and no daily report will ever cover it.
//
// Null means not classified yet. Migration 0051 adds the column empty on
// purpose: the classification is reviewed per project before it is written.

export const TASK_TYPES = ["construction", "deliverable"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  construction: "Construction",
  deliverable: "Deliverable",
};

export const TASK_TYPE_HELP =
  "Construction: measured in the field, progress from approved daily reports. " +
  "Deliverable: done when something is received - a design package, signed contract, permit or inspection.";
