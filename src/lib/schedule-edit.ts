// Editing the schedule: WBS arithmetic, structural moves, and pasted-grid
// import.
//
// Everything here is pure. schedule-cpm.ts answers "what does this schedule
// mean"; this file answers "what would this edit do to it", and hands back a
// plan the caller can show you before anything is written.
//
// That split is not ceremony. A structural edit renames WBS codes, and WBS
// codes are referenced by predecessor strings, by inspections, and - as text
// arrays with no foreign key - by billing lines and cost codes. An edit that
// cannot be previewed is an edit that silently breaks references. So the rule
// this file follows throughout: rename as little as possible, and say out loud
// what a rename touches.

import {
  advance,
  parseIso,
  retreat,
  type CalendarLike,
} from "@/lib/schedule-calendar";
import {
  parsePredecessors,
  serializeLinks,
  type Link,
  type RelType,
} from "@/lib/schedule-cpm";

export type EditTask = {
  id: string;
  wbs_code: string;
  task_name: string;
  predecessors: string | null;
  sort_order: number | null;
  level_code: number | null;
  duration_days?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  phase?: string | null;
  assigned_to?: string | null;
  status?: string | null;
  description?: string | null;
  is_milestone?: boolean | null;
};

// ============================================================================
// WBS arithmetic
// ============================================================================

export function wbsParts(code: string): number[] {
  return code.split(".").map((s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : Number.NaN;
  });
}

// Numeric segment ordering, so 5.1.10 sorts after 5.1.9 rather than before it.
// A segment that is not a number sorts last rather than throwing - imported
// schedules do contain the occasional "5.1.2a".
export function compareWbs(a: string, b: string): number {
  const A = wbsParts(a);
  const B = wbsParts(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = Number.isNaN(x);
    const yn = Number.isNaN(y);
    if (xn && yn) continue;
    if (xn) return 1;
    if (yn) return -1;
    if (x !== y) return x - y;
  }
  return a.localeCompare(b);
}

export function parentCodeOf(code: string): string | null {
  const i = code.lastIndexOf(".");
  return i === -1 ? null : code.slice(0, i);
}

export function depthOf(code: string): number {
  return code.split(".").length;
}

export function isDescendantOf(code: string, ancestor: string): boolean {
  return code !== ancestor && code.startsWith(ancestor + ".");
}

export function descendantsOf<T extends { wbs_code: string }>(
  tasks: T[],
  code: string,
): T[] {
  return tasks.filter((t) => isDescendantOf(t.wbs_code, code));
}

export function childrenOf<T extends { wbs_code: string }>(
  tasks: T[],
  code: string | null,
): T[] {
  return tasks.filter((t) =>
    code === null
      ? depthOf(t.wbs_code) === 1
      : isDescendantOf(t.wbs_code, code) &&
        depthOf(t.wbs_code) === depthOf(code) + 1,
  );
}

export function isLeafWbs<T extends { wbs_code: string }>(
  tasks: T[],
  code: string,
): boolean {
  return !tasks.some((t) => isDescendantOf(t.wbs_code, code));
}

// The next free code under a parent. Takes the highest existing child segment
// and adds one rather than filling the first gap: a code that was used and
// deleted may still be referenced by a billing line or an old inspection, and
// handing it to a different task would silently re-point that reference.
export function nextChildCode<T extends { wbs_code: string }>(
  tasks: T[],
  parent: string | null,
): string {
  const kids = childrenOf(tasks, parent);
  let max = 0;
  for (const k of kids) {
    const parts = wbsParts(k.wbs_code);
    const last = parts[parts.length - 1];
    if (Number.isFinite(last) && last > max) max = last;
  }
  return parent === null ? String(max + 1) : `${parent}.${max + 1}`;
}

// The next code at the top of THIS schedule, which is not the same as depth 1.
// Sweet Springs had its "5" Construction root deleted when the schedule was cut
// to civil, so its top level is 5.1, 5.2, ... and a new top-level branch there
// is 5.2 - not "1", which is what asking for a depth-1 sibling would produce.
export function nextTopLevelCode<T extends { wbs_code: string }>(tasks: T[]): string {
  if (!tasks.length) return "1";
  let shallowest = Infinity;
  for (const t of tasks) shallowest = Math.min(shallowest, depthOf(t.wbs_code));
  const top = tasks.find((t) => depthOf(t.wbs_code) === shallowest)!;
  return nextChildCode(tasks, parentCodeOf(top.wbs_code));
}

export function nextSortOrder<T extends { sort_order: number | null }>(
  tasks: T[],
): number {
  let max = 0;
  for (const t of tasks) if ((t.sort_order ?? 0) > max) max = t.sort_order ?? 0;
  return max + 10;
}

// Display order. sort_order is authoritative when present because it is what
// indent/outdent and row moves maintain; WBS is the tiebreak so a schedule that
// has never been reordered still reads correctly.
export function scheduleOrder<T extends EditTask>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const as = a.sort_order;
    const bs = b.sort_order;
    if (as != null && bs != null && as !== bs) return as - bs;
    if (as != null && bs == null) return -1;
    if (as == null && bs != null) return 1;
    return compareWbs(a.wbs_code, b.wbs_code);
  });
}

