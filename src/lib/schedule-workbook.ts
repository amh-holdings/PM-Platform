// Reading a schedule out of an Excel workbook.
//
// This module has one job: turn a .xlsx/.xls/.csv file into the same
// rectangular block of strings that a clipboard paste produces, so that
// everything downstream - header detection, column mapping, WBS derivation,
// the diff - is the code that was already there. An Excel import that took its
// own path through the parser would be a second set of rules to keep true.
//
// Three things a spreadsheet carries that a paste does not, and what happens to
// each:
//
//   Dates. Excel stores a date as a serial number and a format. Read as text
//   it comes out in whatever the author's locale did that day; read as a JS
//   Date and stringified through UTC it lands a day early for anyone east of
//   Greenwich. Both of those quietly shift a schedule. So date cells are pulled
//   apart with the local calendar getters, which is exactly how SheetJS built
//   them, and written back as ISO.
//
//   Indentation. A schedule exported from MS Project or Smartsheet indents the
//   task-name column with cell formatting rather than spaces, and that
//   indentation is the WBS hierarchy when the sheet has no WBS column. It is
//   re-emitted as leading spaces, which is the form buildImportRows already
//   reads.
//
//   Formulas. A cell's cached value is used, never its formula text, and an
//   error cell (#REF!, #N/A) is read as empty rather than as the literal
//   "#REF!" - a broken formula is a missing value, not a task named #REF!.
//
// xlsx is imported here and nowhere else on the client. Load this module with
// a dynamic import so the parser stays out of the schedule page's bundle until
// somebody actually picks a file.

import * as XLSX from "xlsx";

import { gridFromMatrix, type ParsedGrid } from "@/lib/schedule-edit";

export type SheetSummary = {
  name: string;
  rows: string[][];
  // Rows with at least one filled cell, before the header is taken off. Used
  // to pick the sheet to land on and to grey out the empty ones.
  filledRows: number;
};

export const WORKBOOK_EXTENSIONS = [".xlsx", ".xlsm", ".xls", ".csv", ".tsv", ".txt"];

export function isWorkbookFile(name: string): boolean {
  const lower = name.toLowerCase();
  return WORKBOOK_EXTENSIONS.some((e) => lower.endsWith(e));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// SheetJS builds a date-serial cell as local midnight. Reading it back with the
// local getters is therefore lossless and timezone-independent; toISOString is
// neither.
function isoFromDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Excel's day zero, and the top of its range (31 Dec 9999).
const SERIAL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MAX_SERIAL = 2958465;

// A number format that puts a date on screen. Quoted literals and escapes are
// stripped first, so a duration formatted as 0" d" is not read as a date and a
// currency format carrying a "m" in its literal is not either.
function looksLikeDateFormat(z: unknown): boolean {
  if (typeof z !== "string") return false;
  const bare = z
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
  return /[ymd]/i.test(bare);
}

// Serial to ISO, done in UTC arithmetic so it cannot drift with the clock of
// the machine doing the import. Serials at or below 60 sit inside Excel's
// fictional 29 Feb 1900 and are not dates worth guessing at.
function isoFromSerial(n: number): string | null {
  if (!Number.isFinite(n) || n <= 60 || n > MAX_SERIAL) return null;
  const d = new Date(SERIAL_EPOCH_UTC + Math.floor(n) * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

type Cell = {
  t?: string;
  v?: unknown;
  w?: string;
  z?: unknown;
  s?: { alignment?: { indent?: number } };
};

function cellText(cell: Cell | undefined): string {
  if (!cell || cell.v === null || cell.v === undefined) return "";

  // #REF!, #N/A, #VALUE! - a formula that did not resolve is an empty cell.
  if (cell.t === "e") return "";

  if (cell.t === "d" && cell.v instanceof Date) return isoFromDate(cell.v);

  if (cell.t === "b") return cell.v ? "true" : "false";

  if (cell.t === "n") {
    const n = cell.v as number;
    // cellDates converts nearly every date cell for us. This is the tail: a
    // date-formatted number that stayed numeric, which reaches the importer as
    // "46266" and is rejected as an unreadable date unless it is decoded here.
    if (looksLikeDateFormat(cell.z)) {
      const iso = isoFromSerial(n);
      if (iso) return iso;
    }
    // Otherwise the raw number, not the formatted text: a duration formatted as
    // "1,250" or "35 d" is a number we can read, and its display string is not.
    return Number.isFinite(n) ? String(n) : "";
  }

  const text = String(cell.v);
  // A date that survived as text (common in exports that were pasted between
  // tools before being saved) is left exactly as written - parseLooseDate in
  // the import path already handles every shape it arrives in.
  return text;
}

// Rebuild formatted indentation as leading spaces. indentOf in schedule-edit
// counts two spaces per level, so one indent step becomes two spaces.
function withIndent(text: string, cell: Cell | undefined): string {
  const indent = cell?.s?.alignment?.indent;
  if (!indent || !Number.isFinite(indent) || indent <= 0) return text;
  if (/^\s/.test(text)) return text; // already carries its own indentation
  return " ".repeat(Math.min(indent, 12) * 2) + text;
}

export function sheetMatrix(sheet: XLSX.WorkSheet): string[][] {
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const out: string[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })] as Cell | undefined;
      row.push(withIndent(cellText(cell), cell));
    }
    out.push(row);
  }
  return out;
}

export function readWorkbook(data: ArrayBuffer): SheetSummary[] {
  const wb = XLSX.read(data, {
    type: "array",
    cellDates: true, // serials become local-midnight Dates, not raw numbers
    cellStyles: true, // carries alignment.indent, which is the WBS hierarchy
    cellFormula: false, // the cached value is what we want, never the formula
  });
  return wb.SheetNames.map((name) => {
    const rows = sheetMatrix(wb.Sheets[name]);
    return {
      name,
      rows,
      filledRows: rows.filter((r) => r.some((c) => c.trim().length > 0)).length,
    };
  });
}

export function gridFromSheet(sheet: SheetSummary): ParsedGrid {
  return gridFromMatrix(sheet.rows, "cells");
}

// The sheet to land on: the first one with real content. A workbook whose first
// tab is a cover page or a legend should not open on an empty mapper.
export function defaultSheetIndex(sheets: SheetSummary[]): number {
  const named = sheets.findIndex(
    (s) => s.filledRows > 1 && /schedule|task|activit|wbs|plan/i.test(s.name),
  );
  if (named !== -1) return named;
  const first = sheets.findIndex((s) => s.filledRows > 1);
  return first === -1 ? 0 : first;
}
