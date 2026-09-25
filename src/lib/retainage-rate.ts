/**
 * The retainage rate on a subcontract.
 *
 * Zarina: "Can you add option to add retainage to subs SOVs."
 *
 * The rate already existed on the subcontractor record and everything already
 * reads it - the next-bill projection prices against it, every pay application
 * captures it at creation, and the cash flow withholds it from what goes out.
 * The one thing missing was a way to set it from the page where the SOV is
 * actually worked. It was reachable only from the Add subcontractor dialog on
 * the Subs page, which nobody reopens once a sub exists, so a subcontract that
 * was entered before its retainage was known sat at whatever it was given and
 * quietly priced every projection at that rate.
 *
 * The column default is 0, not 10, so a sub entered without one retains
 * nothing and the cash flow shows nothing held. That is the zero.
 */

export type RetainageRate = number | null | "invalid";

/**
 * Read a typed rate.
 *
 * Blank is null rather than zero: clearing the box means "not stated", and
 * writing a hard 0 over a subcontract that retains 10% because somebody
 * tabbed through the field would be a silent six-figure error on a big sub.
 * The caller decides what null does.
 */
export function parseRetainageRate(raw: string | null | undefined): RetainageRate {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  const cleaned = text.replace(/[%\s,]/g, "");
  // Digits with at most one decimal point, and nothing else. Number() is too
  // forgiving on its own: it reads "" as 0, so a lone percent sign came back
  // as a real rate of zero and silently stopped a subcontract retaining.
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(cleaned)) return "invalid";
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return "invalid";
  // A rate outside 0-100 is a typo, not a contract. 105 is usually 10.5 with a
  // missed decimal, and a negative rate would pay the sub more than they
  // billed.
  if (n < 0 || n > 100) return "invalid";
  return Math.round(n * 100) / 100;
}

/** What this rate holds back on a given amount. */
export function retainageOn(amount: number, pct: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(pct)) return 0;
  return Math.round(amount * (pct / 100) * 100) / 100;
}

/**
 * One line for the screen, so the consequence of the rate is next to the box.
 *
 * A percentage on its own does not tell anybody what it costs. Against the
 * SOV total it does, and that is the number that shows up as cash we are
 * holding rather than cash going out.
 */
export function describeRetainageRate(
  pct: number,
  sovTotal: number,
  formatAmount: (n: number) => string,
): string {
  if (pct <= 0) {
    return "Nothing is held back. Every approved dollar goes out in full.";
  }
  if (sovTotal <= 0) {
    return `${pct}% of each approved bill is held back.`;
  }
  const held = retainageOn(sovTotal, pct);
  return `${pct}% held back, ${formatAmount(held)} across the full ${formatAmount(sovTotal)} SOV.`;
}
