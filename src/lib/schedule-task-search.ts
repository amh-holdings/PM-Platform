/**
 * Finding a task by typing at it.
 *
 * Zarina: "need to have option to type and suggest in the dropdown for the
 * predecessors." The picker was a plain select holding every leaf task on the
 * project. On Sweet Springs that is a couple of hundred rows of "Delivery",
 * "Install", "Inspection" repeated down four branches, and a native select
 * only jumps on the first letter. Finding 4.4.7.2 in it means scrolling and
 * reading, every time, for every link.
 *
 * So the picker takes a query. These are the rules it filters by, kept out of
 * the component so they can be checked without a browser.
 */

export type SearchableTask = {
  wbs_code: string;
  task_name: string;
};

/**
 * The nearest ancestor that actually has a name.
 *
 * Nearest rather than the immediate parent, because a WBS is not required to
 * carry a row at every level: 4.4.2.1 may have no 4.4.2 on the schedule, and
 * stopping there would report no parent for a task that plainly sits in a
 * branch.
 */
export function nearestNamedAncestor(
  wbs: string,
  nameByWbs: ReadonlyMap<string, string>,
): { wbs: string; name: string } | null {
  let at = wbs;
  for (;;) {
    const dot = at.lastIndexOf(".");
    if (dot === -1) return null;
    at = at.slice(0, dot);
    const name = nameByWbs.get(at);
    if (name) return { wbs: at, name };
  }
}

/**
 * Everything about a task somebody might reasonably type.
 *
 * The parent's name is in here, which is the point: Sweet Springs carries a
 * "Delivery" under CAB Hangers, Maddox 1500kVA, Recloser, GroundWorks and
 * PowerFactors. Typing "delivery" returns five identical-looking rows.
 * Typing "cab delivery" now returns one.
 */
export function taskSearchText(
  task: SearchableTask,
  row?: number | null,
  parentName?: string | null,
): string {
  const parts = [task.wbs_code, task.task_name];
  if (row != null) parts.push(String(row));
  if (parentName) parts.push(parentName);
  return parts.join(" ").toLowerCase();
}

/**
 * Every word in the query has to appear somewhere.
 *
 * Words rather than the whole string, so "deliv power" finds "Power Factors
 * Delivery" without needing the order right. Somewhere rather than at a word
 * boundary, so "4.4.7" finds "4.4.7.2" and a half-typed word still narrows.
 */
export function matchesTaskQuery(haystack: string, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  return terms.every((t) => haystack.includes(t));
}

/**
 * How well a task answers the query, so the obvious one is first.
 *
 * 3 - what was typed IS this task: its row number or its WBS code, exactly.
 *     Typing "214" and getting row 214 second would be absurd.
 * 2 - the code or the name starts with it. "4.4.7" before "14.4.7".
 * 1 - it matches, somewhere.
 * 0 - it does not.
 */
export function scoreTaskMatch(
  task: SearchableTask,
  query: string,
  row?: number | null,
  parentName?: string | null,
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  if (!matchesTaskQuery(taskSearchText(task, row, parentName), q)) return 0;

  const code = task.wbs_code.toLowerCase();
  const name = task.task_name.toLowerCase();
  if (code === q || (row != null && String(row) === q)) return 3;
  if (code.startsWith(q) || name.startsWith(q)) return 2;
  return 1;
}

export type TaskSearchResult<T> = {
  /** Best first, capped at `limit`. */
  matches: T[];
  /** Matched but not shown, so the picker can say there is more. */
  hidden: number;
};

/**
 * The list the picker draws.
 *
 * Capped, because a project can carry a thousand rows and an unfiltered picker
 * that renders all of them is slow to open, which is the thing being fixed.
 * The count of what was cut is returned rather than swallowed - a picker that
 * silently shows 50 of 300 is how you conclude a task does not exist.
 */
export function searchTasks<T extends SearchableTask>(
  options: readonly T[],
  query: string,
  opts: {
    rowOf?: (wbs: string) => number | null | undefined;
    parentNameOf?: (wbs: string) => string | null | undefined;
    limit?: number;
  } = {},
): TaskSearchResult<T> {
  const limit = opts.limit ?? 50;
  const scored: { task: T; score: number; at: number }[] = [];

  options.forEach((task, at) => {
    const row = opts.rowOf?.(task.wbs_code) ?? null;
    const parentName = opts.parentNameOf?.(task.wbs_code) ?? null;
    const score = scoreTaskMatch(task, query, row, parentName);
    if (score > 0) scored.push({ task, score, at });
  });

  // Ties keep the order they came in, which is WBS order. A picker that
  // reshuffles equally good answers on every keystroke is unusable.
  scored.sort((a, b) => (b.score - a.score) || (a.at - b.at));

  return {
    matches: scored.slice(0, limit).map((s) => s.task),
    hidden: Math.max(0, scored.length - limit),
  };
}

/**
 * What the box reads when it is not being typed in.
 *
 * The branch is named when there is one, because "16 - Lead Time" does not
 * tell you which of five Lead Times you picked.
 */
export function taskDisplayLabel(
  wbs: string,
  opts: { name?: string | null; row?: number | null; parentName?: string | null },
): string {
  if (!wbs) return "";
  const head = opts.row != null ? String(opts.row) : wbs;
  if (!opts.name) return `${wbs} (not found)`;
  const tail = opts.parentName ? ` (${opts.parentName})` : "";
  return `${head} - ${opts.name}${tail}`;
}