// ============================================================================
// Predecessor rewriting
// ============================================================================

export function rewritePredecessors(
  raw: string | null,
  renames: Map<string, string>,
): string | null {
  const links = parsePredecessors(raw);
  if (!links.length) return raw ?? null;
  let touched = false;
  const next = links.map((l) => {
    const to = renames.get(l.pred);
    if (!to) return l;
    touched = true;
    return { ...l, pred: to };
  });
  return touched ? serializeLinks(next) : (raw ?? null);
}

// ============================================================================
// Structural edits - indent, outdent, move
// ============================================================================

export type WbsRename = { id: string; from: string; to: string };

export type StructurePlan = {
  ok: boolean;
  error?: string;
  renames: WbsRename[];
  // Every task whose predecessor string mentions a renamed code, including
  // tasks outside the moved subtree. This is the part that makes a structural
  // move safe rather than merely convenient.
  predecessorRewrites: { id: string; wbs_code: string; predecessors: string | null }[];
  levelUpdates: { id: string; level_code: number }[];
  parentUpdates: { id: string; parent_wbs_code: string | null }[];
  sortUpdates: { id: string; sort_order: number }[];
  warnings: string[];
};

const EMPTY_PLAN: StructurePlan = {
  ok: true,
  renames: [],
  predecessorRewrites: [],
  levelUpdates: [],
  parentUpdates: [],
  sortUpdates: [],
  warnings: [],
};

function fail(error: string): StructurePlan {
  return { ...EMPTY_PLAN, ok: false, error };
}

// Turn a set of subtree-root renames into the full plan: descendants get their
// prefix rewritten, levels and parents follow the new depth, and every
// predecessor reference anywhere on the project is repointed.
function planFromRenames(
  tasks: EditTask[],
  rootRenames: { task: EditTask; to: string }[],
): StructurePlan {
  const map = new Map<string, string>();
  const renames: WbsRename[] = [];

  for (const { task, to } of rootRenames) {
    if (task.wbs_code === to) continue;
    map.set(task.wbs_code, to);
    renames.push({ id: task.id, from: task.wbs_code, to });
    for (const d of descendantsOf(tasks, task.wbs_code)) {
      const suffix = d.wbs_code.slice(task.wbs_code.length);
      const dTo = to + suffix;
      map.set(d.wbs_code, dTo);
      renames.push({ id: d.id, from: d.wbs_code, to: dTo });
    }
  }

  if (!renames.length) return EMPTY_PLAN;

  // A target that is already taken by a task not being renamed is a genuine
  // collision, not something to resolve silently.
  const movingFrom = new Set(renames.map((r) => r.from));
  for (const r of renames) {
    const occupant = tasks.find((t) => t.wbs_code === r.to);
    if (occupant && !movingFrom.has(occupant.wbs_code)) {
      return fail(`${r.to} is already used by "${occupant.task_name}".`);
    }
  }

  const predecessorRewrites: StructurePlan["predecessorRewrites"] = [];
  for (const t of tasks) {
    const next = rewritePredecessors(t.predecessors, map);
    if (next !== (t.predecessors ?? null)) {
      predecessorRewrites.push({
        id: t.id,
        wbs_code: map.get(t.wbs_code) ?? t.wbs_code,
        predecessors: next,
      });
    }
  }

  const levelUpdates = renames.map((r) => ({
    id: r.id,
    level_code: depthOf(r.to),
  }));
  const parentUpdates = renames.map((r) => ({
    id: r.id,
    parent_wbs_code: parentCodeOf(r.to),
  }));

  const warnings: string[] = [];
  if (predecessorRewrites.length) {
    warnings.push(
      `${predecessorRewrites.length} predecessor reference${predecessorRewrites.length === 1 ? "" : "s"} will be repointed to the new codes.`,
    );
  }
  warnings.push(
    "Billing lines, cost codes and closed inspections store WBS codes as plain text and will not follow this rename. Check any that reference the old codes.",
  );

  return {
    ok: true,
    renames,
    predecessorRewrites,
    levelUpdates,
    parentUpdates,
    sortUpdates: [],
    warnings,
  };
}

// Renames have to be applied in an order that never violates the unique
// (project_id, wbs_code) index. Anything whose target is free right now goes
// first; whatever is left is a cycle (A -> B while B -> A) and gets parked on a
// temporary code before landing. The temp pass is almost never needed for
// indent and outdent, which always move onto fresh codes, but a rename that
// swaps two siblings would deadlock without it.
export function orderRenames(
  renames: WbsRename[],
  occupied: Set<string>,
): { direct: WbsRename[]; viaTemp: WbsRename[] } {
  const free = new Set(occupied);
  for (const r of renames) free.delete(r.from);

  const pending = [...renames];
  const direct: WbsRename[] = [];
  const held = new Set(renames.map((r) => r.from));

  let progress = true;
  while (progress && pending.length) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const r = pending[i];
      // Its target is still occupied by another mover; wait for that one.
      if (held.has(r.to) && r.to !== r.from) continue;
      direct.push(r);
      held.delete(r.from);
      pending.splice(i, 1);
      progress = true;
    }
  }

  return { direct, viaTemp: pending };
}

