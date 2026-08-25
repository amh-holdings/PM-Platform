// Which calendar month an AFP bills.
//
// The "Bill this period" panel was pinned to "current month + immediate next
// month". That did two harmful things: it mixed two months into a single
// application, and it made a closed month unbillable - assembling August's AFP
// on 3 September found August already outside the window. A period is now
// chosen explicitly, and the selector reaches six months back, so a month that
// closed before anyone got to it is still reachable.
//
// Lives here rather than in billing-actions.ts because that file is "use server"
// and may only export async functions.

/**
 * Calendar fallback for a project that has never billed: the current month.
 *
 * This is NOT the right default for a project with billing history - the period
 * to open on is the one the next AFP will cover, which depends on what has
 * already been billed, not on what the calendar says. Use resolveBillingPeriod()
 * in billing-period-resolve.ts, which falls back here when there is no history.
 *
 * Anything that turns a period into a schedule as-of date must go through
 * progressAsOf(), not periodEndOf() - see below.
 */
export function defaultBillingPeriod(today: Date = new Date()): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
}

/** The month following a YYYY-MM-DD date, as YYYY-MM-01. */
export function monthAfter(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Whole months from `from` to `to`, negative when `to` is earlier. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/** Last calendar day of the month a YYYY-MM-01 string names. */
export function periodEndOf(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/** "Aug 2026" for a YYYY-MM-01 string. */
export function periodLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The date a period's progress is measured at: the end of the period, or today,
 * whichever comes first.
 *
 * Progress is evaluated as of the end of the period being billed, not today -
 * billing August on 3 September must see the schedule as it stood on 31 August,
 * or estimateTaskProgress's date interpolation credits September's planned work
 * to August's application.
 *
 * The clamp matters now that the default period is the current month. Plain
 * periodEndOf() would hand estimateTaskProgress a date in the future: billing
 * August on 20 August would measure the schedule as of 31 August and bill for
 * eleven days of work nobody has done yet. Rules 3 and 4 in estimateTaskProgress
 * (past-due fallback and linear interpolation) both key off this date.
 */
export function progressAsOf(periodMonth: string, today: Date = new Date()): string {
  const end = periodEndOf(periodMonth);
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return todayIso < end ? todayIso : end;
}
