// What a task's status looks like, in the cell and on the row.
//
// Row colour used to come from one thing: the critical path. Critical was red,
// near critical was amber, everything else was plain. That reads the schedule
// as a risk map, which is right for civil construction and useless for the
// rest of the sheet - procurement sits on 26, 28, 62 days of float, so no
// procurement row was ever tinted at all.
//
// Zarina: "Can you highlight line items based on status. Right now highlights
// only applies to civil constructions."
//
// So status tints the row too. Not every status: tinting the normal working
// states tints the whole sheet, and a colour every row carries is not a
// signal. Only the three that are exceptions to work being in flight.

/** The cell background for the Status dropdown. */
export const STATUS_TONE: Record<string, string> = {
  Complete: "bg-emerald-100 text-emerald-900",
  "In Progress": "bg-blue-100 text-blue-900",
  Awaiting: "bg-amber-100 text-amber-900",
  "Not Started": "bg-muted text-muted-foreground",
  Rejected: "bg-destructive/10 text-destructive",
  Approved: "bg-emerald-100 text-emerald-900",
};

/**
 * The row tint for a status, or null for the states that get none.
 *
 * Complete and Approved are finished, so the row should fall back visually.
 * Rejected is dead and wants to stand out. Awaiting is blocked on somebody
 * else, which is the one in-flight state worth catching an eye.
 *
 * In Progress and Not Started are what most of a live schedule is at any
 * moment. Tinting them would leave nothing untinted to contrast against, so
 * they stay plain on purpose.
 */
export function statusRowTone(status: string | null | undefined): string | null {
  switch ((status ?? "").trim()) {
    case "Complete":
    case "Approved":
      return "bg-emerald-50/70";
    case "Rejected":
      return "bg-destructive/5";
    case "Awaiting":
      return "bg-amber-50/50";
    default:
      return null;
  }
}

/**
 * Whether a status tint should win over the critical-path tint.
 *
 * A finished task is not a risk, whatever its float says, so Complete and
 * Approved cover the red. Awaiting is the other way round: a blocked task on
 * the critical path is the worst row on the sheet and the red has to survive.
 */
export function statusTintBeatsCriticality(status: string | null | undefined): boolean {
  const s = (status ?? "").trim();
  return s === "Complete" || s === "Approved" || s === "Rejected";
}

/** The row class for a task, once selection and unsaved edits have had their say. */
export function rowTone(input: {
  status: string | null | undefined;
  critical: boolean;
  nearCritical: boolean;
}): string | null {
  const fromStatus = statusRowTone(input.status);
  if (fromStatus && statusTintBeatsCriticality(input.status)) return fromStatus;
  if (input.critical) return "bg-destructive/5";
  if (input.nearCritical) return "bg-amber-50/40";
  return fromStatus;
}

/**
 * The fill colour for the progress bar in the schedule grid.
 *
 * It used to say only where the number came from: grey for a summary rolled up
 * from its leaves, green for an approved field report, amber for a figure
 * somebody typed. That is a real distinction and it matters on a pay
 * application, which is why it is kept below.
 *
 * What it never said was whether the work was finished. GroundWorks sitting at
 * 100% drew a full grey bar, because it is a summary, and read as inert.
 * Zarina: "the progress bar is grey when it is completed."
 *
 * So completion comes first and provenance second. At 100% the bar is green
 * whatever produced it, because done is the thing worth seeing across a sheet
 * of 47 rows. Below 100% the old colours stand, and how the number was
 * arrived at is still in the tooltip either way.
 *
 * The threshold is 99.5 rather than 100 so the colour agrees with the label:
 * a duration-weighted roll-up landing on 99.6 already prints "100%", and a bar
 * that says done beside a number that says done is the point.
 */
export function progressBarTone(input: {
  pct: number;
  rolled: boolean;
  source?: string | null;
}): string {
  if (Number.isFinite(input.pct) && input.pct >= 99.5) return "bg-emerald-500";
  if (input.rolled) return "bg-muted-foreground/50";
  return input.source === "dpr" ? "bg-emerald-500" : "bg-amber-500";
}