// Indent: the task becomes a child of the row above it at the same level.
//
// Only the moved subtree is renumbered. Its former siblings keep their codes,
// which leaves a gap in the numbering - deliberately. A WBS code here is an
// identifier that other records point at, not a position, and renumbering a
// whole branch to close a cosmetic gap is how text references get orphaned.
// Position lives in sort_order.
export function planIndent(
  allTasks: EditTask[],
  targetWbs: string[],
): StructurePlan {
  const ordered = scheduleOrder(allTasks);
  const targets = ordered.filter((t) => targetWbs.includes(t.wbs_code));
  if (!targets.length) return fail("Nothing selected.");

  // Indenting a task and something inside it at the same time has no coherent
  // meaning - the descendant is already moving with its parent.
  for (const t of targets) {
    if (targets.some((o) => isDescendantOf(t.wbs_code, o.wbs_code))) {
      return fail(
        "Select whole branches. A task and one of its own subtasks cannot be indented in the same move.",
      );
    }
  }

  // Simulate against a growing copy so two tasks indented together land as
  // sibling children rather than both claiming the same code.
  const working: EditTask[] = ordered.map((t) => ({ ...t }));
  const rootRenames: { task: EditTask; to: string }[] = [];

  for (const t of targets) {
    const idx = working.findIndex((w) => w.wbs_code === t.wbs_code);
    const depth = depthOf(t.wbs_code);

    // Walk back for the nearest preceding row at the same depth that is not
    // inside this task. That row becomes the new parent.
    let newParent: EditTask | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      const cand = working[i];
      if (isDescendantOf(cand.wbs_code, t.wbs_code)) continue;
      const cd = depthOf(cand.wbs_code);
      if (cd === depth) { newParent = cand; break; }
      if (cd < depth) break;
    }
    if (!newParent) {
      return fail(
        `"${t.task_name}" has no task above it at the same level, so there is nothing to indent it under.`,
      );
    }

    const to = nextChildCode(working, newParent.wbs_code);
    rootRenames.push({ task: t, to });

    // Reflect the move in the working copy for the next target in the loop.
    const suffixFrom = t.wbs_code;
    for (const w of working) {
      if (w.wbs_code === suffixFrom) w.wbs_code = to;
      else if (isDescendantOf(w.wbs_code, suffixFrom))
        w.wbs_code = to + w.wbs_code.slice(suffixFrom.length);
    }
  }

  const plan = planFromRenames(allTasks, rootRenames);
  if (!plan.ok) return plan;
  return {
    ...plan,
    warnings: [
      "Sibling codes are left as they are, so the numbering will show a gap where this task used to sit. Row order is kept separately.",
      ...plan.warnings,
    ],
  };
}

// Outdent: the task is promoted to sit alongside its current parent.
export function planOutdent(
  allTasks: EditTask[],
  targetWbs: string[],
): StructurePlan {
  const ordered = scheduleOrder(allTasks);
  const targets = ordered.filter((t) => targetWbs.includes(t.wbs_code));
  if (!targets.length) return fail("Nothing selected.");

  for (const t of targets) {
    if (targets.some((o) => isDescendantOf(t.wbs_code, o.wbs_code))) {
      return fail(
        "Select whole branches. A task and one of its own subtasks cannot be outdented in the same move.",
      );
    }
  }

  const working: EditTask[] = ordered.map((t) => ({ ...t }));
  const rootRenames: { task: EditTask; to: string }[] = [];

  for (const t of targets) {
    const current = working.find((w) => w.wbs_code === t.wbs_code)!;
    const parent = parentCodeOf(current.wbs_code);
    // A parent code with no task behind it is not a level you can be promoted
    // out of. Sweet Springs' civil tasks are 5.1.x with no "5" row at all, so
    // reading the code alone would happily "promote" 5.1 to a bare "1".
    if (parent === null || !working.some((w) => w.wbs_code === parent)) {
      return fail(
        `"${t.task_name}" is already at the top level of this schedule and cannot be outdented further.`,
      );
    }
    const grandparent = parentCodeOf(parent);
    const to = nextChildCode(working, grandparent);
    rootRenames.push({ task: t, to });

    const suffixFrom = current.wbs_code;
    for (const w of working) {
      if (w.wbs_code === suffixFrom) w.wbs_code = to;
      else if (isDescendantOf(w.wbs_code, suffixFrom))
        w.wbs_code = to + w.wbs_code.slice(suffixFrom.length);
    }
  }

  const plan = planFromRenames(allTasks, rootRenames);
  if (!plan.ok) return plan;
  return {
    ...plan,
    warnings: [
      "The task is appended as the last child of its new parent. Use move up and down to place it.",
      ...plan.warnings,
    ],
  };
}

