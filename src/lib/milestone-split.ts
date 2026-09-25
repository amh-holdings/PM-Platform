/**
 * The two ways of saying the same thing on a payment milestone.
 *
 * Zarina, typing 50 into % on a $47,965 PO and watching Amount stay at the
 * full value: "if I write here the % amount it should calculate
 * automatically."
 *
 * A PO's payment terms are written either way. "40% deposit" on one document
 * and "$23,982.50 on release" on the next, for the same money. The form asked
 * for both and derived neither, so the % and the Amount could disagree and
 * the Amount is the one that reaches the cash flow. A row reading 50% next to
 * the full PO value is a milestone that will pay twice what it should.
 *
 * So the box being typed in drives the other one, in both directions. No
 * remembered auto/manual state: whichever number somebody just put in is the
 * one they meant, and the other follows from it. Typing 50 gives
 * $23,982.50; correcting that to $24,000 gives 50.04%, which is the truth
 * rather than a tidier lie.
 *
 * Nothing is derived when the PO value is not set, because dividing by it or
 * multiplying by it would both produce zero and zero is a real amount.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function usable(poValue: number): boolean {
  return Number.isFinite(poValue) && poValue > 0;
}

/** What a percentage of the PO comes to. Null when it cannot be worked out. */
export function amountFromPct(
  poValue: number,
  pct: number | null | undefined,
): number | null {
  if (!usable(poValue)) return null;
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  return round2((poValue * pct) / 100);
}

/** What share of the PO an amount is. Null when it cannot be worked out. */
export function pctFromAmount(
  poValue: number,
  amount: number | null | undefined,
): number | null {
  if (!usable(poValue)) return null;
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return null;
  }
  return round2((amount / poValue) * 100);
}

/**
 * Whether the two figures on a row actually agree.
 *
 * A cent of rounding is not a disagreement: 33.33% of $47,965 is $15,986.83
 * and back again is 33.329...%, which is the same intent. A row that is out
 * by more than that was typed by two different people or two different
 * documents, and the Amount is what gets paid.
 */
export function splitAgrees(
  poValue: number,
  pct: number | null | undefined,
  amount: number | null | undefined,
): boolean {
  const derived = amountFromPct(poValue, pct);
  if (derived === null || amount === null || amount === undefined) return true;
  return Math.abs(derived - amount) < 0.011;
}
