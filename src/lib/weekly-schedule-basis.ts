// Which copy of the schedule a weekly report reads.
//
// The report has two halves. The field record - approved daily reports, crews,
// man-hours, equipment, delays, photos, inspections, production - was always
// scoped to the reported week by date. The schedule half was not: it read the
// live rows, so a report pulled up for a week in September answered every
// schedule question with October's answer.
//
// That is wrong in the direction that flatters us. Percent complete counts
// work finished after the period as if it were done inside it, the activity
// count moves, and the projected finish is the current plan rather than the
// one in force that week.
//
// The look-ahead had the same disease with a sharper edge. Its window was
// always anchored to the reported week, but buildLookahead skips anything with
// status Complete, so every task that was ahead of us then and has since
// finished vanished and the box came out near-empty. Projected dates were
// today's, so work due that week but since slipped to November sat in November
// and fell outside the window.
//
// Zarina: "can it show the look ahead based on the past?" and then, on the
// Progress block: "Can this result back to week of 09/14".
//
// It can, because schedule_updates already holds a full frozen copy of every
// task row once a week with the data date it was taken on (0033, written by
// ensureWeeklySnapshot on the first project open of each week). A closed week
// reads that copy instead of the live rows.
//
// Pure, so the choice of snapshot is testable without a database.

export type ScheduleSnapshotMeta = {
  /** The data date the snapshot was taken on. */
  dataDate: string;
};

export type ScheduleBasis =
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
}): ScheduleBasis {
  if (input.periodEnd >= input.today) return { kind: "live" };
  if (input.snapshot) return { kind: "snapshot", dataDate: input.snapshot.dataDate };
  return { kind: "stale" };
}

/** One line for the editor, or null when nothing needs saying. */
export function describeBasis(basis: ScheduleBasis): string | null {
  switch (basis.kind) {
    case "live":
      return null;
    case "snapshot":
      return `Schedule figures are as they stood on ${basis.dataDate}, not today's.`;
    case "stale":
      return "No saved copy of the schedule exists for this week, so the schedule figures are today's. Percent complete counts work finished since the period, and the look-ahead is missing anything completed since.";
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
export function describeBasisShort(basis: ScheduleBasis): string | null {
  switch (basis.kind) {
    case "live":
      return null;
    case "snapshot":
      return `Schedule as of ${basis.dataDate}.`;
    case "stale":
      return "Schedule as of today; no saved copy exists for this week.";
  }
}