// Move rows up or down. Pure reordering - sort_order only, no renames, so this
// is the cheap and safe way to change how the schedule reads.
//
// A task carries its whole subtree with it, and it steps over the entire block
// occupied by its neighbour rather than a single row, so moving a summary past
// another summary does not land it in the middle of that summary's children.
export function planMove(
  allTasks: EditTask[],
  targetWbs: string[],
  direction: "up" | "down",
): StructurePlan {
  const ordered = scheduleOrder(allTasks);
  const targets = targetWbs.filter((w) => ordered.some((t) => t.wbs_code === w));
  if (!targets.length) return fail("Nothing selected.");

  // A block is a selected row plus its whole subtree. Rows already swept up as
  // somebody else's descendant do not get a block of their own.
  const blocks: EditTask[][] = [];
  const claimed = new Set<string>();
  for (const t of ordered) {
    if (!targets.includes(t.wbs_code) || claimed.has(t.wbs_code)) continue;
    const rows = [t, ...ordered.filter((o) => isDescendantOf(o.wbs_code, t.wbs_code))];
    for (const r of rows) claimed.add(r.wbs_code);
    blocks.push(rows);
  }
  if (!blocks.length) return fail("Nothing selected.");

  // The previous sibling block. Scanning back for the first row that shares the
  // moving block's parent steps over that sibling's whole subtree in one go,
  // and hitting the parent row (or anything outside the branch) means there is
  // no sibling above - the task is already first where it sits.
  const prevSiblingStart = (
    list: EditTask[],
    before: number,
    parent: string | null,
  ): number => {
    for (let i = before; i >= 0; i--) {
      const code = list[i].wbs_code;
      if (parent !== null && (code === parent || !isDescendantOf(code, parent))) return -1;
      if (parentCodeOf(code) === parent) return i;
      // Anything else is a deeper descendant of a sibling; keep scanning past it.
    }
    return -1;
  };

  const list = [...ordered];
  let movedAny = false;
  let refused = false;
  const ordering = direction === "up" ? blocks : [...blocks].reverse();

  for (const block of ordering) {
    const first = list.indexOf(block[0]);
    const size = block.length;
    if (first === -1) continue;
    const parent = parentCodeOf(block[0].wbs_code);

    if (direction === "up") {
      if (first === 0) continue;
      const neighbourStart = prevSiblingStart(list, first - 1, parent);
      // Reordering never changes the tree. A row with no sibling above it is
      // already first in its branch; getting it out is an outdent, which is a
      // different and renaming edit.
      if (neighbourStart === -1) { refused = true; continue; }
      const chunk = list.splice(first, size);
      list.splice(neighbourStart, 0, ...chunk);
      movedAny = true;
    } else {
      const neighbourStart = first + size;
      if (neighbourStart >= list.length) continue;
      const neighbour = list[neighbourStart];
      if (parentCodeOf(neighbour.wbs_code) !== parent) { refused = true; continue; }
      const neighbourSize =
        1 + list.filter((o) => isDescendantOf(o.wbs_code, neighbour.wbs_code)).length;
      const chunk = list.splice(first, size);
      list.splice(first + neighbourSize, 0, ...chunk);
      movedAny = true;
    }
  }

  if (!movedAny) {
    return refused
      ? fail(
          "There is no sibling to swap with - the task is already at that end of its branch. Row order never changes the hierarchy, so getting it out of the branch is an outdent.",
        )
      : { ...EMPTY_PLAN };
  }

  return {
    ...EMPTY_PLAN,
    sortUpdates: list.map((t, i) => ({ id: t.id, sort_order: (i + 1) * 10 })),
  };
}

// Drag a row (or a selection) and drop it between two others.
//
// Smartsheet's drag does two things at once. Here they are different animals
// and the plan says which one happened: landing among your own siblings is
// pure sort_order and renames nothing, while landing under a different parent
// is the same renumbering edit as an indent, with every predecessor that
// mentions the moved branch repointed to follow it.
//
// The parent is taken from the row you drop against, which is what makes the
// gesture predictable: drop between two children of 5.1.2 and you become a
// child of 5.1.2.
export type DropPlan = StructurePlan & { reparents: boolean };

