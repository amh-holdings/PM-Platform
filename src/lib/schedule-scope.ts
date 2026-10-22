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
  | "Structural"
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
  "Structural",
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

/**
 * Outline words that name a DISCIPLINE.
 *
 * These beat the phase words below, wherever they sit in the chain. Sussex
 * names its engineering packages "Civil - IFP (Issued For Permit)", so the
 * nearest ancestor of 1.2.1.4.1 Design carries both "civil" and "permit". Read
 * nearest-match-wins, that design row filed itself under Permitting and the
 * permitting sheet came out with nine engineering deliverables on it.
 */
const DISCIPLINE_WORDS: [RegExp, TaskScope][] = [
  [/\bstructural\b/, "Structural"],
  [/\bmechanical\b/, "Mechanical"],
  [/\belectrical\b/, "Electrical"],
  [/\bcivil\b/, "Civil"],
];

/**
 * Outline words that name a PHASE.
 *
 * Matched on whole words. A substring match read Sussex's "Contractor Permits"
 * branch as Contracts, which is a different thing entirely: \bcontracts?\b
 * cannot match inside "Contractor", so that branch falls through to the permit
 * rule, which is what it is.
 */
const PHASE_WORDS: [RegExp, TaskScope][] = [
  [/\bcommissioning\b/, "Completion"],
  [/\bprocurements?\b/, "Procurement"],
  [/\bengine{1,2}ring\b/, "Engineering"],
  [/\bpermitting\b/, "Permitting"],
  [/\bcompletion\b/, "Completion"],
  [/\bcloseout\b/, "Completion"],
  [/\bcontracts?\b/, "Contracts"],
  [/\bpermits?\b/, "Permitting"],
  [/\bdesign\b/, "Engineering"],
];

function match(
  words: [RegExp, TaskScope][],
  name: string | null | undefined,
): TaskScope | null {
  const n = (name ?? "").toLowerCase();
  if (!n) return null;
  for (const [word, scope] of words) {
    if (word.test(n)) return scope;
  }
  return null;
}

/**
 * Which discipline or phase a schedule task belongs to.
 *
 * Three readings, in order, because two live schedules number themselves
 * differently and neither is wrong.
 *
 * 1. The WBS prefix. Sweet Springs puts every discipline under a 5.x branch,
 *    which is exact and costs nothing to read.
 * 2. The `phase` column, where it is filled in.
 * 3. The outline. Sussex does neither: its WBS runs 1 Engineering, 2
 *    Permitting, 3 Procurement, 4 Construction, and `phase` is not set on the
 *    rows added since. Every one of its 165 tasks read as Other, which made
 *    the scope filter a dropdown with one useless option in it, and would have
 *    headed a printed permitting sheet "Other scope". The chain is read whole,
 *    discipline before phase - see DISCIPLINE_WORDS.
 *
 * `nameByWbs` is what makes reading 3 possible. Without it the function
 * behaves exactly as it did before, so a caller that has no task list is not
 * forced to build one.
 */
export function scopeOf(
  task: {
    wbs_code?: string | null;
    phase?: string | null;
    task_name?: string | null;
  },
  nameByWbs?: ReadonlyMap<string, string>,
): TaskScope {
  const wbs = task.wbs_code ?? "";
  for (const [prefix, scope] of WBS_PREFIX) {
    if (wbs === prefix || wbs.startsWith(prefix + ".")) return scope;
  }

  const phase = task.phase ?? "";
  const byPhase = PHASE_SCOPE[phase];
  if (byPhase) return byPhase;

  // Walk the whole ancestor chain, nearest first, rather than stopping at the
  // first name that says anything. A discipline anywhere above the row wins
  // over a phase word, however near that phase word sits: "Civil - IFP (Issued
  // For Permit)" is a civil engineering package, not permitting work.
  if (nameByWbs && wbs) {
    let nearestPhase: TaskScope | null = null;
    let at = wbs;
    for (;;) {
      const dot = at.lastIndexOf(".");
      if (dot === -1) break;
      at = at.slice(0, dot);
      const name = nameByWbs.get(at);
      const discipline = match(DISCIPLINE_WORDS, name);
      if (discipline) return discipline;
      if (!nearestPhase) nearestPhase = match(PHASE_WORDS, name);
    }
    if (nearestPhase) return nearestPhase;
  }

  // A top-level branch has no ancestor to read, so it names itself.
  return (
    match(DISCIPLINE_WORDS, task.task_name) ??
    match(PHASE_WORDS, task.task_name) ??
    "Other"
  );
}

/** The lookup `scopeOf` wants, built once for a whole schedule. */
export function nameByWbs(
  tasks: readonly { wbs_code?: string | null; task_name?: string | null }[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tasks) {
    const code = t.wbs_code ?? "";
    const name = t.task_name ?? "";
    if (code && name) m.set(code, name);
  }
  return m;
}
