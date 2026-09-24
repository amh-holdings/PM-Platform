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
