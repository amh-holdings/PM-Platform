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

// ---------------------------------------------------------------------------
// Line items typed before the PO exists.
//
// Zarina, looking at the Add purchase order form after the editor shipped on
// the detail page: "nothings changed". She asked for line items on the PO
// FORM and showed me the form. Putting them on the detail page followed the
// milestone convention and answered a question she had not asked.
//
// A new PO has no id yet, so the rows cannot be written as they are typed.
// They ride along in a hidden field and are inserted once the order exists.
// ---------------------------------------------------------------------------

export type DraftLine = {
  lineNo: number | null;
  quantity: number | null;
  description: string | null;
  units: string | null;
  unitPrice: number | null;
  extendedPrice: number | null;
};

function maybeNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function maybeText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Read the hidden field the form posts.
 *
 * Anything unreadable is nothing rather than an error: a PO that refuses to
 * save because its line table is malformed loses the vendor, the dates and the
 * contract link too, which is a far worse outcome than a missing line. A line
 * with nothing on it at all is dropped, so an empty row left at the bottom of
 * the table does not become a blank record.
 */
export function parseDraftLines(raw: unknown): DraftLine[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: DraftLine[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const line: DraftLine = {
      lineNo: maybeNumber(r.lineNo),
      quantity: maybeNumber(r.quantity),
      description: maybeText(r.description),
      units: maybeText(r.units),
      unitPrice: maybeNumber(r.unitPrice),
      extendedPrice: maybeNumber(r.extendedPrice),
    };
    const empty =
      line.quantity === null &&
      line.description === null &&
      line.units === null &&
      line.unitPrice === null &&
      line.extendedPrice === null;
    if (empty) continue;
    out.push(line);
  }
  return out;
}

/** The draft lines as the shape poTotals reads. */
export function draftAsLines(lines: readonly DraftLine[]): PoLine[] {
  return lines.map((l) => ({
    line_no: l.lineNo,
    quantity: l.quantity,
    description: l.description,
    units: l.units,
    unit_price: l.unitPrice,
    extended_price: l.extendedPrice,
  }));
}

/**
 * What the PO's value should be when it is saved.
 *
 * A figure typed into Total PO value always wins: somebody meant it, and the
 * lines may be a partial entry of a bigger order. Only a blank total takes the
 * table's total, which is what the form now tells people to do.
 */
export function totalForNewPo(input: {
  typedTotal: number | null;
  lines: readonly DraftLine[];
  salesTax?: number | null;
  freight?: number | null;
}): number | null {
  if (input.typedTotal !== null && input.typedTotal !== undefined) {
    return input.typedTotal;
  }
  if (input.lines.length === 0) return null;
  const { total } = poTotals({
    lines: draftAsLines(input.lines),
    salesTax: input.salesTax,
    freight: input.freight,
  });
  return total;
}

/**
 * Whether the extended price should keep following quantity times unit price.
 *
 * Zarina: "Should automatically total the extended." It was a suggestion you
 * had to click, which is right for the freight line and wrong for every other
 * line on the order, and every other line is most of them.
 *
 * So it fills itself, and stops the moment somebody says otherwise. Two ways
 * of saying otherwise, both read off the line rather than remembered:
 *
 * A figure that is not quantity times unit price was typed by a person. Left
 * alone.
 *
 * A blank extended price on a line that HAS a unit price is the freight case:
 * PO-023 line 6 carries $22,444.50 a unit with the extended column struck
 * through, because the freight is carried below the subtotal. Filling that in
 * would bill it twice. Left alone, and the "use $22,444.50" link comes back so
 * it can be undone.
 *
 * A blank line with no unit price yet has said nothing at all, so it follows.
 */
export function extendedIsAuto(line: PoLine): boolean {
  const derived = derivedExtended(line);
  const current = line.extended_price;
  if (current === null || current === undefined) {
    return line.unit_price === null || line.unit_price === undefined;
  }
  if (derived === null) return false;
  return Math.abs(derived - Number(current)) < 0.005;
}

// ---------------------------------------------------------------------------
// One box where Quantity and Units were two.
//
// Zarina, looking at the line-item form: "Can you remove the quantity to this
// form as well as they are just the same with units."
//
// The paper PO prints them side by side, so the form copied that: a number in
// Quantity and "EA" in Units. Typing 410 and then EA to say one thing is two
// boxes for one fact, and the pair was the widest part of a table that already
// scrolls sideways.
//
// So the form now has one box and it reads the way the line reads out loud:
// "410 EA". The number still has to exist, because the extended price follows
// quantity times unit price and she asked for that to total itself. It is
// parsed off the front of what is typed and stored in quantity exactly as
// before, so every existing line, import, total and forecast is untouched -
// only the number of boxes changed.
// ---------------------------------------------------------------------------

/** The leading number, then whatever is left. Either half may be missing. */
export function parseUnits(raw: string): {
  quantity: number | null;
  units: string | null;
} {
  const text = raw.trim();
  if (text === "") return { quantity: null, units: null };

  // A leading number, with or without thousands commas, with or without a
  // decimal part, and ".5" on its own. Anything else is all units.
  const m = /^(-?(?:\d[\d,]*(?:\.\d+)?|\.\d+))\s*(.*)$/.exec(text);
  if (!m) return { quantity: null, units: text };

  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return { quantity: null, units: text };

  const rest = m[2].trim();
  return { quantity: n, units: rest === "" ? null : rest };
}

/** The same line back as one string, so the box round-trips what it parsed. */
export function unitsText(line: Pick<PoLine, "quantity" | "units">): string {
  const q = line.quantity;
  const parts: string[] = [];
  if (q !== null && q !== undefined && String(q).trim() !== "") {
    const n = Number(q);
    parts.push(Number.isFinite(n) ? String(n) : String(q));
  }
  const u = line.units?.trim();
  if (u) parts.push(u);
  return parts.join(" ");
}
