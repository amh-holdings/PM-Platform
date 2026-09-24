/**
 * Several purchase orders billing one SOV line in one period.
 *
 * Zarina: "I added 2 POs for AFP13 but it is not reflecting in the billing it
 * should say a default number of 50% of PO17 and 50% of PO22."
 *
 * PO-017 and PO-022 both hang off SOV 5.05 POI Procurement. billing_entries
 * carries `unique (billing_line_id, period_month)`, so that line has exactly
 * one row for September, and Add to AFP wrote the typed figure straight onto
 * it. Staging the second PO replaced the first. No error, no warning, and the
 * line reported one PO's worth of money as though it were the whole story.
 *
 * A line can legitimately carry several POs - that is what a procurement SOV
 * line IS. So the amount is a sum of contributions, one per PO, and these are
 * the rules for maintaining that sum.
 */

export type PoContribution = {
  poId: string;
  amount: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Stage one PO's figure against a line, keeping the others.
 *
 * Re-staging the same PO REPLACES its own contribution rather than adding to
 * it. Typing a corrected figure must correct, not double. Adding a different
 * PO leaves every existing contribution alone, which is the whole point.
 *
 * Zero removes that PO from the line. Nothing else can remove a contribution,
 * so a figure never disappears as a side effect of entering another one.
 */
export function applyPoContribution(
  current: readonly PoContribution[],
  poId: string,
  amount: number,
): PoContribution[] {
  const amt = Number.isFinite(amount) ? round2(amount) : 0;
  const others = current.filter((c) => c.poId !== poId);
  if (amt <= 0) return others;
  // Appended rather than spliced in place, so the order reads as the order
  // they were entered and a re-typed figure moves to the end where the person
  // just worked.
  return [...others, { poId, amount: amt }];
}

export function contributionTotal(contributions: readonly PoContribution[]): number {
  return round2(contributions.reduce((sum, c) => sum + Number(c.amount ?? 0), 0));
}

/** What this PO currently contributes to the line, or zero. */
export function contributionFor(
  contributions: readonly PoContribution[],
  poId: string,
): number {
  return round2(
    contributions
      .filter((c) => c.poId === poId)
      .reduce((sum, c) => sum + Number(c.amount ?? 0), 0),
  );
}

/**
 * The breakdown as one line, so a figure can be checked against the POs behind
 * it. One PO is still named: next to a bare number, "which PO is this" is the
 * question, and repeating the amount is a cheap way to answer it.
 */
export function describeContributions(
  contributions: readonly PoContribution[],
  labelOf: (poId: string) => string,
  formatAmount: (n: number) => string,
): string | null {
  if (contributions.length === 0) return null;
  return contributions
    .map((c) => `${labelOf(c.poId)} ${formatAmount(c.amount)}`)
    .join(" + ");
}

/**
 * What a second PO would destroy, when the per-PO ledger is not there.
 *
 * Migration 0059 adds the ledger. Until it runs, an entry can only name one
 * source PO, so staging a second onto the same line still overwrites. That is
 * the behaviour this whole file exists to end, and the one thing worse than it
 * is doing it silently - so without the ledger the save is refused and this is
 * what it says instead.
 *
 * Null when there is nothing in the way: no existing figure, or the same PO
 * correcting its own.
 */
export function overwriteWarning(input: {
  existingPoId: string | null;
  existingAmount: number;
  incomingPoId: string;
  labelOf: (poId: string) => string;
  formatAmount: (n: number) => string;
}): string | null {
  const existing = Number(input.existingAmount ?? 0);
  if (!input.existingPoId || existing <= 0) return null;
  if (input.existingPoId === input.incomingPoId) return null;
  return (
    `This line already carries ${input.formatAmount(existing)} from ` +
    `${input.labelOf(input.existingPoId)} this period, and the database cannot ` +
    `hold two purchase orders against one line until migration 0059 runs. ` +
    `Saving would replace that figure rather than add to it, so it has been ` +
    `left alone. Run 0059, or bill the two POs in different periods.`
  );
}

/**
 * What saving this figure will actually do to the line.
 *
 * The dialog used to say "a line carries one figure per period, what you save
 * replaces the staged amount rather than adding to it". That was true, and it
 * was the bug: PO-022 landing on a line PO-017 had already staged wiped
 * PO-017's figure. Now a line holds one contribution per PO, so the sentence
 * depends on whether this PO is already on it.
 *
 * Null when the line is empty and there is nothing to say.
 */
export function describeStagingEffect(input: {
  /** Everything on the line for the open period, from every PO. */
  stagedThisPeriod: number;
  /** This PO's share of it. Null when the ledger is not there yet. */
  stagedByThisPo: number | null;
  /** What is about to be typed, so the resulting total can be stated. */
  incomingAmount: number;
  poLabel: string;
  formatAmount: (n: number) => string;
}): string | null {
  const staged = Number(input.stagedThisPeriod ?? 0);
  if (staged <= 0) return null;

  const fmt = input.formatAmount;

  if (input.stagedByThisPo == null) {
    return (
      `${fmt(staged)} is already staged on this line for the period. Until ` +
      `migration 0059 runs a line can hold only one purchase order, so this ` +
      `would replace that figure rather than add to it.`
    );
  }

  const mine = Number(input.stagedByThisPo);
  const others = round2(staged - mine);
  const incoming = Number(input.incomingAmount);
  const total = round2(others + (Number.isFinite(incoming) ? incoming : 0));

  if (mine > 0) {
    return others > 0
      ? `${input.poLabel} already puts ${fmt(mine)} on this line, alongside ` +
          `${fmt(others)} from other purchase orders. Saving replaces ` +
          `${input.poLabel}'s figure only, for a line total of ${fmt(total)}.`
      : `${input.poLabel} already puts ${fmt(mine)} on this line. Saving ` +
          `replaces that figure, not adds to it.`;
  }

  return (
    `${fmt(others)} is already staged on this line from other purchase ` +
    `orders. Saving adds to it, for a line total of ${fmt(total)}.`
  );
}

// ---------------------------------------------------------------------------
// Where this PO stands on the pay application.
//
// Zarina: "I already added this to AFP. should say added and I would not be
// able to add again unless I undo. So once add, there should be an undo
// button."
//
// The panel read "Bill the owner for this PO - opens on $23,982.50, half the
// PO" whether or not the full $47,965 was already staged. Nothing on the page
// distinguished a PO nobody had touched from one already on the application,
// so the only safe move was to open the dialog and read the staged figure out
// of it, and the unsafe move - clicking Add again - looked identical.
// ---------------------------------------------------------------------------

export type PoAfpStanding =
  | { state: "none" }
  | {
      state: "staged";
      amount: number;
      lineLabel: string;
      periodMonth: string;
    }
  | {
      state: "billed";
      amount: number;
      lineLabel: string;
      periodMonth: string;
      afpNumber: string | null;
    };

/** What the panel says instead of the opening-amount sentence. */
export function describePoAfpStanding(
  standing: PoAfpStanding,
  formatAmount: (n: number) => string,
  monthLabel: (periodMonth: string) => string,
): string | null {
  if (standing.state === "none") return null;
  if (standing.state === "staged") {
    return (
      `Added to the ${monthLabel(standing.periodMonth)} application: ` +
      `${formatAmount(standing.amount)} on ${standing.lineLabel}. ` +
      `Undo to change it.`
    );
  }
  return (
    `Billed on ${standing.afpNumber ?? "an application"}: ` +
    `${formatAmount(standing.amount)} on ${standing.lineLabel} for ` +
    `${monthLabel(standing.periodMonth)}. Undo the application itself from ` +
    `the Billing page if this has to change.`
  );
}

/** Whether the Add button should be offered at all. */
export function canAddToAfp(standing: PoAfpStanding): boolean {
  return standing.state === "none";
}

/** Whether Undo should be offered here rather than on the Billing page. */
export function canUndoFromPo(standing: PoAfpStanding): boolean {
  return standing.state === "staged";
}

export type UndoPlan =
  /** Other POs remain on the line. Re-sum and leave the entry alone. */
  | { action: "resum"; remaining: PoContribution[]; plannedAmount: number }
  /** This staging created the entry, and nothing else is on it. */
  | { action: "delete_entry" }
  /** The entry predates the staging. Put back what it carried. */
  | { action: "restore"; plannedAmount: number };

/**
 * What taking this PO off the line has to do to the entry underneath.
 *
 * The last contribution is the one that matters. A billing_entries row may
 * have existed before anybody typed anything - an imported cash-flow forecast
 * that staging wrote over - and deleting it would be a fresh way to lose a
 * figure silently. So a contribution records what it displaced, and undo puts
 * it back. Where the staging created the row, there is nothing to put back and
 * the row goes.
 */
export function planUndo(input: {
  contributions: readonly PoContribution[];
  poId: string;
  createdEntry: boolean;
  priorPlannedAmount: number | null;
}): UndoPlan {
  const remaining = input.contributions.filter((c) => c.poId !== input.poId);
  if (remaining.length > 0) {
    return {
      action: "resum",
      remaining: [...remaining],
      plannedAmount: contributionTotal(remaining),
    };
  }
  if (input.createdEntry) return { action: "delete_entry" };
  return {
    action: "restore",
    plannedAmount: round2(Number(input.priorPlannedAmount ?? 0)),
  };
}

/**
 * A typed figure next to what the evidence independently supports.
 *
 * Zarina, after staging both POs: "2 POs successfully added but still no
 * reflection to the total here." The breakdown line was right and the amount
 * box was not. A forecast row gets enriched with a schedule or milestone
 * recommendation, and the panel prefers the recommendation over the row's own
 * amount - correct for a figure imported from a cash-flow spreadsheet months
 * ago, and wrong for one somebody typed against a purchase order this morning.
 *
 * So a typed row no longer carries a recommendation to be overridden by. What
 * the milestones make of it is still worth saying, because the gap is real
 * information, and it says it instead of acting on it.
 *
 * Null when the two agree closely enough that the sentence would be noise.
 */
export function describeTypedVsEvidence(input: {
  typedAmount: number;
  evidenceAmount: number | null | undefined;
  formatAmount: (n: number) => string;
}): string | null {
  const typed = Number(input.typedAmount);
  const evidence = Number(input.evidenceAmount ?? Number.NaN);
  if (!Number.isFinite(typed) || !Number.isFinite(evidence)) return null;
  if (Math.abs(typed - evidence) < 0.01) return null;
  return (
    `Payment milestones and schedule support ${input.formatAmount(evidence)} ` +
    `this period. Your typed figure stands.`
  );
}
