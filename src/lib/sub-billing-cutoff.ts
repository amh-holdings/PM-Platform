// The window the next-bill panel projects against.
//
// Any date, not a list of month ends. The month-end list was the wrong call:
// these subs bill "through <date>" at least as often as they bill a calendar
// month, and Pyramid's own app 1 ends on 13 August. A picker that cannot
// express 13 August cannot check the bill that was actually sent. Zarina:
// "Can we make the evidence as of a selection of dates in the calendar so it
// is accurate."
//
// The only rules left are the two that keep a figure meaningful: a real date,
// and not one in the future. Evidence after today does not exist, and a
// cut-off beyond it would read as a projection of work nobody has reported.

/**
 * Is this a real calendar date, not just four-two-two digits?
 *
 * The regex alone passes 2026-02-30 and 2026-13-01. Round-tripping through
 * Date catches both: the parse normalises them to 2 March and January of
 * 2027, which no longer match what was asked for.
 */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The cut-off to use, given what arrived in the query string. */
export function resolveCutoff(requested: string | undefined, todayIso: string): string {
  if (!requested) return todayIso;
  if (!isRealDate(requested)) return todayIso;
  // A future cut-off is silently pulled back to today rather than refused.
  // There is no evidence after today, so the two produce the same table, and
  // an error page for a date nobody can bill against helps nobody.
  if (requested > todayIso) return todayIso;
  return requested;
}

/** The day before an ISO date. */
export function dayBefore(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export type CutoffRange = {
  /** Null means no window: the table reads cumulative to `to`, as it always did. */
  from: string | null;
  to: string;
};

/**
 * The window to project against, given what arrived in the query string.
 *
 * Zarina: "No, I meant to have an option to select a date range in a
 * calendar." A cut-off answers "what has been earned by this date". A sub's
 * bill asks a different question - what was earned BETWEEN two dates - and
 * that is the one you need to check an AFP covering a stated period.
 *
 * `from` is optional and stays optional. Without it the panel does what it has
 * always done, which is still the right view when the question is what the
 * next bill should come to rather than what one particular bill covered.
 */
export function resolveRange(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  todayIso: string,
): CutoffRange {
  const to = resolveCutoff(toRaw, todayIso);
  const from = fromRaw && isRealDate(fromRaw) ? fromRaw : null;

  if (!from) return { from: null, to };

  // A window that opens in the future has no evidence in it. Dropping it
  // leaves the cumulative view, which is an answer; clamping it to today
  // would invent a one-day window nobody asked for.
  if (from > todayIso) return { from: null, to };

  // A range typed backwards is a slip, not a request for nothing. Both dates
  // are in the past here, so swapping does what was meant. Refusing would
  // hand back an empty table with no explanation of why.
  if (from > to) return { from: to, to: from };

  // A window of one day is legitimate - a sub can bill a single day - so
  // equal ends are left alone.
  return { from, to };
}