export function planDrop(
  allTasks: EditTask[],
  movingWbs: string[],
  targetWbs: string,
  position: "before" | "after",
): DropPlan {
  const withKind = (p: StructurePlan, reparents: boolean): DropPlan => ({ ...p, reparents });
  const ordered = scheduleOrder(allTasks);

  const target = ordered.find((t) => t.wbs_code === targetWbs);
  if (!target) return withKind(fail("That row is no longer on the schedule."), false);

  // Blocks, in schedule order, each a selected root plus its whole subtree.
  const claimed = new Set<string>();
  const blocks: EditTask[][] = [];
  for (const t of ordered) {
    if (!movingWbs.includes(t.wbs_code) || claimed.has(t.wbs_code)) continue;
    const rows = [t, ...ordered.filter((o) => isDescendantOf(o.wbs_code, t.wbs_code))];
    for (const r of rows) claimed.add(r.wbs_code);
    blocks.push(rows);
  }
  if (!blocks.length) return withKind(fail("Nothing to move."), false);

  // Dropping a branch inside itself would detach it from the schedule.
  for (const b of blocks) {
    if (b.some((r) => r.wbs_code === targetWbs)) {
      return withKind(fail("A task cannot be dropped inside itself."), false);
    }
  }

  const newParent = parentCodeOf(target.wbs_code);
  const moving = blocks.map((b) => b[0]);
  const reparents = moving.some((m) => parentCodeOf(m.wbs_code) !== newParent);

  // --- placement, which is the same either way ---------------------------
  const movingIds = new Set(claimed);
  const rest = ordered.filter((t) => !movingIds.has(t.wbs_code));
  const targetIdx = rest.findIndex((t) => t.wbs_code === targetWbs);
  if (targetIdx === -1) return withKind(fail("That row is no longer on the schedule."), false);

  const targetSubtree =
    1 + rest.filter((o) => isDescendantOf(o.wbs_code, targetWbs)).length;
  const insertAt = position === "before" ? targetIdx : targetIdx + targetSubtree;

  const flat = blocks.flat();
  const placed = [...rest.slice(0, insertAt), ...flat, ...rest.slice(insertAt)];
  const sortUpdates = placed.map((t, i) => ({ id: t.id, sort_order: (i + 1) * 10 }));

  if (!reparents) {
    const unchanged = placed.every((t, i) => ordered[i]?.id === t.id);
    return withKind(unchanged ? { ...EMPTY_PLAN } : { ...EMPTY_PLAN, sortUpdates }, false);
  }

  // --- re-parenting, which renames --------------------------------------
  const working: EditTask[] = ordered.map((t) => ({ ...t }));
  const rootRenames: { task: EditTask; to: string }[] = [];
  for (const m of moving) {
    if (parentCodeOf(m.wbs_code) === newParent) continue;
    const to = nextChildCode(working, newParent);
    rootRenames.push({ task: m, to });
    const from = m.wbs_code;
    for (const w of working) {
      if (w.wbs_code === from) w.wbs_code = to;
      else if (isDescendantOf(w.wbs_code, from)) w.wbs_code = to + w.wbs_code.slice(from.length);
    }
  }

  const plan = planFromRenames(allTasks, rootRenames);
  if (!plan.ok) return withKind(plan, true);

  return withKind(
    {
      ...plan,
      sortUpdates,
      warnings: [
        `This drop moves the task under ${newParent ?? "the top level"}, which renumbers it. Dropping between rows that share its current parent would only change the order.`,
        ...plan.warnings,
      ],
    },
    true,
  );
}

// ============================================================================
// Bulk date shift
// ============================================================================

export function shiftDates(
  t: { start_date?: string | null; end_date?: string | null },
  days: number,
  cal: CalendarLike,
): { start_date: string | null; end_date: string | null } | null {
  if (!t.start_date && !t.end_date) return null;
  const move = (iso: string | null | undefined) =>
    iso ? (days >= 0 ? advance(iso, days, cal) : retreat(iso, -days, cal)) : null;
  return { start_date: move(t.start_date), end_date: move(t.end_date) };
}

// ============================================================================
// Pasted-grid import
// ============================================================================

export type Delimiter = "tab" | "comma";

export type ParsedGrid = {
  headers: string[] | null;
  rows: string[][];
  delimiter: Delimiter;
};

// Split one delimited line, honouring quoted fields. Excel and Smartsheet both
// quote any cell containing the delimiter, and a task name with a comma in it
// is not exotic.
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const HEADER_HINTS = [
  "task", "name", "wbs", "duration", "start", "finish", "end",
  "predecessor", "phase", "assigned", "status", "activity", "code",
];

export function parseGrid(text: string): ParsedGrid {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: null, rows: [], delimiter: "tab" };

  // Tab wins whenever it appears: a paste out of a spreadsheet is tab
  // separated, and its cells routinely contain commas.
  const delimiter: Delimiter = lines.some((l) => l.includes("\t")) ? "tab" : "comma";
  const d = delimiter === "tab" ? "\t" : ",";

  const rows = lines.map((l) => splitLine(l, d));
  const width = Math.max(...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push("");

  // A first row is a header when its cells read like column names and none of
  // them parses as a date - "Start" is a header, "8/19/26" is data.
  const first = rows[0].map((c) => c.trim().toLowerCase());
  const looksLikeHeader =
    first.some((c) => HEADER_HINTS.some((h) => c.includes(h))) &&
    !first.some((c) => c && parseLooseDate(c) !== null);

  return looksLikeHeader
    ? { headers: rows[0].map((c) => c.trim()), rows: rows.slice(1), delimiter }
    : { headers: null, rows, delimiter };
}

export type ColumnKey =
  | "wbs_code"
  | "task_name"
  | "duration_days"
  | "start_date"
  | "end_date"
  | "predecessors"
  | "phase"
  | "assigned_to"
  | "status"
  | "description"
  | "is_milestone";

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  wbs_code: "WBS code",
  task_name: "Task name",
  duration_days: "Duration (days)",
  start_date: "Start",
  end_date: "Finish",
  predecessors: "Predecessors",
  phase: "Phase",
  assigned_to: "Assigned to",
  status: "Status",
  description: "Description",
  is_milestone: "Milestone",
};

