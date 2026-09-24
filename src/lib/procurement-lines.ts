/**
 * Line items on a purchase order, and the total they build to.
 *
 * Zarina: "I need to have option to add line items for PO forms. See PO form
 * we used."
 *
 * The paper PO carries a table - line, quantity, description, units, unit
 * price, extended price - and then Subtotal, Sales Tax, Freight, Total. The
 * app held one total_value and a free-text description, so the detail that
 * makes a PO checkable against an invoice lived only in the PDF.
 *
 * Worked from PO-023, Elevated Steel:
 *
 *   71  x   938.29  =  66,618.59
 *   410 x   347.00  = 142,270.00
 *   1   x   347.00  =     347.00
 *   10  x   624.39  =   6,243.90
 *   HDG included in pricing, no price
 *   Freight, 22,444.50 a unit, NO extended price
 *                        Subtotal 215,479.49
 *                       Sales tax         -
 *                         Freight  22,444.50
 *                           Total 237,923.99
 */

export type PoLine = {
  line_no?: number | null;
  quantity?: number | null;
  description?: string | null;
  units?: string | null;
  unit_price?: number | null;
  /** Null means this line carries no extended price. Not the same as zero. */
  extended_price?: number | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * What quantity times unit price comes to, or null when either is missing.
 *
 * Offered to the extended-price box as it is typed. Never forced: the source
 * document does not always derive it. PO-023 line 6 is freight at $22,444.50 a
 * unit with the extended column struck through, because the freight is carried
 * below the subtotal instead. Deriving that line would bill it twice.
 */
export function derivedExtended(line: PoLine): number | null {
  const q = num(line.quantity);
  const u = num(line.unit_price);
  if (q === null || u === null) return null;
  return round2(q * u);
}

/** What this line contributes to the subtotal. */
export function lineExtended(line: PoLine): number {
  const explicit = num(line.extended_price);
  return explicit === null ? 0 : round2(explicit);
}

export type PoTotals = {
  subtotal: number;
  salesTax: number;
  freight: number;
  total: number;
  /** Lines that carry a price but contribute nothing, so the gap is explainable. */
  pricedButNotExtended: number;
};

/**
 * Subtotal, then the two additions, then the total. The paper form's order.
 *
 * Only extended prices reach the subtotal. A line with a unit price and no
 * extended price is counted separately rather than ignored, because on the
 * real document that is always deliberate and always worth being able to point
 * at when the subtotal does not look like the sum of the unit prices.
 */
export function poTotals(input: {
  lines: readonly PoLine[];
  salesTax?: number | null;
  freight?: number | null;
}): PoTotals {
  let subtotal = 0;
  let pricedButNotExtended = 0;
  for (const line of input.lines) {
    const extended = num(line.extended_price);
    if (extended === null) {
      if (num(line.unit_price) !== null) pricedButNotExtended += 1;
      continue;
    }
    subtotal += extended;
  }
  const salesTax = round2(num(input.salesTax) ?? 0);
  const freight = round2(num(input.freight) ?? 0);
  subtotal = round2(subtotal);
  return {
    subtotal,
    salesTax,
    freight,
    total: round2(subtotal + salesTax + freight),
    pricedButNotExtended,
  };
}

/** The next line number, following what is already there. */
export function nextLineNo(lines: readonly PoLine[]): number {
  let highest = 0;
  for (const l of lines) {
    const n = num(l.line_no);
    if (n !== null && n > highest) highest = Math.floor(n);
  }
  return highest + 1;
}

export type TotalAgreement =
  | { state: "no_lines" }
  /** The PO value has not been set, so the lines can simply become it. */
  | { state: "adopt"; total: number }
  | { state: "agrees"; total: number }
  | { state: "disagrees"; total: number; poValue: number; difference: number };

/**
 * Whether the lines and the PO's stored value say the same thing.
 *
 * The lines are not allowed to quietly overwrite a figure somebody typed. A PO
 * value drives milestones, the procurement forecast and what the owner is
 * billed, and replacing it from a half-entered line table would move money
 * with nothing on screen. So an empty value is adopted, a matching one is left
 * alone, and a disagreement is reported for a person to settle.
 */
export function totalAgreement(input: {
  lines: readonly PoLine[];
  salesTax?: number | null;
  freight?: number | null;
  poValue?: number | null;
}): TotalAgreement {
  if (input.lines.length === 0) return { state: "no_lines" };
  const { total } = poTotals(input);
  const poValue = num(input.poValue) ?? 0;
  if (poValue <= 0) return { state: "adopt", total };
  const difference = round2(total - poValue);
  if (Math.abs(difference) < 0.01) return { state: "agrees", total };
  return { state: "disagrees", total, poValue, difference };
}

/** One line for the screen, or null when there is nothing to say. */
export function describeTotalAgreement(
  agreement: TotalAgreement,
  formatAmount: (n: number) => string,
): string | null {
  if (agreement.state === "no_lines" || agreement.state === "agrees") return null;
  if (agreement.state === "adopt") {
    return `The line items come to ${formatAmount(agreement.total)}. The PO value is not set, so saving will use this.`;
  }
  const over = agreement.difference > 0;
  return (
    `The line items come to ${formatAmount(agreement.total)}, against a PO ` +
    `value of ${formatAmount(agreement.poValue)}. That is ` +
    `${formatAmount(Math.abs(agreement.difference))} ${over ? "more" : "less"}. ` +
    `Nothing is changed until you apply it.`
  );
}
