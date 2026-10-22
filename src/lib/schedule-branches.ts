// Filtering a schedule by its own branches.
//
// The scope filter read discipline off task names, and names are not a
// taxonomy. Two false positives shipped in two days: Sussex's "Contractor
// Permits" branch matched the word "contract", and its "Civil - IFP (Issued
// For Permit)" engineering package matched "permit", which put nine design
// deliverables on a permitting sheet. Each fix was a sharper rule about words,
// and the next schedule would have broken it again.
//
// Zarina: "Filter should show per parent task not per keyword." The schedule
// already carries the answer. 2 Permitting is a row, everything under it is
// permitting work by construction, and no amount of creative naming changes
// that. Picking branches is also how somebody actually thinks about a
// schedule - "give me permitting and procurement" - which a single-select
// discipline dropdown could not express at all.

/** A row that has at least one row beneath it. */
export type Branch = {
  wbs: string;
  name: string;
  /** Dots in the code, so the picker can indent the tree. */
  depth: number;
  /** Rows underneath it, not counting itself. */
  descendants: number;
};

type TaskLike = { wbs_code?: string | null; task_name?: string | null };

/** Whether `wbs` is `branch` or sits under it. */
export function isUnder(wbs: string, branch: string): boolean {
  if (!wbs || !branch) return false;
  // The dot matters: "1.20" is not under "1.2", and a plain startsWith says it
  // is. That is the whole bug class this function exists to avoid.
  return wbs === branch || wbs.startsWith(branch + ".");
}

export function isUnderAny(wbs: string, branches: readonly string[]): boolean {
  return branches.some((b) => isUnder(wbs, b));
}

/**
 * The rows worth offering as a filter.
 *
 * A branch is any row something else hangs from. Leaves are left out: there is
 * nothing to narrow to, and on a 165-row schedule they would bury the dozen
 * rows anybody actually picks.
 */
export function branchOptions(tasks: readonly TaskLike[]): Branch[] {
  const codes = tasks
    .map((t) => (t.wbs_code ?? "").trim())
    .filter(Boolean);
  const nameOf = new Map<string, string>();
  for (const t of tasks) {
    const c = (t.wbs_code ?? "").trim();
    if (c) nameOf.set(c, (t.task_name ?? "").trim());
  }

  const counts = new Map<string, number>();
  for (const code of codes) {
    // Every proper ancestor of this code gains a descendant, whether or not a
    // row exists for it. A schedule with 2.2.1 but no 2.2 still has a 2.2.
    let at = code;
    for (;;) {
      const dot = at.lastIndexOf(".");
      if (dot === -1) break;
      at = at.slice(0, dot);
      counts.set(at, (counts.get(at) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([wbs, descendants]) => ({
      wbs,
      // A gap in the outline is still offerable; it just has no name of its own.
      name: nameOf.get(wbs) ?? "",
      depth: wbs.split(".").length - 1,
      descendants,
    }))
    .sort((a, b) =>
      a.wbs.localeCompare(b.wbs, undefined, { numeric: true, sensitivity: "base" }),
    );
}

export function filterByBranches<T extends TaskLike>(
  tasks: readonly T[],
  branches: readonly string[],
): T[] {
  if (branches.length === 0) return [...tasks];
  return tasks.filter((t) => isUnderAny((t.wbs_code ?? "").trim(), branches));
}

/**
 * Selecting a branch and then its parent should not count the subtree twice,
 * and should not leave the child showing as a separate chip. The parent
 * already covers it.
 */
export function pruneRedundant(branches: readonly string[]): string[] {
  return branches.filter(
    (b) => !branches.some((other) => other !== b && isUnder(b, other)),
  );
}

/**
 * What to call the current filter, on screen and across the top of a printed
 * sheet. Paper carries no dropdown, so the name has to survive the journey.
 */
export function branchLabel(
  branches: readonly string[],
  options: readonly Branch[],
): string | null {
  const live = pruneRedundant(branches);
  if (live.length === 0) return null;
  const nameOf = (wbs: string) =>
    options.find((o) => o.wbs === wbs)?.name || wbs;
  if (live.length === 1) return nameOf(live[0]);
  if (live.length === 2) return `${nameOf(live[0])} and ${nameOf(live[1])}`;
  return `${live.length} branches`;
}