export const COLUMN_KEYS = Object.keys(COLUMN_LABELS) as ColumnKey[];

const COLUMN_ALIASES: Record<ColumnKey, string[]> = {
  wbs_code: ["wbs", "wbs code", "wbs #", "code", "task id", "id", "activity id", "line"],
  task_name: ["task name", "task", "name", "activity", "activity name", "description of work", "work"],
  duration_days: ["duration", "dur", "days", "duration (days)", "orig dur", "original duration"],
  start_date: ["start", "start date", "planned start", "early start", "begin"],
  end_date: ["finish", "end", "end date", "finish date", "planned finish", "early finish", "completion"],
  predecessors: ["predecessors", "predecessor", "pred", "preds", "depends on", "dependency", "dependencies", "logic"],
  phase: ["phase", "scope", "area", "discipline", "category"],
  assigned_to: ["assigned to", "assigned", "responsible", "owner", "sub", "subcontractor", "crew", "resource", "resources"],
  status: ["status", "state"],
  description: ["description", "notes", "note", "comments", "detail"],
  is_milestone: ["milestone", "is milestone", "ms"],
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[_*]/g, " ").replace(/\s+/g, " ").trim();
}

// Map each column of the paste to a field, or null for "ignore". Header text
// first; when there is no header, fall back to what the cells look like, which
// is enough to find dates, durations and the name column in practice.
export function guessColumns(
  headers: string[] | null,
  rows: string[][],
): (ColumnKey | null)[] {
  const width = headers?.length ?? (rows[0]?.length ?? 0);
  const out: (ColumnKey | null)[] = new Array(width).fill(null);
  const taken = new Set<ColumnKey>();

  if (headers) {
    // Exact alias matches first so a sheet with both "Start" and "Start
    // Variance" does not hand "Start" to the variance column.
    for (const pass of ["exact", "partial"] as const) {
      for (let i = 0; i < width; i++) {
        if (out[i]) continue;
        const h = normalizeHeader(headers[i] ?? "");
        if (!h) continue;
        for (const key of COLUMN_KEYS) {
          if (taken.has(key)) continue;
          const hit = COLUMN_ALIASES[key].some((a) =>
            pass === "exact" ? h === a : h.includes(a),
          );
          if (hit) { out[i] = key; taken.add(key); break; }
        }
      }
    }
    return out;
  }

  const sample = rows.slice(0, 12);
  const colVals = (i: number) => sample.map((r) => (r[i] ?? "").trim()).filter(Boolean);

  for (let i = 0; i < width; i++) {
    const vals = colVals(i);
    if (!vals.length) continue;
    const dates = vals.filter((v) => parseLooseDate(v) !== null).length;
    if (dates / vals.length > 0.6) {
      if (!taken.has("start_date")) { out[i] = "start_date"; taken.add("start_date"); }
      else if (!taken.has("end_date")) { out[i] = "end_date"; taken.add("end_date"); }
      continue;
    }
    if (!taken.has("wbs_code") && vals.every((v) => /^\d+(\.\d+)*$/.test(v)) && vals.some((v) => v.includes("."))) {
      out[i] = "wbs_code"; taken.add("wbs_code"); continue;
    }
    if (!taken.has("duration_days") && vals.every((v) => parseLooseDuration(v) !== null)) {
      out[i] = "duration_days"; taken.add("duration_days"); continue;
    }
    if (!taken.has("task_name") && vals.some((v) => /[a-z]{3}/i.test(v))) {
      out[i] = "task_name"; taken.add("task_name"); continue;
    }
  }
  return out;
}

// ---- loose value parsing --------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (y < 1900 || y > 2200) return null;
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // Reject 31 Feb and friends by round-tripping through the calendar.
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCMonth() + 1 === m && back.getUTCDate() === d ? s : null;
}

// Dates arrive as whatever the source tool exports. US month-first ordering is
// assumed for slash dates because that is what Smartsheet and Excel produce on
// these machines; ISO is detected outright and is always unambiguous.
export function parseLooseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return iso(+m[3], +m[1], +m[2]);

  // "Aug 19, 2026" / "19 Aug 2026" / "19-Aug-26"
  m = s.match(/^([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/i);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return iso(+m[3], mo, +m[2]);
  }
  m = s.match(/^(\d{1,2})[-\s]([a-z]{3,})\.?[-\s](\d{2,4})$/i);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return iso(+m[3], mo, +m[1]);
  }
  return null;
}

// "5", "5d", "5 days", "5d?", "5.0" all mean five. The trailing "?" is
// Smartsheet's estimated-duration flag and carries no information we keep.
export function parseLooseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(?:d|day|days|w|wk|week|weeks)?\??$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /w/.test(s) ? Math.round(n * 5) : Math.round(n);
}

export function parseLooseBool(raw: string): boolean {
  return /^(y|yes|true|1|x|milestone)$/i.test(raw.trim());
}

