// Owner SOV (schedule of values) import.
//
// The billing tab's lines used to arrive one way only: run
// scripts/import-cashflow.mjs against db/reference/cash-flow.xlsx from a
// laptop. This module is the same job done in the browser - map the columns of
// a paste or a workbook onto billing_lines, then show the diff before anything
// is written.
//
// Deliberately NOT symmetrical with the schedule importer in one respect: there
// is no delete side. A schedule branch can reasonably be restated wholesale;
// an SOV line cannot, because billed money and pay-application snapshots hang
// off it. Removing a line is a per-line decision with its own guard - see
// deleteBillingLine.

import { parseMoney as parseMoneyStrict, splitRow } from "@/lib/paste-table";
import { gridFromMatrix, type HeaderRule, type ParsedGrid } from "@/lib/schedule-edit";

export type SovColumnKey =
  | "item_number"
  | "type"
  | "description"
  | "scheduled_value"
  | "sort_order"
  | "notes";

export const SOV_COLUMN_KEYS: SovColumnKey[] = [
  "item_number",
  "type",
  "description",
  "scheduled_value",
  "sort_order",
  "notes",
];

export const SOV_COLUMN_LABELS: Record<SovColumnKey, string> = {
  item_number: "Item number",
  type: "Type",
  description: "Description",
  scheduled_value: "Scheduled value",
  sort_order: "Sort order",
  notes: "Notes",
};

// Matched against a normalized header. Exact matches are tried across every
// column before any partial match, so a sheet carrying both "Schedule of
// Value" and "Value Billed" does not hand the scheduled value to the wrong one.
const SOV_COLUMN_ALIASES: Record<SovColumnKey, string[]> = {
  item_number: [
    "item number",
    "item no",
    "item #",
    "item",
    "line item",
    "line no",
    "line",
    "sov item",
    "ref",
    "#",
  ],
  type: ["type", "category", "cost type", "class", "division", "phase"],
  description: [
    "description of work",
    "description",
    "scope of work",
    "scope",
    "work",
    "item description",
    "narrative",
  ],
  scheduled_value: [
    "schedule of value",
    "schedule of values",
    "scheduled value",
    "sov value",
    "contract amount",
    "contract value",
    "original contract",
    "budget",
    "amount",
    "value",
    "price",
    "total",
  ],
  sort_order: ["sort order", "sort", "order", "seq", "sequence"],
  notes: ["notes", "note", "comments", "comment", "remarks"],
};

// Words that make a row read like an SOV header rather than SOV data. The
// header detector in gridFromMatrix already refuses any row holding a bare
// number or a dotted code, which is what keeps a real first line of
// "1.01 | LNTP | LNTP Execution Engineering | $22,580.68" from being eaten.
const SOV_HEADER_HINTS = [
  "item",
  "type",
  "description",
  "scope",
  "work",
  "schedule",
  "scheduled",
  "value",
  "amount",
  "contract",
  "budget",
  "category",
  "notes",
  "sort",
  "total",
];

// An SOV header carries month columns ("Jan-26", "Feb-26") alongside the real
// ones, so a date in the row must not disqualify it. Data rows are still kept
// out by the item-number guard: no column is called "1.01".
export const SOV_HEADER_RULE: HeaderRule = {
  hints: SOV_HEADER_HINTS,
  allowDates: true,
};

