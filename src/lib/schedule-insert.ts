// Put a new row exactly where somebody points, instead of at the end.
//
// Zarina: "I need to add a row in the schedule wherever I want. Not add it at
// the bottom and just drag to where I want it."
//
// Add task put the new row after the last task in its branch. On a branch with
// twenty rows, a task that belongs third meant adding it and then dragging it
// seventeen places, every time.
//
// The WBS code is NOT renumbered to make room, and that is deliberate. It is
// the rule planIndent already states: a WBS code here is an identifier other
// records point at - billing lines, sub SOV lines, PO delivery links,
// inspections, predecessors - and renumbering a branch to close a cosmetic gap
// is how those references get orphaned. Position lives in sort_order.
//
// So the new row takes the next free code under its parent and lands in the
// slot you picked. Inserting above 4.4.2.1 gives you a row numbered 4.4.2.8
// sitting first in the branch, which looks odd for about a second and costs
// nothing. Sort by WBS is there when somebody wants the numbers and the order
// reconciled, and it moves rows rather than renaming them.

import {
  childrenOf,
  depthOf,
  descendantsOf,
  nextChildCode,
  parentCodeOf,
  type EditTask,
} from "@/lib/schedule-edit";

export type InsertPosition = "above" | "below" | "child";

export type InsertPlan = {
  ok: boolean;
  error?: string;
  /** The code offered for the new row. */
  wbs: string;
  parentWbs: string | null;
  level: number;
  sortOrder: number;
  /**
   * Rows to respace, when the two rows either side of the slot left no room
   * between them. Empty in the ordinary case.
   */
  sortUpdates: { id: string; sort_order: number }[];
  /** One line for the dialog saying where the row will land. */
  note: string;
};

const SPACING = 10;

function fail(error: string): InsertPlan {
  return {
    ok: false,
    error,
    wbs: "",
    parentWbs: null,
    level: 1,
    sortOrder: SPACING,
    sortUpdates: [],
    note: "",
  };
}

/** Display order: sort_order, then the order the caller passed, never by code. */
function inDisplayOrder(tasks: readonly EditTask[]): EditTask[] {
  return tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const sa = a.t.sort_order ?? Number.MAX_SAFE_INTEGER;
      const sb = b.t.sort_order ?? Number.MAX_SAFE_INTEGER;
      return sa === sb ? a.i - b.i : sa - sb;
    })
    .map((x) => x.t);
}

/**
 * The index the new row occupies in display order.
 *
 * Below and child both clear the anchor's whole subtree. Dropping a row
 * directly after a summary would put it between the summary and its own
 * children, which reads as the first child and is not what anybody means by
 * "below this".
 */
function slotIndexFor(
  ordered: EditTask[],
  anchor: EditTask,
  position: InsertPosition,
): number {
  const at = ordered.indexOf(anchor);
  if (position === "above") return at;

  const kin = new Set(descendantsOf(ordered, anchor.wbs_code).map((d) => d.id));
  let last = at;
  for (let i = at + 1; i < ordered.length; i++) {
    if (!kin.has(ordered[i].id)) break;
    last = i;
  }
  return last + 1;
}

export function planInsertAt(input: {
  tasks: readonly EditTask[];
  anchorWbs: string;
  position: InsertPosition;
}): InsertPlan {
  const ordered = inDisplayOrder(input.tasks);
  const anchor = ordered.find((t) => t.wbs_code === input.anchorWbs);
  if (!anchor) return fail(`${input.anchorWbs} is not on this schedule.`);

  const parentWbs =
    input.position === "child" ? anchor.wbs_code : parentCodeOf(anchor.wbs_code);
  const wbs = nextChildCode(ordered, parentWbs);
  const slot = slotIndexFor(ordered, anchor, input.position);

  const before = slot > 0 ? ordered[slot - 1] : null;
  const after = slot < ordered.length ? ordered[slot] : null;

  const lo = before?.sort_order ?? null;
  const hi = after?.sort_order ?? null;

  let sortOrder: number;
  let sortUpdates: InsertPlan["sortUpdates"] = [];

  if (lo == null && hi == null) {
    sortOrder = SPACING;
  } else if (lo == null) {
    // Going in at the very top. Half the first row's slot, unless it is
    // already sitting on 1 or less and there is nothing to halve.
    sortOrder = (hi as number) - SPACING;
    if (sortOrder >= (hi as number) || !Number.isFinite(sortOrder)) {
      ({ sortOrder, sortUpdates } = respace(ordered, slot));
    }
  } else if (hi == null) {
    sortOrder = lo + SPACING;
  } else {
    // sort_order is an integer column, so the midpoint has to be one. A
    // fractional 1.5 between rows on 1 and 2 gets rounded on the way into
    // Postgres and lands on top of the row it was supposed to precede.
    const mid = Math.floor((lo + hi) / 2);
    // No whole number between them: two rows on the same value, or on
    // consecutive ones. Respace the list by tens and take the gap that opens.
    if (mid <= lo || mid >= hi) {
      ({ sortOrder, sortUpdates } = respace(ordered, slot));
    } else {
      sortOrder = mid;
    }
  }

  const where =
    input.position === "child"
      ? `inside ${anchor.wbs_code} ${anchor.task_name}`
      : input.position === "above"
        ? `above ${anchor.wbs_code} ${anchor.task_name}`
        : `below ${anchor.wbs_code} ${anchor.task_name}`;
  const respaced = sortUpdates.length
    ? ` ${sortUpdates.length} row${sortUpdates.length === 1 ? "" : "s"} are respaced to make room, which changes their order on screen not their codes.`
    : "";

  return {
    ok: true,
    wbs,
    parentWbs,
    level: depthOf(wbs),
    sortOrder,
    sortUpdates,
    note: `${wbs} will be added ${where}.${respaced}`,
  };
}

/**
 * Renumber every row by tens and leave a gap at `slot`.
 *
 * Only reached when two neighbours have no room between them, which happens on
 * a schedule imported with duplicate or consecutive sort orders. Nothing about
 * a row changes except where it sits.
 */
function respace(
  ordered: EditTask[],
  slot: number,
): { sortOrder: number; sortUpdates: InsertPlan["sortUpdates"] } {
  const sortUpdates: InsertPlan["sortUpdates"] = [];
  let n = 0;
  let sortOrder = SPACING;
  for (let i = 0; i <= ordered.length; i++) {
    if (i === slot) {
      n += 1;
      sortOrder = n * SPACING;
    }
    if (i === ordered.length) break;
    n += 1;
    const next = n * SPACING;
    if (ordered[i].sort_order !== next) {
      sortUpdates.push({ id: ordered[i].id, sort_order: next });
    }
  }
  return { sortOrder, sortUpdates };
}

/**
 * Whether a position makes sense for this row, so the menu can grey out what
 * would not work rather than failing after the click.
 */
export function insertPositionsFor(
  tasks: readonly EditTask[],
  anchorWbs: string,
): { position: InsertPosition; label: string; enabled: boolean; why?: string }[] {
  const anchor = tasks.find((t) => t.wbs_code === anchorWbs);
  const hasKids = anchor ? childrenOf(tasks as EditTask[], anchorWbs).length > 0 : false;
  return [
    { position: "above", label: "Insert row above", enabled: !!anchor },
    { position: "below", label: "Insert row below", enabled: !!anchor },
    {
      position: "child",
      label: hasKids ? "Insert row inside" : "Insert row inside (makes this a summary)",
      enabled: !!anchor,
    },
  ];
}