// Split one predecessor token into its three parts without a single monster
// regex: peel the lag off the end, then the relationship type, and whatever is
// left is the reference. "12FS+3d" and "5.1.1.2SS" both come apart cleanly,
// and a bare "12" keeps its dots-and-digits shape either way.
export function splitPredecessorToken(
  token: string,
): { ref: string; type: RelType; lag: number } | null {
  let s = token.trim().replace(/\s+/g, "");
  if (!s) return null;

  let lag = 0;
  const lagMatch = s.match(/([+-]\d+(?:\.\d+)?)(?:d|day|days|e?d)?$/i);
  if (lagMatch) {
    lag = Math.round(Number(lagMatch[1]));
    s = s.slice(0, s.length - lagMatch[0].length);
  }

  let type: RelType = "FS";
  const typeMatch = s.match(/(FS|SS|FF|SF)$/i);
  if (typeMatch) {
    type = typeMatch[1].toUpperCase() as RelType;
    s = s.slice(0, s.length - typeMatch[0].length);
  }

  s = s.replace(/[,;]+$/, "");
  return s ? { ref: s, type, lag } : null;
}

export type ImportRow = {
  rowNumber: number; // 1-based position in the paste, as the source tool shows it
  wbs_code: string;
  values: Partial<Record<ColumnKey, string | number | boolean | null>>;
  rawPredecessors: string | null;
  issues: string[];
};

export type BuildOptions = {
  // Codes already on the project, so a pasted predecessor can resolve against
  // tasks that are not in this paste.
  knownWbs?: string[];
  // Prefix for generated codes when the paste has no WBS column, e.g. "5.2".
  wbsRoot?: string | null;
};

// Leading whitespace is how a spreadsheet paste carries hierarchy when the
// sheet has no WBS column - Smartsheet indents the primary column visually and
// the clipboard keeps the spaces.
function indentOf(raw: string): number {
  const m = raw.match(/^([\t ]+)/);
  if (!m) return 0;
  const spaces = m[1].replace(/\t/g, "    ").length;
  return Math.floor(spaces / 2);
}

export function buildImportRows(
  grid: ParsedGrid,
  mapping: (ColumnKey | null)[],
  opts: BuildOptions = {},
): { rows: ImportRow[]; notes: string[] } {
  const notes: string[] = [];
  const has = (k: ColumnKey) => mapping.includes(k);
  const colOf = (k: ColumnKey) => mapping.indexOf(k);

  const rawRows = grid.rows.map((cells, i) => ({ cells, rowNumber: i + 1 }));

  // --- WBS codes -----------------------------------------------------------
  let codes: string[];
  if (has("wbs_code")) {
    const c = colOf("wbs_code");
    codes = rawRows.map((r) => (r.cells[c] ?? "").trim());
  } else if (has("task_name")) {
    // Derive from indentation. A stack of counters per level, rooted at
    // wbsRoot when the paste is being added under an existing branch.
    const nameCol = colOf("task_name");
    const root = opts.wbsRoot?.trim() || null;
    const counters: number[] = [];
    codes = rawRows.map((r) => {
      const lvl = indentOf(r.cells[nameCol] ?? "");
      while (counters.length <= lvl) counters.push(0);
      counters.length = lvl + 1;
      counters[lvl]++;
      const tail = counters.slice(0, lvl + 1).join(".");
      return root ? `${root}.${tail}` : tail;
    });
    notes.push(
      "No WBS column found, so codes were generated from the indentation of the task names.",
    );
  } else {
    codes = rawRows.map((r) => String(r.rowNumber));
  }

  const rowToWbs = new Map<string, string>();
  rawRows.forEach((r, i) => rowToWbs.set(String(r.rowNumber), codes[i]));

  const knownWbs = new Set([...(opts.knownWbs ?? []), ...codes]);

  // --- rows ----------------------------------------------------------------
  let translated = 0;
  const rows: ImportRow[] = rawRows.map((r, i) => {
    const issues: string[] = [];
    const values: ImportRow["values"] = {};

    for (let c = 0; c < mapping.length; c++) {
      const key = mapping[c];
      if (!key || key === "wbs_code" || key === "predecessors") continue;
      const raw = (r.cells[c] ?? "").trim();

      switch (key) {
        case "duration_days": {
          if (!raw) { values.duration_days = null; break; }
          const v = parseLooseDuration(raw);
          if (v === null) issues.push(`Duration "${raw}" not understood`);
          values.duration_days = v;
          break;
        }
        case "start_date":
        case "end_date": {
          if (!raw) { values[key] = null; break; }
          const v = parseLooseDate(raw);
          if (v === null) issues.push(`Date "${raw}" not understood`);
          values[key] = v;
          break;
        }
        case "is_milestone":
          values.is_milestone = raw ? parseLooseBool(raw) : false;
          break;
        case "task_name":
          values.task_name = raw.trim();
          if (!values.task_name) issues.push("No task name");
          break;
        default:
          values[key] = raw || null;
      }
    }

    // --- predecessors ------------------------------------------------------
    let predecessors: string | null = null;
    let rawPred: string | null = null;
    if (has("predecessors")) {
      rawPred = (r.cells[colOf("predecessors")] ?? "").trim() || null;
      if (rawPred) {
        const links: Link[] = [];
        for (const token of rawPred.split(/[,;]/)) {
          const parsed = splitPredecessorToken(token);
          if (!parsed) continue;
          let ref = parsed.ref;
          if (!knownWbs.has(ref)) {
            // Smartsheet writes predecessors as row numbers. Translate only
            // when the token is not already a real WBS code, so a schedule
            // whose codes happen to be bare integers is not rewritten.
            const byRow = /^\d+$/.test(ref) ? rowToWbs.get(ref) : undefined;
            if (byRow) { ref = byRow; translated++; }
            else issues.push(`Predecessor "${parsed.ref}" does not match a task`);
          }
          links.push({ pred: ref, type: parsed.type, lag: parsed.lag });
        }
        predecessors = serializeLinks(links);
      }
    }
    if (has("predecessors")) values.predecessors = predecessors;

    const code = codes[i];
    if (!code) issues.push("No WBS code");

    return { rowNumber: r.rowNumber, wbs_code: code, values, rawPredecessors: rawPred, issues };
  });

  if (translated) {
    notes.push(
      `${translated} predecessor reference${translated === 1 ? " was" : "s were"} written as row numbers and have been translated to WBS codes.`,
    );
  }

  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.wbs_code) continue;
    const prev = seen.get(r.wbs_code);
    if (prev) r.issues.push(`WBS ${r.wbs_code} is also on row ${prev}`);
    else seen.set(r.wbs_code, r.rowNumber);
  }

  return { rows, notes };
}

