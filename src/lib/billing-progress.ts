// Per-line billing progress: what was billed before this period, what is being
// billed in it, and how far along the line is.
//
// The rules here are the G703 rules, lifted out of pay-app-actions.ts so the
// Billing page and the pay application cannot drift apart. If one of them says
// SOV 6.02 is 40% complete and the other prints 55% on the G702, the owner
// gets two different stories about the same money.

/** Statuses past 'forecast' - the row represents money that actually went out. */
export const BILLED_STATUSES = new Set([
  "on_pay_app",
  "submitted",
  "approved",
  "paid",
]);

export type BillingEntryLike = {
  billing_line_id: string;
  period_month: string;
  actual_amount?: number | null;
  planned_amount?: number | null;
  pay_application_id?: string | null;
  afp_number?: string | null;
  status?: string | null;
};

// A non-zero actual_amount is NOT proof on its own. scripts/import-cashflow*
// loaded the owner cash-flow spreadsheet into actual_amount for months that
// were only ever projections - Sweet Springs carries $160,381 / $80,000 /
// $40,000 on 2026-06 with status 'forecast' and no AFP, for civil work that had
// not happened. Treating those as billed reports money the owner never paid.
// Mirrors hasBillingEvidence() in pay-app-actions.ts and the case expression in
// v_billing_line_totals (db/migrations/0037) - keep all three in step.
export function hasBillingEvidence(e: {
  pay_application_id?: string | null;
  afp_number?: string | null;
  status?: string | null;
}): boolean {
  return (
    !!e.pay_application_id ||
    !!e.afp_number ||
    BILLED_STATUSES.has(e.status ?? "")
  );
}

/**
 * Dollars an entry represents. actual_amount wins when set, so a freshly
 * promoted forecast (planned only) still carries a number.
 */
export function entryAmount(e: BillingEntryLike): number {
  const actual = Number(e.actual_amount ?? 0);
  return actual > 0 ? actual : Number(e.planned_amount ?? 0);
}

export type LineBillingSummary = {
  /** Billed in months before the period, evidence required. */
  previous: number;
  /** Everything sitting in the period itself, billed or still forecast. */
  current: number;
  /** The part of `current` that has billing evidence behind it. */
  currentBilled: number;
  /**
   * Prior-month dollars with no evidence they went out. Not counted in
   * `previous`; surfaced so a stale forecast can be flagged rather than
   * silently swallowed.
   */
  stalePrior: number;
};

const EMPTY: LineBillingSummary = {
  previous: 0,
  current: 0,
  currentBilled: 0,
  stalePrior: 0,
};

export function emptyLineBillingSummary(): LineBillingSummary {
  return { ...EMPTY };
}

/**
 * Bucket billing_entries per line against one billing period. `periodStart` and
 * `periodEnd` are YYYY-MM-DD; period_month comes back from Postgres in the same
 * shape, so plain string comparison orders them correctly.
 */
export function summarizeLineBilling(
  entries: BillingEntryLike[] | null | undefined,
  periodStart: string,
  periodEnd: string,
): Map<string, LineBillingSummary> {
  const byLine = new Map<string, LineBillingSummary>();
  for (const e of entries ?? []) {
    if (!e.billing_line_id) continue;
    const amount = entryAmount(e);
    if (amount <= 0) continue;

    let b = byLine.get(e.billing_line_id);
    if (!b) {
      b = emptyLineBillingSummary();
      byLine.set(e.billing_line_id, b);
    }

    if (e.period_month >= periodStart && e.period_month <= periodEnd) {
      b.current += amount;
      if (hasBillingEvidence(e)) b.currentBilled += amount;
    } else if (e.period_month < periodStart) {
      if (hasBillingEvidence(e)) b.previous += amount;
      else b.stalePrior += amount;
    }
    // Months after the period are forecast for a later AFP - not this line's
    // progress, and already reported by the Planned column.
  }
  return byLine;
}

/** Completion through the end of the period, as a percent capped at 100. */
export function completionPct(
  summary: LineBillingSummary,
  scheduledValue: number,
): number {
  if (!(scheduledValue > 0)) return 0;
  return Math.min(100, ((summary.previous + summary.current) / scheduledValue) * 100);
}

export function formatPct(value: number): string {
  return `${value.toFixed(value >= 10 || value === 0 ? 0 : 1)}%`;
}
