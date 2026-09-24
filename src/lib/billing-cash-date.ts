// The month owner money actually reaches the bank.
//
// The forecast was computing this one way for every entry: period month plus
// the contract's Net terms. That is the right answer for an AFP that has not
// been paid yet, and the wrong answer for one that has. AFP 11 was paid on a
// day that happened, and the curve still drew it wherever Net 30 put it.
//
// Nothing in the app ever wrote billing_entries.cash_in_month. The column was
// read and never populated, so the terms path was the only path. What IS
// written is pay_applications.paid_at, set the moment somebody marks the AFP
// paid, and every entry carries pay_application_id. So the real date was
// already in the database, one join away, and the forecast was ignoring it.
//
// Read at load time rather than backfilled onto the entries: every AFP already
// marked paid is corrected the next time the dashboard renders, with nothing
// to run and nothing to migrate.
//
// Priority, highest first:
//   1. cash_in_month, if anything ever sets it. A person overriding the
//      forecast outranks the forecast.
//   2. The entry's own paid_at, then the pay application's. Money that moved.
//   3. Period month plus Net terms. The forecast, for anything unpaid.
//
// Terms are NOT applied on top of a payment date. Net 30 describes when the
// owner is expected to pay; once they have paid, the date is the date.

import { monthIsoFromDate, shiftByDaysToMonth } from "@/lib/cashflow";

export type OwnerCashSource =
  | "override"  // cash_in_month was set by hand
  | "paid"      // the AFP or the entry carries a real payment date
  | "terms"     // period month plus Net terms
  | "period";   // no terms on the project, so the work month

export type OwnerCashMonth = {
  month: string;
  source: OwnerCashSource;
  /** The real payment date behind a "paid" month, for the UI to name. */
  paidOn: string | null;
  /**
   * The month the terms would have produced, when a real payment date puts
   * the money in a different one. Same-month is not worth reporting.
   */
  supersedes: string | null;
};

/** Dates come back from the driver as date or timestamptz. Keep the day. */
function dayOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const day = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function ownerCashMonth(input: {
  periodMonth: string;
  /** billing_entries.cash_in_month */
  cashInMonth?: string | null;
  /** billing_entries.paid_at */
  entryPaidAt?: string | null;
  /** pay_applications.paid_at, via billing_entries.pay_application_id */
  payAppPaidAt?: string | null;
  ownerTermsDays: number;
}): OwnerCashMonth {
  const termsMonth =
    input.ownerTermsDays > 0
      ? shiftByDaysToMonth(input.periodMonth, input.ownerTermsDays)
      : input.periodMonth;
  const termsSource: OwnerCashSource = input.ownerTermsDays > 0 ? "terms" : "period";

  if (input.cashInMonth) {
    return {
      month: monthIsoFromDate(input.cashInMonth),
      source: "override",
      paidOn: null,
      supersedes: null,
    };
  }

  const paidOn = dayOf(input.entryPaidAt) ?? dayOf(input.payAppPaidAt);
  if (paidOn) {
    const month = monthIsoFromDate(paidOn);
    return {
      month,
      source: "paid",
      paidOn,
      supersedes: month === termsMonth ? null : termsMonth,
    };
  }

  return { month: termsMonth, source: termsSource, paidOn: null, supersedes: null };
}

/**
 * The line the dashboard shows when a real payment date moved an AFP out of
 * the month the terms put it in. Said out loud for the same reason the vendor
 * moves are: a number that shifts on its own with no explanation is how people
 * stop trusting the curve.
 */
export function describeOwnerCashMove(input: {
  label: string;
  at: OwnerCashMonth;
}): string {
  const { label, at } = input;
  return `${label}: paid ${at.paidOn}, so the cash lands in ${at.month.slice(0, 7)} rather than the ${at.supersedes?.slice(0, 7)} the payment terms give`;
}

export function describeOwnerCashMoveCount(n: number): string {
  if (n === 1) return "1 payment received lands on its real date, not its terms date";
  return `${n} payments received land on their real dates, not their terms dates`;
}
