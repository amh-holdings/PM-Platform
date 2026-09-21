/**
 * Turns a subcontract SOV that arrived as a PDF into the same tab-separated
 * rows a paste produces.
 *
 * An executed SOV is an exhibit to the subcontract, and a subcontractor who
 * signs a PDF sends a PDF. Retyping thirty rows is how a scheduled value ends
 * up one digit off, so the PDF has to be readable - but it must not become a
 * second importer. Everything here stops at rows of strings. Those rows go
 * into the same review box a paste lands in and through the same parser, so
 * header detection, total-row rejection, the skipped-row report and item
 * numbering all keep behaving exactly as they do for a paste.
 *
 * What makes a PDF harder than a spreadsheet is that it has no cells. A PDF
 * stores glyphs at coordinates and the columns are a visual accident of where
 * the text sits, so they have to be inferred from geometry: same baseline
 * means same row, a horizontal gap wider than a few spaces means a new cell.
 *
 * Doing that from the extracted *string* does not work, which is worth
 * recording because it looks like it should. pdf.js pads the gap between two
 * columns with a synthetic space item whose width spans the whole gap, so by
 * the time the text is a string every column boundary has already been
 * flattened to a single space and is indistinguishable from the space between
 * two words. The geometry has to be read before that happens.
 */

import type { SheetSummary } from "@/lib/schedule-workbook";
import { parseMoney } from "@/lib/paste-table";

/** A positioned run of text, as pdf.js reports it. */
export type PdfTextItem = {
  str: string;
  /** Left edge, PDF points, origin bottom-left. */
  x: number;
  /** Baseline. */
  y: number;
  /** Advance width of this run. */
  width: number;
  /** Roughly the font size. */
  height: number;
};

export type PdfPageItems = { num: number; items: PdfTextItem[] };

/**
 * Two runs are on the same row when their baselines are within this many
 * points. Superscripts and slightly-off cells need the slack; a 10pt sheet
 * with single spacing puts consecutive rows about 12pt apart, so this is
 * nowhere near merging two rows.
 */
const ROW_TOLERANCE = 2.5;

/**
 * A gap this wide, relative to the font size, starts a new cell.
 *
 * A space in a 10pt serif or sans face is about 2.8pt, and two words never sit
 * further apart than one space unless the text is justified. 0.9 of the font
 * size is three spaces or so: wide enough that justified prose stays in one
 * cell, narrow enough that a real column gap always splits.
 */
const CELL_GAP_RATIO = 0.9;
const MIN_CELL_GAP = 5;

function isBlank(cells: string[]): boolean {
  return cells.every((c) => c.trim().length === 0);
}

function hasMoney(cells: string[]): boolean {
  return cells.some((c) => /\d/.test(c) && parseMoney(c) != null);
}

/**
 * A line that is only the page number, or only "Page 2 of 4". Left in, it
 * becomes a skipped row the reviewer has to read past on every import.
 */
function isPageFurniture(cells: string[]): boolean {
  const joined = cells.join(" ").trim();
  if (!joined) return true;
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(joined)) return true;
  if (cells.length === 1 && /^\d{1,3}$/.test(joined)) return true;
  return false;
}

/**
 * A wrapped description: one cell of text, no money on it, sitting under a row
 * that did have money.
 *
 * Merging it back is the one liberty this module takes with the source, and it
 * is taken deliberately. A description silently cut at "Tracker assembly,
 * torque tube and" reads like a complete line and nobody catches it, whereas a
 * merge that guesses wrong is visible in the review box before anything is
 * saved. The conditions are narrow on purpose: a section heading almost always
 * carries its own item number, or a digit, or sits above its lines rather than
 * below one.
 */
function isContinuation(cells: string[], previous: string[] | undefined): boolean {
  if (!previous || !hasMoney(previous)) return false;
  const filled = cells.filter((c) => c.trim().length > 0);
  if (filled.length !== 1) return false;
  if (/\d/.test(filled[0])) return false;
  return true;
}

/** The cell a continuation belongs on: the longest one that is not money. */
function descriptionIndex(row: string[]): number {
  let best = -1;
  for (let i = 0; i < row.length; i++) {
    if (parseMoney(row[i]) != null) continue;
    if (best < 0 || row[i].length > row[best].length) best = i;
  }
  return best;
}

/** Groups one page's positioned runs into rows of cells. */
export function itemsToRows(items: PdfTextItem[]): string[][] {
  const real = items.filter((it) => it.str.trim().length > 0);
  if (real.length === 0) return [];

  // Top-down, then left-to-right. PDF y grows upward.
  const sorted = real.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const bands: PdfTextItem[][] = [];
  let band: PdfTextItem[] = [];
  let bandY = sorted[0].y;
  for (const it of sorted) {
    if (band.length > 0 && Math.abs(it.y - bandY) > ROW_TOLERANCE) {
      bands.push(band);
      band = [];
    }
    if (band.length === 0) bandY = it.y;
    band.push(it);
  }
  if (band.length > 0) bands.push(band);

  const rows: string[][] = [];
  for (const b of bands) {
    const line = b.slice().sort((a, c) => a.x - c.x);
    const cells: string[] = [];
    let current = "";
    let cursor: number | null = null;
    for (const it of line) {
      const fontSize = it.height > 0 ? it.height : 10;
      const threshold = Math.max(MIN_CELL_GAP, fontSize * CELL_GAP_RATIO);
      if (cursor !== null && it.x - cursor > threshold) {
        cells.push(current.trim());
        current = "";
      }
      current += (current && !current.endsWith(" ") ? " " : "") + it.str.trim();
      cursor = it.x + it.width;
    }
    if (current.trim()) cells.push(current.trim());

    const cleaned = cells.map((c) => c.replace(/\s+/g, " ").trim());
    if (isBlank(cleaned) || isPageFurniture(cleaned)) continue;

    const previous = rows[rows.length - 1];
    if (isContinuation(cleaned, previous)) {
      const target = descriptionIndex(previous);
      if (target >= 0) {
        previous[target] = `${previous[target]} ${cleaned.find((c) => c)!}`.trim();
        continue;
      }
    }
    rows.push(cleaned);
  }
  return rows;
}

/** Each page becomes a sheet, so the existing sheet picker works unchanged. */
export function pdfPagesToSheets(pages: PdfPageItems[]): SheetSummary[] {
  return pages.map((p) => {
    const rows = itemsToRows(p.items);
    return {
      name: `Page ${p.num}`,
      rows,
      filledRows: rows.filter((r) => !isBlank(r)).length,
    };
  });
}

/**
 * How many rows on a page look like SOV lines: a value and some words.
 *
 * The page to land the reviewer on is the one with the most of these, not the
 * one with the most text - a subcontract's first page is dense prose and the
 * SOV exhibit is three pages later.
 */
export function sovRowCount(sheet: SheetSummary): number {
  return sheet.rows.filter((r) => hasMoney(r) && r.some((c) => /[a-z]{3}/i.test(c))).length;
}

/** The page the reviewer should see first. */
export function bestPageIndex(sheets: SheetSummary[]): number {
  let best = 0;
  let bestScore = -1;
  sheets.forEach((s, i) => {
    // An SOV page beats a wordy page; among pages with no SOV rows at all,
    // the fullest wins so an unusual layout still lands somewhere useful.
    const score = sovRowCount(s) * 1000 + s.filledRows;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
