/**
 * A sheet, as the tab-separated text a paste produces.
 *
 * Deliberately converts to the SAME string a paste produces rather than adding
 * a second import path. Every rule the server already applies - header
 * detection, column order, updating an item number in place, ignoring total
 * rows, the skipped-row report - keeps applying, and there is no second parser
 * to drift out of step with the first.
 *
 * Which makes the separators load-bearing, and that is the whole reason this
 * lives in a file of its own with tests. A spreadsheet cell can contain a tab
 * and it can contain a line break; a row of tab-separated text cannot contain
 * either. An executed SOV routinely puts the section title and the scope
 * paragraph in one cell with a break between them:
 *
 *     Item No. | Description of Work                      | Scheduled Value
 *     1        | General Conditions                       | $78,179.80
 *              | Payment and performance bonds, site ...  |
 *
 * Left alone, that one cell becomes two rows. The first carries the item
 * number and no money, the second carries the money and no item number, and
 * the whole sheet reads one column out of step from there down - which is
 * exactly what happened, and it imported looking plausible.
 */

import type { SheetSummary } from "@/lib/schedule-workbook";

/**
 * Anything that would be read as a cell or row boundary becomes a space.
 *
 * `\s` already covers the tab, the carriage return, the newline and the two
 * Unicode line separators, so one collapse does the whole job.
 */
export function flattenCell(cell: string): string {
  return String(cell ?? "").replace(/\s+/g, " ").trim();
}

export function sheetToTsv(sheet: SheetSummary): string {
  return sheet.rows
    .filter((r) => r.some((c) => c.trim().length > 0))
    .map((r) => r.map(flattenCell).join("\t"))
    .join("\n");
}
