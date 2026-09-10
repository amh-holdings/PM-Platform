// The WBS outline: who is whose parent, and what is visible once branches are
// collapsed.
//
// Pure, and separate from the components, because "which rows can I see" turns
// out to be the question the whole reading problem hangs on. Sweet Springs went
// from 30 tasks to 71 in three weeks and will pass 200 when electrical lands.
// A flat list of 200 rows with nothing but indentation is not a schedule you
// can read; it is a schedule you can scroll.
//
// The hierarchy is read from the WBS code, not from level_code. The code is the
// identifier everything else points at and its dots ARE the structure, so
// 5.1.1.6.1 is a child of 5.1.1.6 whatever level_code happens to say. level_code
// is kept for indentation width and can drift after an import; the code cannot,
// because the whole editing library maintains it.

export type TreeTask = {
  wbs_code: string;
  level_code?: number | null;
};

/** Parent code of a WBS code, or null at the top. */
export function parentOf(code: string): string | null {
  const i = code.lastIndexOf(".");
  return i === -1 ? null : code.slice(0, i);
}

/** Depth of a code, 1-based: "5" is 1, "5.1.2" is 3. */
export function depthOf(code: string): number {
  return code.split(".").length;
}

/**
 * Does this task have children among the given set?
 *
 * Prefix matching rather than a parent lookup, because a schedule can carry a
 * child whose parent row does not exist - Sweet Springs has no "5" row at all,
 * its top level is 5.1 - and such a branch still has to render.
 */
export function hasChildren(code: string, all: readonly TreeTask[]): boolean {
  const prefix = code + ".";
  return all.some((t) => t.wbs_code !== code && t.wbs_code.startsWith(prefix));
}

/** Every summary code in the set, in no particular order. */
export function summaryCodes(all: readonly TreeTask[]): string[] {
  const codes = new Set(all.map((t) => t.wbs_code));
  const out = new Set<string>();
  for (const t of all) {
    // Walk up from every row and mark each ancestor that is really present.
    // Doing it this way costs one pass instead of the n^2 that asking
    // hasChildren per row would, which matters at 200+ rows re-rendering on
    // every keystroke.
    let p = parentOf(t.wbs_code);
    while (p) {
      if (codes.has(p)) out.add(p);
      p = parentOf(p);
    }
  }
  return Array.from(out);
}

/**
 * The rows to draw, given a set of collapsed branches.
 *
 * A task is hidden when any ancestor is collapsed. The collapsed summary itself
 * stays visible - that is the row you click to open it again - and it keeps its
 * own bar on the Gantt, which is what makes a collapsed branch still readable
 * as a block of work.
 *
 * Order is preserved exactly as handed in. This function decides visibility and
 * nothing else; scheduleOrder in schedule-edit.ts owns the ordering, and having
 * two places that sort rows is how the grid and the chart drift apart.
 */
export function visibleRows<T extends TreeTask>(
  ordered: readonly T[],
  collapsed: ReadonlySet<string>,
): T[] {
  if (!collapsed.size) return ordered.slice();
  return ordered.filter((t) => {
    let p = parentOf(t.wbs_code);
    while (p) {
      if (collapsed.has(p)) return false;
      p = parentOf(p);
    }
    return true;
  });
}

/** Every descendant code of a branch. */
export function descendantsOf(code: string, all: readonly TreeTask[]): string[] {
  const prefix = code + ".";
  return all
    .filter((t) => t.wbs_code !== code && t.wbs_code.startsWith(prefix))
    .map((t) => t.wbs_code);
}

/**
 * The collapsed set that shows the outline down to `level` and no further.
 *
 * Level is counted in real depth present rather than absolute dots, so Sweet
 * Springs - whose shallowest row is 5.1, at depth 2 - answers "level 1" with
 * its 5.1 / 5.2 / 5.3 branches rather than with nothing at all. The same bug
 * that made nextTopLevelCode return 1 instead of 5.2 lives here in a different
 * shape, and it has the same cause: "top" is whatever is actually in the
 * schedule, not what the numbering implies.
 */
export function collapseToLevel(all: readonly TreeTask[], level: number): Set<string> {
  if (level <= 0 || !all.length) return new Set(summaryCodes(all));
  const shallowest = Math.min(...all.map((t) => depthOf(t.wbs_code)));
  const cutoff = shallowest + level - 1;
  const out = new Set<string>();
  for (const code of summaryCodes(all)) {
    if (depthOf(code) >= cutoff) out.add(code);
  }
  return out;
}

/** How deep the outline goes, in levels below the shallowest row present. */
export function outlineDepth(all: readonly TreeTask[]): number {
  if (!all.length) return 0;
  const depths = all.map((t) => depthOf(t.wbs_code));
  return Math.max(...depths) - Math.min(...depths) + 1;
}

/**
 * Collapse or expand one branch, carrying its descendants with it.
 *
 * Expanding a branch expands everything inside it rather than restoring
 * whatever was collapsed underneath before. Restoring the old inner state is
 * the behaviour a file explorer has, and on a schedule it produces the
 * confusing result where opening a summary reveals two of its six children.
 */
export function toggleBranch(
  collapsed: ReadonlySet<string>,
  code: string,
  all: readonly TreeTask[],
): Set<string> {
  const next = new Set(collapsed);
  if (next.has(code)) {
    next.delete(code);
    for (const d of descendantsOf(code, all)) next.delete(d);
  } else {
    next.add(code);
  }
  return next;
}

/**
 * Reveal a task by expanding every ancestor that hides it.
 *
 * Needed by find, by jump-to-WBS, and by anything that selects a row the user
 * cannot currently see - scrolling to a row that is filtered out of the DOM
 * silently does nothing, which reads as the feature being broken.
 */
export function revealTask(
  collapsed: ReadonlySet<string>,
  code: string,
): Set<string> {
  const next = new Set(collapsed);
  let p = parentOf(code);
  while (p) {
    next.delete(p);
    p = parentOf(p);
  }
  return next;
}
