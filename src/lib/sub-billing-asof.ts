// The schedule as it stood on a past date, for judging a sub's bill.
//
// schedule_tasks holds one copy of each task - today's. The first answer to
// "what did the schedule say on 25 September" was the weekly snapshot saved
// nearest before it (schedule_updates). Pyramid's 9/1-9/25 bill showed why
// that is not enough on its own: the 21 September snapshot had Rough Road at
// 10% and Basin 2's riser Not Started, while the live schedule - brought up to
// date afterwards - has Rough Road finished on 25 August and the riser on 18
// September. A snapshot is only as current as the updates entered before it
// was taken, and updates are routinely entered late. The billing tool read
// the access road as unbuilt and flagged a correct $40k line.
//
// So the order of trust, per task:
//   1. Finished on or before the cut-off, per the live schedule  -> 100%.
//   2. The latest approved field-report pin dated on or before it -> that %.
//      Same evidence that moves the live percent (applyPinProgressToSchedule).
//   3. The weekly snapshot's row, when one exists                 -> as saved.
//   4. Not started until after the cut-off                        -> 0%.
//   5. Otherwise, open across the cut-off with nothing reported    -> straight
//      line between its start and finish, marked as an estimate.

export type AsOfTask = {
  wbs_code: string;
  task_name?: string | null;
  status?: string | null;
  pct_complete?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  duration_days?: number | null;
};

export type AsOfPin = { wbsCode: string; reportDate: string; pct: number | null };

export type AsOfBasis = "finished" | "report" | "snapshot" | "not_started" | "prorated" | "live";

const isComplete = (t: AsOfTask) => (t.status ?? "").toLowerCase() === "complete";

export function tasksAsOf(args: {
  live: AsOfTask[];
  pins: AsOfPin[];
  snapshot: AsOfTask[] | null;
  asOf: string;
}): { tasks: AsOfTask[]; basis: Map<string, AsOfBasis> } {
  const { live, pins, snapshot, asOf } = args;

  // Latest pin per task on or before the cut-off. Ties on the same report date
  // take the higher figure: two pins on one day are two crews on one task.
  const latestPin = new Map<string, AsOfPin>();
  for (const p of pins) {
    if (p.reportDate > asOf || p.pct == null) continue;
    const cur = latestPin.get(p.wbsCode);
    if (
      !cur ||
      p.reportDate > cur.reportDate ||
      (p.reportDate === cur.reportDate && Number(p.pct) > Number(cur.pct))
    ) {
      latestPin.set(p.wbsCode, p);
    }
  }
  const snap = new Map((snapshot ?? []).map((t) => [t.wbs_code, t]));

  const basis = new Map<string, AsOfBasis>();
  const tasks = live.map((t): AsOfTask => {
    const set = (b: AsOfBasis, row: AsOfTask) => {
      basis.set(t.wbs_code, b);
      return row;
    };

    if (isComplete(t) && t.end_date && t.end_date <= asOf) {
      return set("finished", { ...t, status: "Complete", pct_complete: 100 });
    }
    const pin = latestPin.get(t.wbs_code);
    if (pin) {
      const pct = Math.max(0, Math.min(100, Number(pin.pct)));
      return set("report", {
        ...t,
        status: pct >= 100 ? "Complete" : pct > 0 ? "In Progress" : "Not Started",
        pct_complete: pct,
      });
    }
    const s = snap.get(t.wbs_code);
    if (s) {
      // Dates and duration stay live: they weight the line, and the live ones
      // are the corrected ones. Only the progress comes from the snapshot.
      return set("snapshot", { ...t, status: s.status ?? null, pct_complete: s.pct_complete ?? null });
    }
    if (!t.start_date || t.start_date > asOf) {
      return set("not_started", { ...t, status: "Not Started", pct_complete: 0 });
    }
    if (t.end_date && t.end_date > t.start_date) {
      const span = Date.parse(t.end_date) - Date.parse(t.start_date);
      const done = Date.parse(asOf) - Date.parse(t.start_date);
      const pct = Math.round(Math.max(0, Math.min(1, done / span)) * 100);
      return set("prorated", { ...t, status: "In Progress", pct_complete: pct });
    }
    return set("live", t);
  });

  return { tasks, basis };
}

/**
 * The leaf tasks under each linked code.
 *
 * An SOV line linked to a summary row read that row's own percent, and summary
 * rows do not roll up: on Sweet Springs "Construct Basin 1 ESC" read Complete
 * at 7% after it was split into seven subtasks on 9/8, and the line mapped to
 * it read 7% for a basin that was built. Linking the summary now means "all
 * the work under it", which also keeps the mapping right the next time a task
 * is split.
 */
export function expandToLeaves(codes: string[], allCodes: Iterable<string>): string[] {
  const all = Array.from(allCodes);
  const out: string[] = [];
  for (const code of codes) {
    const below = all.filter((c) => c.startsWith(`${code}.`));
    const leaves = below.filter((c) => !all.some((o) => o.startsWith(`${c}.`)));
    for (const c of leaves.length ? leaves : [code]) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Days from an earlier ISO date to a later one. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** An evidence source not touched in this many days, on a line being billed, is called out. */
export const STALE_EVIDENCE_DAYS = 14;
