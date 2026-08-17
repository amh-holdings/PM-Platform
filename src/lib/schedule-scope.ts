// Discipline scope for a schedule task.
//
// Derived rather than stored. The WBS already encodes discipline under the
// Construction branch (5.1 civil, 5.2 mechanical, 5.3 electrical, 5.4 the
// completion milestones), and everything outside that branch is separated
// cleanly enough by phase. Deriving avoids a migration and, more importantly,
// avoids a stored column drifting out of sync with the WBS whenever the
// schedule is re-baselined.
//
// The `phase` field cannot do this on its own: "Construction" covers civil,
// mechanical and electrical together, which is most of the schedule.

export type TaskScope =
  | "Civil"
  | "Mechanical"
  | "Electrical"
  | "Completion"
  | "Contracts"
  | "Permitting"
  | "Engineering"
  | "Procurement"
  | "Other";

// Order used for the scope filter. Civil leads because it is the only
// discipline currently reporting from the field.
export const SCOPE_ORDER: TaskScope[] = [
  "Civil",
  "Mechanical",
  "Electrical",
  "Completion",
  "Contracts",
  "Permitting",
  "Engineering",
  "Procurement",
  "Other",
];

const WBS_PREFIX: [string, TaskScope][] = [
  ["5.1", "Civil"],
  ["5.2", "Mechanical"],
  ["5.3", "Electrical"],
  ["5.4", "Completion"],
];

// "Enginering" is misspelled in the imported schedule data; map it rather than
// rewriting 17 rows and risking a mismatch with anything keyed on the old value.
const PHASE_SCOPE: Record<string, TaskScope> = {
  Contracts: "Contracts",
  Permitting: "Permitting",
  Enginering: "Engineering",
  Engineering: "Engineering",
  Procurement: "Procurement",
};

export function scopeOf(task: {
  wbs_code?: string | null;
  phase?: string | null;
}): TaskScope {
  const wbs = task.wbs_code ?? "";
  for (const [prefix, scope] of WBS_PREFIX) {
    if (wbs === prefix || wbs.startsWith(prefix + ".")) return scope;
  }
  const phase = task.phase ?? "";
  return PHASE_SCOPE[phase] ?? "Other";
}
