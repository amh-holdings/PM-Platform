/**
 * Reads a subcontract schedule of values pasted out of a spreadsheet.
 *
 * An executed SOV is an exhibit to the subcontract - it arrives as a PDF or an
 * Excel range, never as something anyone wants to retype thirty rows at a time.
 * This turns a pasted block into line records the SOV editor can save.
 *
 * Two rules matter more than the parsing:
 *
 *   Nothing is dropped silently. A row that cannot be read comes back in
 *   `skipped` with the reason, because a line quietly lost from an SOV is a
 *   line the sub can bill against with no scheduled value to check it.
 *
 *   Total rows are not lines. Pasting a range out of Excel almost always
 *   drags the TOTAL row along with it, and importing it would double the
 *   contract value.
 */

import { parseMoney, splitRow } from "@/lib/paste-table";

export type ParsedSovLine = {
  /** Null when the paste had no item column; the caller assigns a number. */
  itemNumber: string | null;
  description: string;
  scheduledValue: number;
  quantity: number | null;
  unit: string | null;
  unitCost: number | null;
  sectionName: string | null;
};

export type SovParseResult = {
  lines: ParsedSovLine[];
  skipped: { row: number; text: string; reason: string }[];
  usedHeader: boolean;
};

const HEADER_ALIASES: Record<string, string[]> = {
  itemNumber: ["item", "item no", "item number", "item #", "no", "num", "line", "line no", "ref"],
  description: ["description", "desc", "scope", "work", "item description", "description of work"],
  scheduledValue: [
    "scheduled value",
    "scheduled value of work",
    "value",
    "amount",
    "contract value",
    "total",
    "total value",
    "sov",
    "price",
  ],
  quantity: ["qty", "quantity", "qnty"],
  unit: ["unit", "uom", "units"],
  unitCost: ["unit cost", "unitcost", "unit price", "rate", "each"],
  sectionName: ["section", "section name", "phase", "division", "category"],
};

function matchHeader(cells: string[]): Record<string, number> | null {
  const map: Record<string, number> = {};
  cells.forEach((cell, i) => {
    const c = cell.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!c) return;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] != null) continue;
      if (aliases.includes(c)) map[field] = i;
    }
  });
  // A description column plus a money column is enough to trust the row as a
  // header. Anything less and it is probably just the first data row.
  return map.description != null && map.scheduledValue != null ? map : null;
}

/** TOTAL, Subtotal, Grand Total - the row Excel drags along with the range. */
function isTotalRow(description: string): boolean {
  return /^(grand\s+)?(sub)?\s*total\b/i.test(description.trim());
}

export function parsePastedSovLines(text: string): SovParseResult {
  const rows = text
    .split(/\r?\n/)
    .map((r) => r.replace(/\s+$/, ""))
    .filter((r) => r.trim().length > 0);

  const lines: ParsedSovLine[] = [];
  const skipped: SovParseResult["skipped"] = [];
  if (rows.length === 0) return { lines, skipped, usedHeader: false };

  const headerMap = matchHeader(splitRow(rows[0]));
  const usedHeader = headerMap != null;
  // Positional fallback, matching the order shown in the paste box.
  const positional: Record<string, number> = {
    itemNumber: 0,
    description: 1,
    scheduledValue: 2,
    quantity: 3,
    unit: 4,
    unitCost: 5,
  };
  // A two-column paste is description + value, not item + description. Reading
  // it positionally would file the whole scope under an item number and leave
  // every line with no description.
  const widest = Math.max(...rows.map((r) => splitRow(r).length));
  const twoColumn = !usedHeader && widest <= 2;
  const map = headerMap ?? (twoColumn ? { description: 0, scheduledValue: 1 } : positional);

  const dataRows = usedHeader ? rows.slice(1) : rows;
  const seen = new Set<string>();

  dataRows.forEach((row, i) => {
    const rowNumber = usedHeader ? i + 2 : i + 1;
    const cells = splitRow(row);
    const at = (field: string): string => {
      const idx = map[field];
      return idx == null ? "" : (cells[idx] ?? "");
    };

    const description = at("description").trim();
    if (!description) {
      skipped.push({ row: rowNumber, text: row, reason: "No description" });
      return;
    }

    const itemNumber = at("itemNumber").trim() || null;
    if (isTotalRow(description) && !itemNumber) {
      skipped.push({ row: rowNumber, text: row, reason: "Looks like a total row" });
      return;
    }

    const quantity = parseMoney(at("quantity"));
    const unitCost = parseMoney(at("unitCost"));
    let scheduledValue = parseMoney(at("scheduledValue"));
    if (scheduledValue == null) {
      // A unit-price SOV sometimes prints qty and rate but leaves the extended
      // column to a formula that does not survive the copy.
      if (quantity != null && unitCost != null) scheduledValue = quantity * unitCost;
      else {
        skipped.push({ row: rowNumber, text: row, reason: "No readable scheduled value" });
        return;
      }
    }

    if (itemNumber) {
      const key = itemNumber.toLowerCase();
      if (seen.has(key)) {
        skipped.push({ row: rowNumber, text: row, reason: `Duplicate item number ${itemNumber}` });
        return;
      }
      seen.add(key);
    }

    lines.push({
      itemNumber,
      description,
      scheduledValue: Math.round(scheduledValue * 100) / 100,
      quantity,
      unit: at("unit").trim() || null,
      unitCost,
      sectionName: at("sectionName").trim() || null,
    });
  });

  return { lines, skipped, usedHeader };
}
