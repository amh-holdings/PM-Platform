// Progress for every row of the schedule.
//
// Leaf tasks report what the field reported and nothing more. A task with no
// approved report shows "no report" rather than a fabricated number, which is
// the whole point of sourcing the schedule from daily reports: a percentage
// somebody typed is a percentage nobody can defend in a pay application.
//
// Summary rows roll up their leaf descendants weighted by duration, and say so.
// Duration is the only size signal these rows carry - there are no quantities
// or values on them - so a two-week task counts more than a one-day task. An
// unweighted mean would let a schedule breakdown change the reported progress
// without any work happening, which is the same disease durationWeightedPct
// was written to cure on the billing side.

export type RollupTask = {
  wbs_code: string;
  duration_days?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  pct_complete?: number | null;
  status_source?: string | null;
  last_dpr_at?: string | null;
};

export type Progress =
  | { kind: "reported"; pct: number; source: string | null; at: string | null }
  | { kind: "rolled"; pct: number; reported: number; leaves: number }
  | { kind: "none" };

function weightOf(t: RollupTask): number {
  if (t.duration_days != null && t.duration_days > 0) return t.duration_days;
  if (t.start_date && t.end_date) {
    const days = (Date.parse(t.end_date) - Date.parse(t.start_date)) / 86_400_000 + 1;
    if (Number.isFinite(days) && days > 0) return days;
  }
  return 1;
}

export function buildProgress(tasks: readonly RollupTask[]): Map<string, Progress> {
  const out = new Map<string, Progress>();

  // Descendants by prefix, built in one pass. The original did this with a
  // nested loop over every pair of tasks, which is fine at 30 rows and is
  // 40,000 comparisons at 200 - on every keystroke, once this feeds a grid you
  // can type into.
  const byPrefix = new Map<string, RollupTask[]>();
  const codes = tasks.map((t) => t.wbs_code);
  const present = new Set(codes);
  for (const t of tasks) {
    let dot = t.wbs_code.lastIndexOf(".");
    while (dot !== -1) {
      const ancestor = t.wbs_code.slice(0, dot);
      if (present.has(ancestor)) {
        const list = byPrefix.get(ancestor) ?? [];
        list.push(t);
        byPrefix.set(ancestor, list);
      }
      dot = ancestor.lastIndexOf(".");
    }
  }

  for (const t of tasks) {
    const descendants = byPrefix.get(t.wbs_code);
    if (!descendants?.length) {
      out.set(
        t.wbs_code,
        t.pct_complete != null
          ? {
              kind: "reported",
              pct: Number(t.pct_complete),
              source: t.status_source ?? null,
              at: t.last_dpr_at ?? null,
            }
          : { kind: "none" },
      );
      continue;
    }
    const leaves = descendants.filter((d) => !byPrefix.has(d.wbs_code));
    if (!leaves.length) { out.set(t.wbs_code, { kind: "none" }); continue; }
    let num = 0, den = 0, reported = 0;
    for (const leaf of leaves) {
      const w = weightOf(leaf);
      den += w;
      if (leaf.pct_complete != null) { num += Number(leaf.pct_complete) * w; reported++; }
    }
    out.set(t.wbs_code, {
      kind: "rolled",
      pct: den > 0 ? num / den : 0,
      reported,
      leaves: leaves.length,
    });
  }

  return out;
}
