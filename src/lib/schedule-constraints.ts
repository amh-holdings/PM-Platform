// Constraint log - types and the pure logic around them.
//
// The Last Planner idea: a task is not ready to start until everything in its
// way has been cleared, and the things in its way are tracked with a name and
// a date rather than remembered. The look-ahead stops being a broadcast and
// becomes a list of commitments somebody has actually checked is possible.
//
// Nothing here touches the database. Anything that reads "is this task ready"
// has to be usable inside the schedule table, the Gantt and the look-ahead,
// all of which already hold the task rows in memory.

import { parseIso, workingDaysBetween, type CalendarLike } from "@/lib/schedule-calendar";

export const CONSTRAINT_CATEGORIES = [
  "Material",
  "Equipment",
  "Labor",
  "Access",
  "Permit",
  "Design",
  "Submittal",
  "Inspection",
  "Predecessor",
  "Weather",
  "Other",
] as const;

export type ConstraintCategory = (typeof CONSTRAINT_CATEGORIES)[number];

export const CONSTRAINT_STATUSES = [
  "open",
  "in_progress",
  "cleared",
  "wont_clear",
] as const;

export type ConstraintStatus = (typeof CONSTRAINT_STATUSES)[number];

export const CONSTRAINT_STATUS_LABELS: Record<ConstraintStatus, string> = {
  open: "Open",
  in_progress: "Working",
  cleared: "Cleared",
  wont_clear: "Will not clear",
};

// What each category means in the field, shown as help text so the log stays
// consistent between whoever is filling it in.
export const CONSTRAINT_CATEGORY_HINTS: Record<ConstraintCategory, string> = {
  Material: "Not on site, or on site and not accepted",
  Equipment: "Plant or tooling not available",
  Labor: "Crew not available or not qualified",
  Access: "Cannot physically get to the work",
  Permit: "Agency approval outstanding",
  Design: "Drawing, detail or RFI answer outstanding",
  Submittal: "Approval outstanding",
  Inspection: "Has to pass before the next thing starts",
  Predecessor: "Upstream work not complete",
  Weather: "Ground or site conditions",
  Other: "Anything else in the way",
};

export type ScheduleConstraint = {
  id: string;
  project_id: string;
  wbs_code: string | null;
  category: ConstraintCategory;
  title: string;
  description: string | null;
  owner: string | null;
  need_by: string | null;
  status: ConstraintStatus;
  cleared_at: string | null;
  resolution: string | null;
  source: string;
  source_id: string | null;
  created_at: string | null;
};

export function isOpen(c: ScheduleConstraint): boolean {
  return c.status === "open" || c.status === "in_progress";
}

export type ConstraintUrgency = "overdue" | "due" | "upcoming" | "clear" | "none";

// How urgent a constraint is, measured against the data date rather than
// today. An open constraint whose need-by has passed is the single most
// actionable row in the app: the work it gates cannot start and the date it
// was supposed to be cleared by is already behind us.
export function urgencyOf(
  c: ScheduleConstraint,
  dataDate: string,
  cal: CalendarLike = 5,
): { urgency: ConstraintUrgency; days: number | null } {
  if (!isOpen(c)) return { urgency: "clear", days: null };
  if (!c.need_by) return { urgency: "none", days: null };
  const days = workingDaysBetween(dataDate, c.need_by, cal);
  if (parseIso(c.need_by) < parseIso(dataDate)) return { urgency: "overdue", days };
  if (days <= 5) return { urgency: "due", days };
  return { urgency: "upcoming", days };
}

export type TaskConstraintState = {
  open: number;
  overdue: number;
  /** The soonest need-by among open constraints, or null. */
  nextNeedBy: string | null;
  /** True when nothing open stands in the way. */
  ready: boolean;
};

// Roll the log up per task so the schedule table and the look-ahead can show
// "3 open, 1 overdue" against a row without each of them re-deriving it.
export function constraintsByTask(
  constraints: ScheduleConstraint[],
  dataDate: string,
  cal: CalendarLike = 5,
): Map<string, TaskConstraintState> {
  const out = new Map<string, TaskConstraintState>();
  for (const c of constraints) {
    if (!c.wbs_code) continue;
    const state =
      out.get(c.wbs_code) ??
      { open: 0, overdue: 0, nextNeedBy: null as string | null, ready: true };
    if (isOpen(c)) {
      state.open++;
      state.ready = false;
      if (urgencyOf(c, dataDate, cal).urgency === "overdue") state.overdue++;
      if (c.need_by && (!state.nextNeedBy || c.need_by < state.nextNeedBy))
        state.nextNeedBy = c.need_by;
    }
    out.set(c.wbs_code, state);
  }
  return out;
}

export type ConstraintSummary = {
  total: number;
  open: number;
  overdue: number;
  dueSoon: number;
  cleared: number;
  wontClear: number;
  /** Tasks with at least one open constraint. */
  blockedTasks: number;
  byCategory: { category: ConstraintCategory; open: number; total: number }[];
};

export function summarizeConstraints(
  constraints: ScheduleConstraint[],
  dataDate: string,
  cal: CalendarLike = 5,
): ConstraintSummary {
  const counts = new Map<ConstraintCategory, { open: number; total: number }>();
  const blocked = new Set<string>();
  let open = 0, overdue = 0, dueSoon = 0, cleared = 0, wontClear = 0;

  for (const c of constraints) {
    const entry = counts.get(c.category) ?? { open: 0, total: 0 };
    entry.total++;
    if (isOpen(c)) {
      entry.open++;
      open++;
      if (c.wbs_code) blocked.add(c.wbs_code);
      const u = urgencyOf(c, dataDate, cal).urgency;
      if (u === "overdue") overdue++;
      else if (u === "due") dueSoon++;
    } else if (c.status === "cleared") cleared++;
    else if (c.status === "wont_clear") wontClear++;
    counts.set(c.category, entry);
  }

  const byCategory = Array.from(counts.entries())
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.open - a.open || b.total - a.total);

  return {
    total: constraints.length,
    open,
    overdue,
    dueSoon,
    cleared,
    wontClear,
    blockedTasks: blocked.size,
    byCategory,
  };
}

// Plain-text constraint report, for the same reason the look-ahead has one:
// the weekly conversation happens over email and the list has to arrive in a
// form nobody has to re-key.
export function constraintsToText(
  constraints: ScheduleConstraint[],
  projectName: string,
  dataDate: string,
  taskNames: Map<string, string> = new Map(),
): string {
  const openOnes = constraints
    .filter(isOpen)
    .sort((a, b) => (a.need_by ?? "9999").localeCompare(b.need_by ?? "9999"));

  const lines: string[] = [
    `${projectName} - open constraints as of ${dataDate}`,
    "",
  ];
  if (!openOnes.length) {
    lines.push("Nothing open.");
    return lines.join("\n");
  }
  for (const c of openOnes) {
    const u = urgencyOf(c, dataDate).urgency;
    const mark = u === "overdue" ? "OVERDUE" : u === "due" ? "DUE SOON" : "";
    const task = c.wbs_code
      ? ` [${c.wbs_code}${taskNames.get(c.wbs_code) ? ` ${taskNames.get(c.wbs_code)}` : ""}]`
      : "";
    lines.push(
      `* ${c.category}: ${c.title}${task}`,
    );
    lines.push(
      `    owner ${c.owner ?? "unassigned"} | need by ${c.need_by ?? "no date"}${mark ? ` | ${mark}` : ""}`,
    );
    if (c.description) lines.push(`    ${c.description}`);
  }
  return lines.join("\n");
}
