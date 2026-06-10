// Shared cash-flow helpers used by dashboard widgets.
//
// Rules these helpers encode:
//   1. "Effective" amount = actual when > 0, otherwise planned.
//      Avoids the double-count bug where planned+actual were summed for the
//      same period (an entry that's been paid still has a planned forecast).
//   2. Owner cash-in date = billing_entries.cash_in_month when set,
//      otherwise period_month + projects.owner_payment_terms_days.
//   3. Sub cash-out date = period_month + subcontractor.payment_terms_days.
//      Sub retainage is held; net of retainage = gross * (1 - pct/100).
//   4. Vendor cash-out comes from procurement_payments.expected_date - we do
//      NOT also count cost_forecasts on vendor-linked codes (would double).

export function effectiveAmount(
  actual: number | null | undefined,
  planned: number | null | undefined,
): number {
  const a = Number(actual ?? 0);
  if (a > 0) return a;
  return Number(planned ?? 0);
}

export function firstOfMonthIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function firstOfThisMonthIso(): string {
  return firstOfMonthIso(new Date());
}

export function addMonthsIso(iso: string, n: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// Shifts a period_month bucket by Net X payment terms.
// Convention: "work performed in month X, invoiced end-of-month, Net N days"
//   -> paid in month X + ceil(N / 30).
//   Net 30 -> +1 month, Net 45/60 -> +2 months, Net 75/90 -> +3 months.
// This is a monthly approximation of day-precise terms - the bucketing is
// what matters for cash-flow planning, not whether payment lands on the
// 28th vs the 31st.
export function shiftByDaysToMonth(periodMonth: string, days: number): string {
  if (!days || days <= 0) return periodMonth;
  return addMonthsIso(periodMonth, Math.ceil(days / 30));
}

export function monthIsoFromDate(iso: string): string {
  return iso.slice(0, 7) + "-01";
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function shortMonthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTH_LABELS[m - 1]} ${String(y).slice(2)}`;
}