export function parseSovGrid(text: string): ParsedGrid {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: null, rows: [], delimiter: "tab" };

  // The delimiter is decided once for the whole block, not per line. A paste
  // out of Excel is tab separated, and a single-cell row inside it - a section
  // banner, say - must not fall through to comma splitting and break
  // "Site Work, Phase 2" in half.
  const delimiter = lines.some((l) => l.includes("\t")) ? "tab" : "comma";
  const cells = lines.map((l) =>
    delimiter === "tab"
      ? l.includes("\t")
        ? l.split("\t").map((c) => c.trim())
        : [l.trim()]
      : splitRow(l),
  );
  return gridFromMatrix(cells, delimiter, SOV_HEADER_RULE);
}

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[_*#]/g, " ")
    .replace(/[():]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Money parsing is paste-table's, with one addition the owner SOV needs: a
// currency cell Excel has formatted as zero comes across as a lone dash
// (" $-   " is how every zero reads in Phil's cash-flow workbook). paste-table
// returns null for that, which is right where an unreadable cell should be
// skipped with a reason, but here it genuinely means zero. Anything else
// unreadable still returns null rather than being guessed at - a scheduled
// value silently read as $0 is worse than one flagged as unreadable.
export function parseMoney(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\$?\s*-+\s*$/.test(s)) return 0;
  return parseMoneyStrict(s);
}

function parseIntish(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s.replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

const MONEY_RE = /^[$(\s-]*[\d,]+(\.\d+)?[)\s]*$/;

// Column mapping. Header text decides it when there is a header; when there is
// not - or when a column's header is blank, which is exactly how the
// description column arrives out of Phil's cash-flow workbook - the shape of
// the cells decides.
export function guessSovColumns(
  headers: string[] | null,
  rows: string[][],
): (SovColumnKey | null)[] {
  const width = headers?.length ?? rows[0]?.length ?? 0;
  const out: (SovColumnKey | null)[] = new Array(width).fill(null);
  const taken = new Set<SovColumnKey>();

  if (headers) {
    for (const pass of ["exact", "partial"] as const) {
      for (let i = 0; i < width; i++) {
        if (out[i]) continue;
        const h = normalizeHeader(headers[i] ?? "");
        if (!h) continue;
        for (const key of SOV_COLUMN_KEYS) {
          if (taken.has(key)) continue;
          const hit = SOV_COLUMN_ALIASES[key].some((a) =>
            pass === "exact" ? h === a : h.includes(a),
          );
          if (hit) {
            out[i] = key;
            taken.add(key);
            break;
          }
        }
      }
    }
  }

  // Shape fallback for whatever is still unassigned.
  const sample = rows.slice(0, 40);
  const stats = Array.from({ length: width }, (_, c) => {
    const cells = sample.map((r) => (r[c] ?? "").trim()).filter(Boolean);
    const money = cells.filter((v) => MONEY_RE.test(v)).length;
    const code = cells.filter((v) => /^[A-Za-z]{0,4}[-\s]?\d+(\.\d+)*$/.test(v)).length;
    const avgLen = cells.length
      ? cells.reduce((s, v) => s + v.length, 0) / cells.length
      : 0;
    return {
      c,
      filled: cells.length,
      moneyRatio: cells.length ? money / cells.length : 0,
      codeRatio: cells.length ? code / cells.length : 0,
      avgLen,
    };
  }).filter((s) => s.filled > 0);

  const free = () => stats.filter((s) => out[s.c] === null);

  if (!taken.has("item_number")) {
    const pick = free()
      .filter((s) => s.codeRatio >= 0.6)
      .sort((a, b) => a.c - b.c)[0];
    if (pick) {
      out[pick.c] = "item_number";
      taken.add("item_number");
    }
  }

  if (!taken.has("scheduled_value")) {
    // The widest money column, not the first: month columns in a cash-flow
    // sheet are money too, and the scheduled value is the one that is filled
    // on nearly every row.
    const pick = free()
      .filter((s) => s.moneyRatio >= 0.7)
      .sort((a, b) => b.filled - a.filled || a.c - b.c)[0];
    if (pick) {
      out[pick.c] = "scheduled_value";
      taken.add("scheduled_value");
    }
  }

  if (!taken.has("description")) {
    const pick = free()
      .filter((s) => s.moneyRatio < 0.5 && s.avgLen >= 4)
      .sort((a, b) => b.avgLen - a.avgLen || a.c - b.c)[0];
    if (pick) {
      out[pick.c] = "description";
      taken.add("description");
    }
  }

  return out;
}

export type SovValues = {
  item_number?: string;
  type?: string | null;
  description?: string | null;
  scheduled_value?: number | null;
  sort_order?: number | null;
  notes?: string | null;
};

export type SovImportRow = {
  rowNumber: number;
  itemNumber: string;
  values: SovValues;
  issues: string[];
};

export type SovBuild = {
  rows: SovImportRow[];
  // Rows that cannot be imported at all, with the reason.
  rejected: { rowNumber: number; label: string; reason: string }[];
  notes: string[];
};

// Rows a schedule of values carries that are not line items: the totals block
// at the bottom, and the retainage line. Phil's workbook types them literally.
const NON_LINE_RE = /^(grand\s+)?(sub)?totals?$|^retainage$|^total\b/i;

export function buildSovRows(
  grid: ParsedGrid,
  mapping: (SovColumnKey | null)[],
): SovBuild {
  const col = (k: SovColumnKey) => mapping.indexOf(k);
  const iItem = col("item_number");
  const rows: SovImportRow[] = [];
  const rejected: SovBuild["rejected"] = [];
  const notes: string[] = [];
  let skippedTotals = 0;
  let skippedBlank = 0;

  const cell = (r: string[], k: SovColumnKey): string => {
    const i = col(k);
    return i === -1 ? "" : (r[i] ?? "").trim();
  };

  grid.rows.forEach((r, idx) => {
    // Row numbers are what the user sees in the preview, so count the header.
    const rowNumber = idx + 1 + (grid.headers ? 1 : 0);
    const itemNumber = iItem === -1 ? "" : (r[iItem] ?? "").trim();
    const description = cell(r, "description");
    const type = cell(r, "type");

    if (!itemNumber && !description && !type) {
      skippedBlank += 1;
      return;
    }
    if (
      NON_LINE_RE.test(itemNumber) ||
      NON_LINE_RE.test(type) ||
      NON_LINE_RE.test(description)
    ) {
      skippedTotals += 1;
      return;
    }
    if (!itemNumber) {
      rejected.push({
        rowNumber,
        label: description || type || "(blank)",
        reason: "no item number - the SOV keys on it",
      });
      return;
    }

    const issues: string[] = [];
    const values: SovValues = { item_number: itemNumber };

    if (mapping.includes("type")) values.type = type || null;
    if (mapping.includes("description")) values.description = description || null;
    if (mapping.includes("notes")) values.notes = cell(r, "notes") || null;

    if (mapping.includes("scheduled_value")) {
      const raw = cell(r, "scheduled_value");
      if (raw) {
        const v = parseMoney(raw);
        if (v === null) issues.push(`scheduled value "${raw}" could not be read`);
        else values.scheduled_value = v;
      } else {
        values.scheduled_value = null;
      }
    }

    if (mapping.includes("sort_order")) {
      const raw = cell(r, "sort_order");
      if (raw) {
        const v = parseIntish(raw);
        if (v === null) issues.push(`sort order "${raw}" could not be read`);
        else values.sort_order = v;
      } else {
        values.sort_order = null;
      }
    }

    rows.push({ rowNumber, itemNumber, values, issues });
  });

  // Sheet order is the SOV's order, and the billing table sorts on it. Only
  // stamp it when the sheet did not say otherwise.
  if (!mapping.includes("sort_order")) {
    rows.forEach((r, i) => {
      r.values.sort_order = (i + 1) * 10;
    });
    notes.push(
      "No sort order column mapped, so lines are numbered in sheet order (10, 20, 30...). Existing lines keep their own order unless they appear here.",
    );
  }

  if (skippedTotals > 0) {
    notes.push(
      `${skippedTotals} total or retainage row${skippedTotals === 1 ? "" : "s"} skipped - those are computed, not SOV lines.`,
    );
  }
  if (skippedBlank > 0) {
    notes.push(`${skippedBlank} blank row${skippedBlank === 1 ? "" : "s"} skipped.`);
  }

  return { rows, rejected, notes };
}

export type ExistingLine = {
  id: string;
  item_number: string;
  type: string | null;
  description: string;
  scheduled_value: number | null;
  sort_order: number | null;
  notes: string | null;
  change_order_id: string | null;
};

export type SovFieldChange = {
  field: SovColumnKey;
  from: unknown;
  to: unknown;
};

export type SovDiff = {
  adds: SovImportRow[];
  changes: { existing: ExistingLine; row: SovImportRow; fields: SovFieldChange[] }[];
  unchangedCount: number;
  blocking: string[];
  warnings: string[];
};

function sameMoney(a: number | null, b: number | null): boolean {
  const x = a === null ? null : Math.round(a * 100);
  const y = b === null ? null : Math.round(b * 100);
  return x === y;
}

export function diffSov(
  existing: ExistingLine[],
  build: SovBuild,
  mapping: (SovColumnKey | null)[],
): SovDiff {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (!mapping.includes("item_number")) {
    blocking.push("No column is mapped to Item number. It is the key every SOV line is matched on.");
  }

  const byItem = new Map(existing.map((e) => [e.item_number, e]));
  const adds: SovImportRow[] = [];
  const changes: SovDiff["changes"] = [];
  let unchangedCount = 0;

  // A duplicate item number inside one paste is ambiguous, not mergeable -
  // there is no way to know which row is meant to win.
  const seen = new Map<string, number[]>();
  for (const r of build.rows) {
    const at = seen.get(r.itemNumber) ?? [];
    at.push(r.rowNumber);
    seen.set(r.itemNumber, at);
  }
  const dupes = Array.from(seen.entries()).filter(([, at]) => at.length > 1);
  if (dupes.length) {
    blocking.push(
      `Duplicate item number${dupes.length === 1 ? "" : "s"} in the import: ${dupes
        .map(([item, at]) => `${item} (rows ${at.join(", ")})`)
        .join("; ")}.`,
    );
  }

  for (const row of build.rows) {
    const match = byItem.get(row.itemNumber);
    if (!match) {
      if (!row.values.description) {
        blocking.push(
          `Row ${row.rowNumber} (${row.itemNumber}) is a new line with no description. A new SOV line needs one.`,
        );
      }
      adds.push(row);
      continue;
    }

    const fields: SovFieldChange[] = [];
    const v = row.values;

    if (mapping.includes("type") && (v.type ?? null) !== (match.type ?? null)) {
      fields.push({ field: "type", from: match.type, to: v.type });
    }
    if (
      mapping.includes("description") &&
      v.description &&
      v.description !== match.description
    ) {
      fields.push({ field: "description", from: match.description, to: v.description });
    }
    if (
      mapping.includes("scheduled_value") &&
      v.scheduled_value !== undefined &&
      !sameMoney(v.scheduled_value ?? null, match.scheduled_value === null ? null : Number(match.scheduled_value))
    ) {
      fields.push({
        field: "scheduled_value",
        from: match.scheduled_value,
        to: v.scheduled_value,
      });
    }
    if (
      v.sort_order !== undefined &&
      (v.sort_order ?? null) !== (match.sort_order ?? null)
    ) {
      fields.push({ field: "sort_order", from: match.sort_order, to: v.sort_order });
    }
    if (mapping.includes("notes") && (v.notes ?? null) !== (match.notes ?? null)) {
      fields.push({ field: "notes", from: match.notes, to: v.notes });
    }

    if (!fields.length) {
      unchangedCount += 1;
      continue;
    }

    if (match.change_order_id && fields.some((f) => f.field === "scheduled_value")) {
      warnings.push(
        `${match.item_number} is the SOV line for an approved change order. Its scheduled value normally comes from the CO - changing it here will not change the CO.`,
      );
    }

    changes.push({ existing: match, row, fields });
  }

  return { adds, changes, unchangedCount, blocking, warnings };
}

export type SovImportPlan = {
  adds: {
    item_number: string;
    type: string | null;
    description: string;
    scheduled_value: number | null;
    sort_order: number | null;
    notes: string | null;
  }[];
  changes: { id: string; patch: Record<string, unknown> }[];
};

export function planFromDiff(
  diff: SovDiff,
  mapping: (SovColumnKey | null)[],
): SovImportPlan {
  return {
    adds: diff.adds.map((r) => ({
      item_number: r.itemNumber,
      type: mapping.includes("type") ? (r.values.type ?? null) : null,
      description: r.values.description ?? "",
      scheduled_value: r.values.scheduled_value ?? null,
      sort_order: r.values.sort_order ?? null,
      notes: mapping.includes("notes") ? (r.values.notes ?? null) : null,
    })),
    changes: diff.changes.map((c) => {
      const patch: Record<string, unknown> = {};
      for (const f of c.fields) patch[f.field] = f.to ?? null;
      return { id: c.existing.id, patch };
    }),
  };
}
