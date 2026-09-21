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
    // Strip punctuation before matching. A heading is typed by a person:
    // "Item No." carries a full stop, "Item #" a hash, and an alias list that
    // matches neither sends the whole sheet down the positional path.
    const c = cell
      .toLowerCase()
      .replace(/[^a-z0-9% ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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

/**
 * How far down to look for the heading row.
 *
 * An exhibit's title block runs to two or three rows. Ten gives room for a
 * logo row, a project line, a subcontractor line and a blank, and stops well
 * before a sheet with no headings at all could match a line by accident.
 */
const HEADER_SEARCH_ROWS = 10;

/**
 * The single cell of a section heading row - "1.00   GENERAL CONDITIONS" -
 * or null if this row is not one.
 *
 * An exhibit groups its lines under headings, and a heading carries no money.
 * Reported as skipped it reads like four lost lines; recognised, it fills in
 * the section each line belongs to, which the SOV already has a column for.
 *
 * Deliberately narrow, because the cost of being wrong is a real line going
 * quiet instead of being reported: one cell, no money, and either a leading
 * section number or a name in capitals. A row that only looks like a line
 * with its value missing still comes back in `skipped`.
 */
function sectionHeadingRow(cells: string[]): string | null {
  const filled = cells.filter((c) => c.trim().length > 0);
  if (filled.length !== 1) return null;
  const text = filled[0].trim();
  if (text.length < 3 || !/[a-z]/i.test(text)) return null;
  if (parseMoney(text) != null) return null;
  if (isTotalRow(text)) return null;

  const numbered = /^(\d+(?:\.\d+)?)\s{2,}(.+)$/.exec(text);
  const name = numbered ? numbered[2].trim() : text;
  const letters = name.replace(/[^a-z]/gi, "");
  const shouty = letters.length > 0 && letters === letters.toUpperCase();
  if (!numbered && !shouty) return null;
  return name;
}

/**
 * A row from the execution block at the foot of an exhibit - "Signature:
 * ______", "Print Name: ______".
 *
 * These are not lines and reporting four of them as skipped on every import
 * teaches people to ignore the skipped list, which is the one place a real
 * lost line would show up.
 */
function isSignatureBlockRow(cells: string[]): boolean {
  const filled = cells.filter((c) => c.trim().length > 0);
  if (filled.length === 0 || filled.length > 2) return false;
  return filled.every((c) => /^[A-Za-z][A-Za-z ]*:\s*_*$/.test(c.trim()) || /^_+$/.test(c.trim()));
}

/** TOTAL, Subtotal, Grand Total - the row Excel drags along with the range. */
function isTotalRow(description: string): boolean {
  return /^(grand\s+)?(sub)?\s*total\b/i.test(description.trim());
}

/**
 * A cell holding a number, as opposed to text that happens to contain a digit.
 *
 * Stricter than parseMoney on purpose: "Division 2" must not read as a number
 * when the question being asked is what a whole column is made of.
 */
function numericCell(cell: string): number | null {
  const t = cell.trim();
  if (!t || !/\d/.test(t)) return null;
  if (/[^0-9.,()$%\s-]/.test(t)) return null;
  return parseMoney(t);
}

/**
 * The index of a "% of contract" column, or null.
 *
 * A percent-of-total column carries nothing the app needs - every percentage
 * on the sub billing page is computed from the scheduled values - and it is
 * the most common reason an SOV imports one column out of step. A sheet laid
 * out Description / % of contract / Amount, read positionally, files the
 * description under the item number and the percentage under the description,
 * and the result looks plausible enough to save.
 *
 * Identified by what the column sums to rather than by its heading, because
 * the sheets that need this are exactly the ones whose headings did not
 * match. Two guards keep it from eating a money column: the values have to
 * add up to one whole (1.00 as a fraction, or 100 as percents), and some
 * other column has to hold numbers an order of magnitude larger. Dollars on
 * an SOV never satisfy both.
 */
function percentOfTotalColumn(cellRows: string[][]): number | null {
  // Only rows that carry money, and not the total row. A heading row that
  // failed to match would otherwise make every column look non-numeric, and
  // the TOTAL row Excel drags along carries its own 100% - left in, the
  // column sums to two wholes and the test this function applies fails on
  // exactly the sheets that most need it.
  const dataRows = cellRows.filter(
    (r) => r.some((c) => numericCell(c) != null) && !r.some((c) => isTotalRow(c)),
  );
  if (dataRows.length < 2) return null;
  const width = Math.max(...dataRows.map((r) => r.length));
  if (width < 3) return null;

  const sums: (number | null)[] = [];
  for (let c = 0; c < width; c++) {
    const values: number[] = [];
    let ok = true;
    for (const r of dataRows) {
      const raw = (r[c] ?? "").trim();
      if (!raw) continue;
      const n = numericCell(raw);
      if (n == null) {
        ok = false;
        break;
      }
      values.push(n);
    }
    sums.push(ok && values.length >= 2 ? values.reduce((a, b) => a + b, 0) : null);
  }

  for (let c = 0; c < width; c++) {
    const sum = sums[c];
    if (sum == null) continue;
    const values = dataRows
      .map((r) => numericCell((r[c] ?? "").trim()))
      .filter((n): n is number => n != null);
    if (values.length < 2 || values.some((v) => v <= 0)) continue;

    const asFraction = values.every((v) => v <= 1.0000001) && Math.abs(sum - 1) <= 0.02;
    const asPercent = values.every((v) => v <= 100.0001) && Math.abs(sum - 100) <= 2;
    if (!asFraction && !asPercent) continue;

    // Some other column has to be carrying the real money.
    let moneyCol = -1;
    let moneyTotal = 0;
    for (let j = 0; j < width; j++) {
      const other = sums[j];
      if (j === c || other == null) continue;
      if (other > moneyTotal) {
        moneyTotal = other;
        moneyCol = j;
      }
    }
    if (moneyCol < 0 || moneyTotal < sum * 10) continue;

    // And the column has to be each line's share OF that money, line by line.
    // Summing to one whole is not enough on its own: a unit-price SOV can have
    // a quantity column that happens to add to 100. Proportionality is what
    // actually makes a column a percent-of-total, and it is checkable.
    const scale = asFraction ? 1 : 100;
    let proportional = true;
    for (const r of dataRows) {
      const pct = numericCell((r[c] ?? "").trim());
      const money = numericCell((r[moneyCol] ?? "").trim());
      if (pct == null || money == null) {
        proportional = false;
        break;
      }
      if (Math.abs(pct / scale - money / moneyTotal) > 0.005) {
        proportional = false;
        break;
      }
    }
    if (!proportional) continue;
    return c;
  }
  return null;
}

export function parsePastedSovLines(text: string): SovParseResult {
  const rows = text
    .split(/\r?\n/)
    .map((r) => r.replace(/\s+$/, ""))
    .filter((r) => r.trim().length > 0);

  const lines: ParsedSovLine[] = [];
  const skipped: SovParseResult["skipped"] = [];
  if (rows.length === 0) return { lines, skipped, usedHeader: false };

  // Split once. The percent column has to come off before the headings are
  // read, so that a heading row left in step with its data can still match.
  let cellRows = rows.map(splitRow);
  const percentCol = percentOfTotalColumn(cellRows);
  if (percentCol != null) {
    cellRows = cellRows.map((r) => r.filter((_, i) => i !== percentCol));
  }

  // The heading row is not always the first row. A real exhibit opens with its
  // own title and the project and subcontractor names before the columns
  // start, and reading only row 0 means the headings are missed and the whole
  // sheet is read by position instead - which is how a description ends up
  // filed as an item number.
  let headerRow = -1;
  let headerMap: Record<string, number> | null = null;
  const searchDepth = Math.min(cellRows.length, HEADER_SEARCH_ROWS);
  for (let i = 0; i < searchDepth; i++) {
    const m = matchHeader(cellRows[i]);
    if (m) {
      headerRow = i;
      headerMap = m;
      break;
    }
  }
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
  const widest = Math.max(...cellRows.map((r) => r.length));
  const twoColumn = !usedHeader && widest <= 2;
  const map = headerMap ?? (twoColumn ? { description: 0, scheduledValue: 1 } : positional);

  // Everything above the heading row is the exhibit's title block, not lines.
  const firstDataRow = usedHeader ? headerRow + 1 : 0;
  const dataCells = cellRows.slice(firstDataRow);
  // Reported verbatim, so a skipped row is findable in the box it came from
  // even though the cells it was read from may have had a column taken off.
  const dataText = rows.slice(firstDataRow);
  const seen = new Set<string>();
  let section: string | null = null;
  let sawTotal = false;

  dataCells.forEach((cells, i) => {
    const rowNumber = firstDataRow + i + 1;
    const row = dataText[i];
    const at = (field: string): string => {
      const idx = map[field];
      return idx == null ? "" : (cells[idx] ?? "");
    };

    if (isSignatureBlockRow(cells)) return;

    const heading = sectionHeadingRow(cells);
    if (heading) {
      section = heading;
      return;
    }

    // Below the grand total an exhibit prints its arithmetic - "Less:
    // Retainage (10%)", "Net Payable This Application". They carry no money
    // and are not lines, and reporting them every time teaches people to
    // ignore the skipped list. A row that has money somewhere is still read.
    if (sawTotal && !cells.some((c) => /\d/.test(c) && parseMoney(c) != null)) return;

    const description = at("description").trim();
    if (!description) {
      skipped.push({ row: rowNumber, text: row, reason: "No description" });
      return;
    }

    const itemNumber = at("itemNumber").trim() || null;
    // "TOTAL" in the item column is a total row wherever the money ended up.
    // Worth catching separately: when the label sits in the item column the
    // value often lands in the description column, and without this the row
    // is rejected for having no readable value - true, but it sends whoever
    // is reviewing the import looking for a problem that is not there.
    if (itemNumber && isTotalRow(itemNumber)) {
      sawTotal = true;
      skipped.push({ row: rowNumber, text: row, reason: "Looks like a total row" });
      return;
    }
    if (isTotalRow(description) && !itemNumber) {
      sawTotal = true;
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
      sectionName: at("sectionName").trim() || section,
    });
  });

  return { lines, skipped, usedHeader };
}
