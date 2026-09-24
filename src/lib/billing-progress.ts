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

/**
 * Balance to finish through the end of the period, rounded to the cent.
 *
 * Summing entry amounts in floating point leaves sub-cent noise: Sweet Springs
 * 6.01 Mobilization is billed to the penny across AFP 11 and AFP 12, but
 * 112267.03 + 208495.89 lands 6e-11 above the scheduled value, so a raw
 * subtraction returned -0.0000000001. That rendered as a red "-$0" and read as
 * an overbill on a line that is exactly complete. Rounding at the cent - the
 * smallest unit the G703 can express - kills the noise without hiding a real
 * overbill, and -0 is normalised to 0 so Intl does not print a minus sign.
 */
export function remainingToFinish(
  summary: LineBillingSummary,
  scheduledValue: number,
): number {
  const rounded =
    Math.round((scheduledValue - summary.previous - summary.current) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

// ---------------------------------------------------------------------------
// Editing an amount on the way onto an AFP
// ---------------------------------------------------------------------------
//
// The Bill this period panel puts an editable box next to every row, including
// the blocked ones, which arrive at $0 on purpose so a person can overwrite
// them. That box only ever worked on suggestion rows: a forecast row posted
// its entry id alone, so the typed figure was dropped and the entry billed
// whatever it already held. These two are the parts worth pinning down.

/**
 * Line up posted entry ids with their posted amounts, then drop the blanks.
 *
 * Order matters and the filter has to come second. Dropping an empty id first
 * and zipping afterwards shifts every later amount onto the wrong entry, which
 * is the kind of mistake that bills the right total against the wrong lines
 * and reconciles perfectly on the summary page.
 */
export function pairForecastAmounts(
  ids: string[],
  amounts: number[],
): { id: string; amount: number }[] {
  return ids
    .map((id, i) => ({ id: id.trim(), amount: amounts[i] }))
    .filter((p) => p.id.length > 0);
}

/**
 * The patch that makes an edited amount actually bill, or null when the row
 * already reads that way and nothing needs writing.
 *
 * A pay application takes actual_amount when it is set and planned_amount
 * otherwise, so the edit has to land on whichever of the two will be read.
 * Writing planned_amount alone looks like it worked and still bills the old
 * figure on any entry that carries an actual.
 */
export function forecastAmountPatch(
  entry: { planned_amount?: number | null; actual_amount?: number | null },
  amount: number,
): { planned_amount: number; actual_amount?: number } | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const actual = Number(entry.actual_amount ?? 0);
  const current = actual !== 0 ? actual : Number(entry.planned_amount ?? 0);
  // Half a cent, so a float that comes back as 1234.5600000000002 is not
  // treated as an edit and rewritten on every AFP.
  if (Math.abs(current - amount) < 0.005) return null;
  return actual !== 0
    ? { planned_amount: amount, actual_amount: amount }
    : { planned_amount: amount };
}

// ---------------------------------------------------------------------------
// A linked line with nothing to bill: read-only, or a decision to make?
// ---------------------------------------------------------------------------

export type UnbillableLine = {
  /** What the evidence supports so far, in dollars. */
  earned: number;
  alreadyBilled: number;
  /** Measured by PO payment milestones rather than by schedule progress. */
  procurement: boolean;
  /** Total of the POs linked to the line, when it is a procurement one. */
  linkedPoTotal: number | null;
};

/**
 * Whether a line with nothing to bill belongs in the panel as a row somebody
 * can tick and price, rather than in the read-only list of explanations.
 *
 * Two cases qualify, and both are the app saying "I cannot work this out"
 * rather than "the answer is nothing".
 *
 * Earned value masked by earlier billing, where the earlier AFPs covered scope
 * this app has no record of. And a procurement line the app cannot value at
 * all, because earned value on one comes from PO payment milestones and a PO
 * whose terms were never entered reads as zero earned. The equipment is on
 * order either way; only the paperwork is missing.
 *
 * A schedule-driven line at 0% is not either of these. There the zero is a
 * measurement, and it stays read-only.
 */
export function needsADecision(n: UnbillableLine): boolean {
  if (n.earned > 0.005) return n.alreadyBilled > n.earned;
  return n.procurement;
}

/**
 * The money a percent typed on a billing row comes to, or null when the box
 * holds nothing usable yet.
 *
 * `basis * pct / 100` written as `round(basis * pct) / 100` so the result is
 * already in whole cents: 50% of $82,619.13 is $41,309.565 exactly, and an
 * amount box is not a place to put two thirds of a cent.
 *
 * Empty text returns null rather than zero, because a cleared box is somebody
 * mid-edit, not somebody billing nothing. Typing a real 0 is different and
 * comes back as 0.
 */
export function amountFromPercent(
  basis: number | null | undefined,
  text: string,
): number | null {
  if (!basis || !Number.isFinite(basis) || basis <= 0) return null;
  if (!text.trim()) return null;
  const pct = Number(text);
  if (!Number.isFinite(pct) || pct < 0) return null;
  return Math.round(basis * pct) / 100;
}
