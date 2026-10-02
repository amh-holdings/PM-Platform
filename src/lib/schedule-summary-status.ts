// A summary row's status is its children's, never its own.
//
// Zarina: "if a children task has been completed, the parent row is dependent
// to all task under it and should be completed as well automatically. Not set
// it as separate task."
//
// Progress already works this way - buildProgress rolls a summary's percent up
// from its leaves and ProgressCell refuses to let anyone type over it. Status
// did not. It was a plain dropdown on every row, so a summary could read
// Complete with half its work open, or sit on Not Started after the crew had
// finished everything inside it. Both happened on Sweet Springs, and both are
// the kind of thing that reaches a pay application.
//
// Pure, and separate from the grid, because the same answer has to be given in
// three places: the cell the user looks at, the write the server makes, and
// the tests.

export type SummaryStatusTask = {
  wbs_code: string;
  status?: string | null;
};

/**
 * Which of the three states a leaf's status counts as.
 *
 * Matched loosely on purpose. The dropdown offers Not Started / In Progress /
 * Complete, but the column is free text underneath and imports have put
 * "Completed" and "COMPLETE" in it. Anything else that carries meaning - "On
 * Hold", "Delayed", "Rejected" - is work that has started and has not
 * finished, which is exactly what in-progress means to a parent.
 *
 * Approved counts as finished alongside Complete, because that is already the
 * call schedule-status-tone.ts makes: statusTintBeatsCriticality groups the
 * two as done. A submittal branch whose every row is Approved is a branch with
 * no work left in it, and it should read the same as any other finished one.
 */
export type LeafState = "complete" | "notStarted" | "inProgress" | "silent";

export function leafStateOf(status: string | null | undefined): LeafState {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return "silent";
  if (s.startsWith("complete")) return "complete";
  if (s.startsWith("approved")) return "complete";
  if (s.startsWith("not started")) return "notStarted";
  return "inProgress";
}

/**
 * The status a summary should carry, given its leaves.
 *
 * Null means "say nothing". That is the answer when the summary has no leaves
 * at all, and when not one leaf has a status: asserting Not Started over a
 * branch nobody has reported on would put a claim in the schedule that nobody
 * made, which is the same rule buildProgress follows with "no report".
 *
 * A leaf with no status is NOT complete, so a branch is only Complete when
 * every leaf under it says so. Half a branch reported and the rest blank reads
 * In Progress, which is true.
 */
export function rollUpStatus(
  leafStatuses: readonly (string | null | undefined)[],
): string | null {
  if (!leafStatuses.length) return null;
  const states = leafStatuses.map(leafStateOf);
  if (states.every((s) => s === "silent")) return null;
  if (states.every((s) => s === "complete")) return "Complete";
  if (states.every((s) => s === "notStarted" || s === "silent")) return "Not Started";
  return "In Progress";
}

/**
 * Leaf descendants of every summary row, keyed by WBS code.
 *
 * Built in one prefix pass rather than a loop over every pair, for the reason
 * spelled out in schedule-rollup.ts: 200 rows is 40,000 comparisons otherwise,
 * on every keystroke in a grid you can type into.
 */
function leavesBySummary<T extends SummaryStatusTask>(
  tasks: readonly T[],
): Map<string, T[]> {
  const present = new Set(tasks.map((t) => t.wbs_code));
  const descendants = new Map<string, T[]>();
  for (const t of tasks) {
    let dot = t.wbs_code.lastIndexOf(".");
    while (dot !== -1) {
      const ancestor = t.wbs_code.slice(0, dot);
      if (present.has(ancestor)) {
        const list = descendants.get(ancestor) ?? [];
        list.push(t);
        descendants.set(ancestor, list);
      }
      dot = ancestor.lastIndexOf(".");
    }
  }
  const out = new Map<string, T[]>();
  for (const [code, kids] of Array.from(descendants.entries())) {
    out.set(
      code,
      kids.filter((k) => !descendants.has(k.wbs_code)),
    );
  }
  return out;
}

/**
 * Every summary row's rolled-up status, keyed by WBS code.
 *
 * Summaries only. A leaf is absent from the map, which is what tells the grid
 * and the server that its status is still the person's to set.
 */
export function buildSummaryStatus(
  tasks: readonly SummaryStatusTask[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [code, leaves] of Array.from(leavesBySummary(tasks).entries())) {
    out.set(code, rollUpStatus(leaves.map((l) => l.status)));
  }
  return out;
}

export type SummaryStatusChange = {
  wbs_code: string;
  from: string | null;
  to: string;
};

/**
 * The summary rows whose stored status disagrees with their children.
 *
 * What the server writes. A rolled status of null is skipped rather than
 * written as an empty string: "nobody has reported on this branch" and
 * "somebody cleared this field" are different facts, and only the second one
 * is a change a person made.
 */
export function summaryStatusChanges(
  tasks: readonly SummaryStatusTask[],
): SummaryStatusChange[] {
  const rolled = buildSummaryStatus(tasks);
  const changes: SummaryStatusChange[] = [];
  for (const t of tasks) {
    const want = rolled.get(t.wbs_code);
    if (want == null) continue;
    const have = (t.status ?? "").trim();
    if (have.toLowerCase() === want.toLowerCase()) continue;
    changes.push({ wbs_code: t.wbs_code, from: t.status ?? null, to: want });
  }
  return changes;
}
