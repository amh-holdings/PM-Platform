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

export type BlankDayTone =
  /** Phil's to fix now. Nobody else is coming. */
  | "mine"
  /** Real work, but the next move belongs to the sub or the CM. */
  | "waiting"
  /** No evidence anyone was on site. A blank row here is just the truth. */
  | "quiet";

export type BlankDayFlag = { label: string; tone: BlankDayTone };

export function blankDayReason(ev: BlankDayEvidence): BlankDayFlag {
  const hasReport = ev.reportStatus != null;

  // Nothing says anyone worked. An empty row is the correct answer.
  if (!hasReport && !ev.hasCmLog) {
    return { label: "no field report", tone: "quiet" };
  }

  switch (ev.reportStatus) {
    case "approved":
      // The alarm this page exists for. An approved report is work that
      // happened, and a blank row is the owner being told it did not.
      return { label: "nothing filed", tone: "mine" };
    case "submitted":
      return { label: "awaiting CM review", tone: "waiting" };
    case "returned":
      return { label: "returned to sub", tone: "waiting" };
    case "draft":
      return { label: "sub has not filed", tone: "waiting" };
    default:
      // No field report at all, but the CM logged the day. No approval is
      // coming to fill this one and no sub is going to file it late - the
      // quantities have to be read off the CM's log by hand.
      return { label: "CM logged work, no report", tone: "mine" };
  }
}

/** True when the day needs somebody to look at it rather than nobody. */
export function isFlaggedBlankDay(flag: BlankDayFlag | null): boolean {
  return flag != null && flag.tone !== "quiet";
}
