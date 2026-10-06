// Which copy of the schedule a weekly report's look-ahead is built from.
//
// The look-ahead window has always been anchored to the week being reported -
// the three weeks starting the Monday after the period ends. What was NOT
// anchored is the schedule it reads. buildLookahead ran over the live rows, so
// a report pulled up for a week in August answered "which tasks, on today's
// forecast, fall in those three August weeks". Three things make that the
// wrong answer:
//
//   1. buildLookahead skips anything with status Complete, so every task that
//      was ahead of us in August and has since finished vanishes. The box
//      comes out near-empty for any week far enough back.
//   2. Projected dates are today's. A task due that August week that has since
//      slipped to November now sits in November and fails the overlap test;
//      one pulled forward appears in a week nobody planned it for.
//   3. Each card carries today's percent, so a surviving card can read 100%
//      inside a look-ahead, which is a contradiction in terms.
//
// Zarina: "can it show the look ahead based on the past?"
//
// It can, because schedule_updates already holds a full frozen copy of every
// task row once a week with the data date it was taken on (0033, taken by
// ensureWeeklySnapshot on the first project open of each week). Rebuilding the
// look-ahead from the snapshot that was current when the report was written
// gives what was actually ahead of the crew that Monday.
//
// Pure, so the choice of snapshot is testable without a database.

export type ScheduleSnapshotMeta = {
  /** The data date the snapshot was taken on. */
  dataDate: string;
};

export type LookaheadBasis =
  /** The week being reported is the current one, so the live schedule IS the answer. */
  | { kind: "live" }
  /** A past week, rebuilt from the schedule as it stood then. */
  | { kind: "snapshot"; dataDate: string }
  /** A past week with no snapshot behind it. Live rows, and the page says so. */
  | { kind: "stale" };

/**
 * The snapshot to build a past week's look-ahead from.
 *
 * The newest one taken on or before the look-ahead's first day, which is the
 * schedule that was on the desk when that week's report was due. A snapshot
 * taken AFTER it already carries work the crew had not done yet, and using it
 * would reintroduce the hindsight this exists to remove.
 *
 * Returns null when nothing qualifies - a project opened for the first time
 * after that week has no copy of the schedule as it was, and no amount of
 * arithmetic invents one.
 */
export function pickSnapshotFor(
  snapshots: readonly ScheduleSnapshotMeta[],
  lookaheadFrom: string,
): ScheduleSnapshotMeta | null {
  let best: ScheduleSnapshotMeta | null = null;
  for (const s of snapshots) {
    if (s.dataDate > lookaheadFrom) continue;
    if (!best || s.dataDate > best.dataDate) best = s;
  }
  return best;
}

/**
 * Which basis a week gets.
 *
 * A week that has not finished yet is live by definition: there is nothing to
 * reconstruct, and the current schedule is the most accurate statement of what
 * is coming. Only a period that has closed looks for a snapshot.
 */
export function basisFor(input: {
  periodEnd: string;
  today: string;
  snapshot: ScheduleSnapshotMeta | null;
}): LookaheadBasis {
  if (input.periodEnd >= input.today) return { kind: "live" };
  if (input.snapshot) return { kind: "snapshot", dataDate: input.snapshot.dataDate };
  return { kind: "stale" };
}

/** One line for the editor and the print sheet, or null when nothing needs saying. */
export function describeBasis(basis: LookaheadBasis): string | null {
  switch (basis.kind) {
    case "live":
      return null;
    case "snapshot":
      return `Built from the schedule as it stood on ${basis.dataDate}, not today's.`;
    case "stale":
      return "No saved copy of the schedule exists for this week, so this is today's schedule. Work finished since is missing and dates have moved.";
  }
}

/**
 * The same fact, short enough for the owner's sheet.
 *
 * The editor's wording explains the consequence to whoever is writing; a
 * document going to Dimension wants the provenance and not the lecture. It
 * still prints on a stale week rather than passing off today's schedule as
 * that week's without saying so.
 */
export function describeBasisShort(basis: LookaheadBasis): string | null {
  switch (basis.kind) {
    case "live":
      return null;
    case "snapshot":
      return `Schedule as of ${basis.dataDate}.`;
    case "stale":
      return "Schedule as of today; no saved copy exists for this week.";
  }
}
