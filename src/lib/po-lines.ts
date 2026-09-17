// Purchase order line items - parsing and arithmetic.
//
// Pure functions, no database. The form posts the whole line set as one JSON
// field and the server action replaces the stored set with it, so this module
// is the only place that decides what a valid line is and what a PO is worth.
//
// extended_price is a generated column in Postgres (migration 0050). The
// extension computed here is for the form preview and for the total the action
// writes back to procurement_orders.total_value - it is never inserted.

export type PoLineInput = {
  description: string;
  /** Free text off the form. Blank, "12", "1,200" and "$1,200.00" all arrive here. */
  quantity: string;
  unit: string;
  unitPrice: string;
  notes?: string;
};

export type PoLine = {
  lineNo: number;
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  /** quantity * unitPrice, or null when either side is unpriced. */
  extendedPrice: number | null;
  notes: string | null;
};

export type ParsePoLinesResult =
  | { ok: true; lines: PoLine[] }
  | { ok: false; error: string };

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Read a number off a form field. Strips the currency and grouping characters
 * people actually paste out of a vendor quote. Blank is null, not zero -
 * "not entered" and "entered as nothing" are different answers.
 */
export function parseAmount(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Null when either side is unpriced, so an unpriced line never reads as $0. */
export function extendedPrice(
  quantity: number | null,
  unitPrice: number | null,
): number | null {
  if (quantity == null || unitPrice == null) return null;
  return round2(quantity * unitPrice);
}

/** A row the user tabbed through and left alone. Dropped, not rejected. */
function isBlankRow(row: PoLineInput): boolean {
  return (
    !row.description?.trim() &&
    !row.quantity?.trim() &&
    !row.unit?.trim() &&
    !row.unitPrice?.trim()
  );
}

/**
 * Validate and renumber a submitted line set.
 *
 * Blank rows are dropped. A row carrying any figure must carry a description -
 * a nameless $84,000 on a PO is the thing nobody can check later. line_no is
 * assigned from the submitted order rather than trusted from the client, so
 * the unique (procurement_order_id, line_no) constraint cannot be tripped by
 * a reordered form.
 */
export function parsePoLines(rows: PoLineInput[]): ParsePoLinesResult {
  if (!Array.isArray(rows)) return { ok: false, error: "Line items are malformed" };

  const lines: PoLine[] = [];

  for (const row of rows) {
    if (isBlankRow(row)) continue;

    const description = (row.description ?? "").trim();
    const quantity = parseAmount(row.quantity);
    const unitPrice = parseAmount(row.unitPrice);
    const unit = (row.unit ?? "").trim() || null;
    const notes = (row.notes ?? "").trim() || null;
    const position = lines.length + 1;

    if (!description) {
      return { ok: false, error: `Line ${position} needs a description` };
    }
    if (row.quantity?.trim() && quantity == null) {
      return { ok: false, error: `Line ${position}: quantity is not a number` };
    }
    if (row.unitPrice?.trim() && unitPrice == null) {
      return { ok: false, error: `Line ${position}: unit price is not a number` };
    }
    if (quantity != null && quantity < 0) {
      return { ok: false, error: `Line ${position}: quantity cannot be negative` };
    }

    lines.push({
      lineNo: position,
      description,
      quantity,
      unit,
      unitPrice,
      extendedPrice: extendedPrice(quantity, unitPrice),
      notes,
    });
  }

  return { ok: true, lines };
}

/** Sum of the priced lines. Unpriced lines contribute nothing, by design. */
export function poLinesTotal(lines: PoLine[]): number {
  return round2(
    lines.reduce((sum, l) => sum + (l.extendedPrice ?? 0), 0),
  );
}

/** How many lines carry no extension, so the form can say so out loud. */
export function unpricedLineCount(lines: PoLine[]): number {
  return lines.filter((l) => l.extendedPrice == null).length;
}

/** Read the JSON blob the form posts. Absent field means "form sent no lines". */
export function parsePoLinesField(raw: FormDataEntryValue | null): ParsePoLinesResult {
  if (typeof raw !== "string" || !raw.trim()) return { ok: true, lines: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Line items are malformed" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "Line items are malformed" };
  return parsePoLines(parsed as PoLineInput[]);
}
