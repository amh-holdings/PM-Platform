// Why a day on the Commodity Tracker is empty, and whose move it is.
//
// FOUR SITUATIONS, ONE BLANK ROW
// An approved day nobody has valued, a report still in the CM's queue, a report
// returned to the sub, and a day with no report at all all render as the same
// empty row. Only some of them are Phil's to act on, and telling them apart by
// eye is how a report sitting returned for a week reads as "quiet week on site".
//
// THE CASE THIS WAS MISSING
// The rule used to look at the field report's status and nothing else. So a day
// where the CM wrote up the work in their own log, but no sub ever filed a
// report, came back as "no field report" in grey - indistinguishable from a day
// nobody was on site. That is backwards: AHC's own record says work happened,
// and nobody is going to file that report later. It is the loudest case on the
// page, not the quietest.
//
// So the question is evidence first, status second. Evidence is a CM daily log
// or a field report in any state. No evidence means a genuinely quiet day.
// Evidence with an empty tracker always says something.

export type BlankDayEvidence = {
  /** dprs.status for the day, or null when no field report exists. */
  reportStatus: string | null;
  /** True when a CM daily log carries a progress summary for the day. */
  hasCmLog: boolean;
};

/**
 * One colour per situation, not one per "whose move".
 *
 * Returned and awaiting-review are both somebody else's move, but they are not
 * the same news: a returned report was rejected and is losing days, a submitted
 * one is moving through review normally. Painting them the same amber is what
 * the grey did at a lower contrast.
 */
export type BlankDayTone =
  /** Work on record, nothing on the tracker. Red. */
  | "unfilled"
  /** Rejected and sitting with the sub. Orange. */
  | "returned"
  /** In the CM's queue, moving normally. Blue. */
  | "review"
  /** The sub has not filed it yet. Amber. */
  | "draft"
  /** No evidence anyone was on site. Grey. */
  | "quiet";

export type BlankDayFlag = {
  label: string;
  tone: BlankDayTone;
  /** True when Phil is the one who has to act. Nobody else is coming. */
  mine: boolean;
};

/** Tailwind classes per tone, light and dark. Kept beside the tones so a new
 *  situation cannot be added without deciding what colour it is. */
export const TONE_CLASS: Record<BlankDayTone, string> = {
  unfilled: "bg-destructive/15 text-destructive",
  returned: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  review: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  draft: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  quiet: "bg-muted text-muted-foreground",
};

const STATUS_FLAG: Record<string, BlankDayFlag> = {
  // The alarm this page exists for. An approved report is work that happened,
  // and a blank row is the owner being told it did not.
  approved: { label: "nothing filed", tone: "unfilled", mine: true },
  submitted: { label: "awaiting CM review", tone: "review", mine: false },
  returned: { label: "returned to sub", tone: "returned", mine: false },
  draft: { label: "sub has not filed", tone: "draft", mine: false },
};

export function blankDayReason(ev: BlankDayEvidence): BlankDayFlag {
  const hasReport = ev.reportStatus != null;

  // Nothing says anyone worked. An empty row is the correct answer.
  if (!hasReport && !ev.hasCmLog) {
    return { label: "no field report", tone: "quiet", mine: false };
  }

  const known = ev.reportStatus ? STATUS_FLAG[ev.reportStatus] : undefined;
  if (known) return known;

  // No field report at all, but the CM logged the day. No approval is coming to
  // fill this one and no sub is going to file it late - the quantities have to
  // be read off the CM's log by hand.
  return { label: "CM logged work, no report", tone: "unfilled", mine: true };
}

/** True when the day needs somebody to look at it rather than nobody. */
export function isFlaggedBlankDay(flag: BlankDayFlag | null): boolean {
  return flag != null && flag.tone !== "quiet";
}

/**
 * A field report that exists but has not reached 'approved'.
 *
 * Reported whether or not the tracker carries numbers for the day: a day with
 * hand-entered quantities and a returned report is still not settled, and the
 * figures on it are standing on evidence the CM rejected.
 */
export function unfinalizedReportFlag(status: string | null): BlankDayFlag | null {
  if (status == null || status === "approved") return null;
  return (
    STATUS_FLAG[status] ?? { label: "not finalized", tone: "draft", mine: false }
  );
}