// ---- diff -----------------------------------------------------------------

export type FieldChange = { field: ColumnKey; from: unknown; to: unknown };

export type ImportDiff = {
  adds: ImportRow[];
  changes: { existing: EditTask; row: ImportRow; fields: FieldChange[] }[];
  unchangedCount: number;
  deletes: EditTask[];
  blocking: string[];
};

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    v === "" || v === undefined ? null : typeof v === "number" ? v : v;
  const x = norm(a);
  const y = norm(b);
  if (x === null && y === null) return true;
  if (typeof x === "boolean" || typeof y === "boolean") return !!x === !!y;
  return String(x ?? "") === String(y ?? "");
}

// Compare only the fields the paste actually carries. A four-column paste must
// not blank out phase, assignment and logic on every task it touches, which is
// the single most destructive thing a naive importer does.
export function diffImport(
  existing: EditTask[],
  rows: ImportRow[],
  mapping: (ColumnKey | null)[],
  opts: { deleteMissingUnder?: string | null } = {},
): ImportDiff {
  const byWbs = new Map(existing.map((t) => [t.wbs_code, t]));
  const fields = COLUMN_KEYS.filter(
    (k) => k !== "wbs_code" && mapping.includes(k),
  );

  const adds: ImportRow[] = [];
  const changes: ImportDiff["changes"] = [];
  let unchangedCount = 0;

  for (const row of rows) {
    if (!row.wbs_code) continue;
    const match = byWbs.get(row.wbs_code);
    if (!match) { adds.push(row); continue; }

    const changed: FieldChange[] = [];
    for (const f of fields) {
      if (!(f in row.values)) continue;
      const to = row.values[f];
      const from = (match as unknown as Record<string, unknown>)[f] ?? null;
      if (!sameValue(from, to)) changed.push({ field: f, from, to });
    }
    if (changed.length) changes.push({ existing: match, row, fields: changed });
    else unchangedCount++;
  }

  // Deletion is opt-in and always scoped. "Everything not in this paste" is a
  // reasonable statement about one branch of the WBS and a dangerous one about
  // a whole project, so the caller names the branch.
  const incoming = new Set(rows.map((r) => r.wbs_code));
  const root = opts.deleteMissingUnder?.trim() || null;
  const deletes =
    root === null
      ? []
      : existing.filter(
          (t) =>
            (t.wbs_code === root || isDescendantOf(t.wbs_code, root)) &&
            !incoming.has(t.wbs_code),
        );

  const blocking: string[] = [];
  const noName = adds.filter((a) => !a.values.task_name);
  if (noName.length) {
    blocking.push(
      `${noName.length} new row${noName.length === 1 ? " has" : "s have"} no task name (row ${noName.map((r) => r.rowNumber).join(", ")}).`,
    );
  }
  const dupes = rows.filter((r) => r.issues.some((i) => i.includes("is also on row")));
  if (dupes.length) {
    blocking.push(`Duplicate WBS codes on rows ${dupes.map((r) => r.rowNumber).join(", ")}.`);
  }

  return { adds, changes, unchangedCount, deletes, blocking };
}

// Sort a set of dates for a sanity read in the preview.
export function spanOf(rows: ImportRow[]): { start: string | null; end: string | null } {
  let start: string | null = null;
  let end: string | null = null;
  for (const r of rows) {
    const s = r.values.start_date as string | null | undefined;
    const e = r.values.end_date as string | null | undefined;
    if (s && (!start || parseIso(s) < parseIso(start))) start = s;
    if (e && (!end || parseIso(e) > parseIso(end))) end = e;
  }
  return { start, end };
}
