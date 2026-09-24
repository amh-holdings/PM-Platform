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

// ---------------------------------------------------------------------------
// Add to AFP: a purchase order puts a typed amount on the pay application
// ---------------------------------------------------------------------------
//
// A procurement line's amount is normally derived: PO payment milestones say
// what has been earned, and the Bill this period panel recomputes it on every
// read. That is right when the owner is billed on the same events we pay the
// vendor on, and wrong the rest of the time - PO-022 pays the vendor 50% on
// deposit and 50% on delivery while the owner is billed half the PO total the
// day it goes out.
//
// The short way to say that is to say it: whoever raises the PO types what
// goes on the AFP. A typed figure is a fact, so it wins over the estimate and
// survives a reload rather than being recomputed back to the milestone answer.

/** Half the PO, the standing rule, as the amount the dialog opens on. */
export const DEFAULT_OWNER_BILL_PCT = 50;

export function defaultAfpAmountForPo(poTotalValue: number): number {
  const total = Number(poTotalValue);
  if (!Number.isFinite(total) || total <= 0) return 0;
  // Multiply before dividing so 8,960.49 gives 4,480.25 rather than a float
  // that rounds to 4,480.24.
  return Math.round(total * DEFAULT_OWNER_BILL_PCT) / 100;
}

export type ProcurementAmount =
  | { kind: "manual"; amount: number }
  | { kind: "earned"; amount: number }
  | { kind: "blocked"; reason: "already_billed" | "nothing_earned" };

/**
 * What a procurement row on the Bill this period panel is worth this period.
 *
 * A typed amount is taken as given and is NOT netted against what the line has
 * already billed. The netting exists to stop a milestone estimate re-offering
 * value the owner has already paid for, which is a guess correcting a guess.
 * A person who opened the PO, read what the line has been billed, and typed a
 * number has already done that subtraction. Quietly redoing it would turn
 * their figure into a smaller one with no explanation.
 */
export function resolveProcurementAmount(input: {
  manualAmount?: number | null;
  earnedValue: number;
  alreadyBilled: number;
}): ProcurementAmount {
  const manual = Number(input.manualAmount ?? 0);
  if (Number.isFinite(manual) && manual > 0) {
    return { kind: "manual", amount: manual };
  }
  const billable = Math.max(0, input.earnedValue - input.alreadyBilled);
  if (billable > 0) return { kind: "earned", amount: billable };
  return {
    kind: "blocked",
    reason: input.earnedValue > 0 ? "already_billed" : "nothing_earned",
  };
}

/**
 * Which SOV line an Add to AFP amount lands on by default.
 *
 * Billing allocations are the explicit answer: somebody has already said how
 * much of this PO belongs to which line. Where a PO spans several, the largest
 * share is the sensible opening guess and the dialog lets it be changed.
 * linked_procurement_order_ids is the older, amount-less link and only decides
 * it when there is exactly one candidate.
 */
export function pickAfpTargetLine(opts: {
  allocations: { billingLineId: string; amount: number }[];
  linkedLineIds: string[];
}): string | null {
  const allocs = opts.allocations.filter((a) => a.billingLineId);
  if (allocs.length > 0) {
    return allocs.reduce((best, a) =>
      Number(a.amount ?? 0) > Number(best.amount ?? 0) ? a : best,
    ).billingLineId;
  }
  const linked = opts.linkedLineIds.filter(Boolean);
  return linked.length === 1 ? linked[0] : null;
}

/**
 * A figure somebody typed against a purchase order, or null when there is none.
 *
 * This is the gate in front of every estimator on the Bill this period panel.
 * It used to sit inside the procurement branch only, so Add to AFP worked on a
 * procurement SOV line and was thrown away on every other kind: the row got
 * blocked at $0 with a reason about field reports and the typed number was
 * nowhere on the page.
 *
 * A percent is an estimate and the app is right to argue with it. A dollar
 * amount entered against a PO is not an estimate, and nothing here knows
 * better than the person who opened that PO.
 *
 * Zero is not a typed figure, it is an empty box. Negative is refused rather
 * than credited.
 */
export function typedAmount(manualAmount: number | null | undefined): number | null {
  const n = Number(manualAmount ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}
