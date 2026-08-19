// Which calendar month an AFP bills.
//
// The "Bill this period" panel was pinned to "current month + immediate next
// month". That did two harmful things: it mixed two months into a single
// application, and it made a closed month unbillable - assembling August's AFP
// on 3 September found August already outside the window. AFPs bill in arrears,
// so a period is chosen explicitly and defaults to the last full month.
//
// Lives here rather than in billing-actions.ts because that file is "use server"
// and may only export async functions.

/** Last full calendar month, as YYYY-MM-01. */
export function defaultBillingPeriod(today: Date = new Date()): string {
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
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
