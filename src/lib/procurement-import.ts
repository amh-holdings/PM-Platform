// Procurement import: purchase orders and their payment milestones.
//
// Until now a PO arrived one way only - through the Add purchase order form,
// one at a time, and then a second pass through the milestone editor for each
// payment on it. A twenty-line procurement log out of Excel is therefore
// twenty trips through a form plus sixty milestone rows typed by hand, which
// is why the POs on a job that predates the app are usually not in the app at
// all. Their cost is then in the forecast nowhere: the projection skips a cost
// code tied to a PO on the assumption the PO's milestones supply that cost.
//
// This is the same job the SOV importer does for billing lines - map the
// columns of a paste or a workbook, show the diff, write nothing until it is
// approved - with two differences that come from what a procurement log
// actually looks like.
//
// A procurement log is two tables in one grid. Some are one row per PO. Some
// are one row per payment milestone with the PO number repeated down the page.
// Both are handled: map a milestone column and rows group by PO number, leave
// it unmapped and one row is one PO.
//
// And, like the SOV importer, there is no delete side. A PO carries paid money
// and a cash projection; a milestone that is on the app but missing from the
// sheet is far more likely to be a sheet that was filtered than a payment that
// was cancelled. Removing either stays a deliberate per-record action.

import { parseMoney as parseMoneyStrict, splitRow } from "@/lib/paste-table";
import { recordedPayment } from "@/lib/progress";
import {
  gridFromMatrix,
  parseLooseDate,
  type HeaderRule,
  type ParsedGrid,
} from "@/lib/schedule-edit";

export type PoColumnKey =
  // The purchase order itself.
  | "po_number"
  | "vendor_name"
  | "description"
  | "total_value"
  | "ordered_date"
  | "expected_delivery_date"
  | "actual_delivery_date"
  | "status"
  | "payment_terms_summary"
  | "notes"
  | "delivery_task_wbs"
  // One payment milestone on it.
  | "milestone_name"
  | "pct_of_total"
  | "trigger_event"
  | "milestone_expected_date"
  | "milestone_amount"
  | "paid_at"
  | "paid_amount"
  | "milestone_notes";

export const PO_COLUMN_KEYS: PoColumnKey[] = [
  "po_number",
  "vendor_name",
  "description",
  "total_value",
  "ordered_date",
  "expected_delivery_date",
  "actual_delivery_date",
  "status",
  "payment_terms_summary",
  "notes",
  "delivery_task_wbs",
  "milestone_name",
  "pct_of_total",
  "trigger_event",
  "milestone_expected_date",
  "milestone_amount",
  "paid_at",
  "paid_amount",
  "milestone_notes",
];

export const PO_COLUMN_LABELS: Record<PoColumnKey, string> = {
  po_number: "PO number",
  vendor_name: "Vendor",
  description: "Description",
  total_value: "PO total",
  ordered_date: "Ordered",
  expected_delivery_date: "Expected delivery",
  actual_delivery_date: "Actual delivery",
  status: "Status",
  payment_terms_summary: "Payment terms",
  notes: "PO notes",
  delivery_task_wbs: "Delivery task WBS",
  milestone_name: "Milestone",
  pct_of_total: "Milestone %",
  trigger_event: "Trigger event",
  milestone_expected_date: "Milestone due",
  milestone_amount: "Milestone amount",
  paid_at: "Paid date",
  paid_amount: "Paid amount",
  milestone_notes: "Milestone notes",
};

// The milestone half of the mapping. Mapping any one of these turns the import
// from one-row-per-PO into one-row-per-payment.
export const MILESTONE_COLUMN_KEYS: PoColumnKey[] = [
  "milestone_name",
  "pct_of_total",
  "trigger_event",
  "milestone_expected_date",
  "milestone_amount",
  "paid_at",
  "paid_amount",
  "milestone_notes",
];

// Matched against a normalized header, exact across every column before any
// partial. The ordering inside each list matters for the partial pass: a sheet
// with both "Amount" and "Paid Amount" must not hand the paid column to the
// milestone amount, which is why "paid" spellings are listed on their own key
// and the bare words sit last.
const PO_COLUMN_ALIASES: Record<PoColumnKey, string[]> = {
  po_number: ["po number", "po no", "po #", "po", "purchase order", "purchase order number", "order number", "po ref"],
  vendor_name: ["vendor", "vendor name", "supplier", "supplier name", "manufacturer", "seller", "company", "payee"],
  description: ["description", "scope", "equipment", "material", "item", "commodity", "what"],
  total_value: ["po total", "po value", "po amount", "total value", "order value", "contract value", "committed", "total", "value", "amount"],
  ordered_date: ["ordered", "ordered date", "order date", "po date", "issued", "issue date", "released"],
  expected_delivery_date: ["expected delivery", "expected delivery date", "delivery date", "eta", "need by", "required on site", "ros", "promised", "scheduled delivery"],
  actual_delivery_date: ["actual delivery", "actual delivery date", "delivered", "delivered date", "received", "received date", "on site"],
  status: ["status", "state", "po status"],
  payment_terms_summary: ["payment terms", "terms", "terms summary", "payment summary"],
  notes: ["po notes", "notes", "note", "comments", "comment", "remarks"],
  delivery_task_wbs: ["delivery task", "delivery wbs", "schedule task", "schedule wbs", "wbs", "wbs code", "task wbs", "linked task"],
  milestone_name: ["milestone", "milestone name", "payment milestone", "payment", "payment name", "installment"],
  pct_of_total: ["milestone %", "milestone pct", "% of total", "pct of total", "percent", "percentage", "%", "pct", "split"],
  trigger_event: ["trigger", "trigger event", "triggered by", "payment trigger", "condition", "event"],
  milestone_expected_date: ["milestone due", "due", "due date", "payment due", "expected payment", "milestone date", "expected date"],
  milestone_amount: ["milestone amount", "payment amount", "amount due", "invoice amount"],
  paid_at: ["paid date", "date paid", "paid on", "paid at", "payment date", "check date", "cleared"],
  paid_amount: ["paid amount", "amount paid", "paid value", "paid"],
  milestone_notes: ["milestone notes", "payment notes"],
};

// Words that make a row read like a procurement header rather than a PO. The
// header detector already refuses a row holding a bare number or a dotted
// code, which is what keeps a first data row of "PO-018 | FTC Solar | ..." out
// of the running.
const PO_HEADER_HINTS = [
  "po",
  "purchase",
  "order",
  "vendor",
  "supplier",
  "description",
  "equipment",
  "total",
  "value",
  "amount",
  "ordered",
  "delivery",
  "delivered",
  "status",
  "terms",
  "milestone",
  "payment",
  "trigger",
  "paid",
  "due",
  "notes",
  "wbs",
];

// A procurement log's header routinely carries dates of its own - a "Sep-26"
// column on a cash-out sheet, or a header that spells the month out. Allowing
// them here costs nothing, because a data row still has to clear the
// hints-and-shape bar to displace row 0.
export const PO_HEADER_RULE: HeaderRule = {
  hints: PO_HEADER_HINTS,
  allowDates: true,
};

export function parsePoGrid(text: string): ParsedGrid {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: null, rows: [], delimiter: "tab" };

  // Decided once for the whole block, not per line. A vendor called
  // "Matthews Power, LLC" pasted out of Excel is one tab-separated cell, and
  // a row that happens to hold no tab must not fall through to comma
  // splitting and break that name in half.
  const delimiter = lines.some((l) => l.includes("\t")) ? "tab" : "comma";
  const cells = lines.map((l) =>
    delimiter === "tab"
      ? l.includes("\t")
        ? l.split("\t").map((c) => c.trim())
        : [l.trim()]
      : splitRow(l),
  );
  return gridFromMatrix(cells, delimiter, PO_HEADER_RULE);
}

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[_*]/g, " ")
    .replace(/[():]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Money, with the one addition every one of Phil's workbooks needs: a currency
// cell Excel has formatted as zero comes across as a lone dash. Anything else
// unreadable stays null rather than being guessed at, because a PO total read
// silently as $0 is worse than one flagged as unreadable.
export function parsePoMoney(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\$?\s*-+\s*$/.test(s)) return 0;
  return parseMoneyStrict(s);
}

// "30%", "30", "0.30" all mean thirty percent of the PO. The fraction form is
// how a spreadsheet stores a cell formatted as a percentage, so a value at or
// below 1 with a decimal point is read as a fraction. A bare "1" is one
// percent, not the whole PO: a single-payment PO is written 100%.
export function parsePct(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, "");
  if (!s) return null;
  const hadSign = s.includes("%");
  const n = Number(s.replace(/[%,]/g, ""));
  if (!Number.isFinite(n)) return null;
  if (!hadSign && n > 0 && n <= 1 && /\./.test(s)) return n * 100;
  return n;
}

const STATUSES = ["active", "complete", "delivered", "cancelled"] as const;

// What the procurement table colours and filters on. Anything else is left
// alone rather than coerced, so a sheet with its own vocabulary flags the row
// instead of quietly filing every PO under "active".
export function normalizeStatus(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if ((STATUSES as readonly string[]).includes(s)) return s;
  if (/^(open|issued|in progress|ordered|placed)$/.test(s)) return "active";
  if (/^(closed|done|paid in full|complete[d]?)$/.test(s)) return "complete";
  if (/^(received|on site|delivered)$/.test(s)) return "delivered";
  if (/^(void|voided|cancell?ed|killed)$/.test(s)) return "cancelled";
  return null;
}

const MONEY_RE = /^[$(\s-]*[\d,]+(\.\d+)?[)\s]*$/;
const PO_CODE_RE = /^[A-Za-z]{0,6}[-\s]?\d{1,6}[A-Za-z]?$/;

// Column mapping. Header text decides it wherever there is one; the shape of
// the cells decides the rest, which matters because a procurement log exported
// out of an accounting system routinely arrives with no header at all.
export function guessPoColumns(
  headers: string[] | null,
  rows: string[][],
): (PoColumnKey | null)[] {
  const width = headers?.length ?? rows[0]?.length ?? 0;
  const out: (PoColumnKey | null)[] = new Array(width).fill(null);
  const taken = new Set<PoColumnKey>();

  if (headers) {
    for (const pass of ["exact", "partial"] as const) {
      for (let i = 0; i < width; i++) {
        if (out[i]) continue;
        const h = normalizeHeader(headers[i] ?? "");
        if (!h) continue;
        for (const key of PO_COLUMN_KEYS) {
          if (taken.has(key)) continue;
          const hit = PO_COLUMN_ALIASES[key].some((a) =>
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

  const sample = rows.slice(0, 40);
  const stats = Array.from({ length: width }, (_, c) => {
    const cells = sample.map((r) => (r[c] ?? "").trim()).filter(Boolean);
    const money = cells.filter((v) => MONEY_RE.test(v)).length;
    const dates = cells.filter((v) => parseLooseDate(v) !== null).length;
    const codes = cells.filter((v) => PO_CODE_RE.test(v)).length;
    const avgLen = cells.length
      ? cells.reduce((s, v) => s + v.length, 0) / cells.length
      : 0;
    return {
      c,
      filled: cells.length,
      moneyRatio: cells.length ? money / cells.length : 0,
      dateRatio: cells.length ? dates / cells.length : 0,
      codeRatio: cells.length ? codes / cells.length : 0,
      avgLen,
    };
  }).filter((s) => s.filled > 0);

  const free = () => stats.filter((s) => out[s.c] === null);

  if (!taken.has("po_number")) {
    // Dates parse as codes under a loose reading, so they are excluded before
    // the leftmost code-shaped column is claimed.
    const pick = free()
      .filter((s) => s.codeRatio >= 0.7 && s.dateRatio < 0.3)
      .sort((a, b) => a.c - b.c)[0];
    if (pick) {
      out[pick.c] = "po_number";
      taken.add("po_number");
    }
  }

  if (!taken.has("total_value")) {
    // The widest money column, not the first. A cash-out sheet's month columns
    // are money too; the PO total is the one filled on nearly every row.
    const pick = free()
      .filter((s) => s.moneyRatio >= 0.7)
      .sort((a, b) => b.filled - a.filled || a.c - b.c)[0];
    if (pick) {
      out[pick.c] = "total_value";
      taken.add("total_value");
    }
  }

  if (!taken.has("vendor_name")) {
    const pick = free()
      .filter((s) => s.moneyRatio < 0.3 && s.dateRatio < 0.3 && s.avgLen >= 3)
      .sort((a, b) => a.c - b.c)[0];
    if (pick) {
      out[pick.c] = "vendor_name";
      taken.add("vendor_name");
    }
  }

  if (!taken.has("description")) {
    const pick = free()
      .filter((s) => s.moneyRatio < 0.3 && s.dateRatio < 0.3 && s.avgLen >= 8)
      .sort((a, b) => b.avgLen - a.avgLen || a.c - b.c)[0];
    if (pick) {
      out[pick.c] = "description";
      taken.add("description");
    }
  }

  // Dates left to right: ordered, then expected, then actual. That is the
  // order they happen in and the order every procurement log prints them.
  for (const key of [
    "ordered_date",
    "expected_delivery_date",
    "actual_delivery_date",
  ] as const) {
    if (taken.has(key)) continue;
    const pick = free()
      .filter((s) => s.dateRatio >= 0.6)
      .sort((a, b) => a.c - b.c)[0];
    if (!pick) break;
    out[pick.c] = key;
    taken.add(key);
  }

  return out;
}

export type PoValues = {
  po_number: string;
  vendor_name?: string | null;
  description?: string | null;
  total_value?: number | null;
  ordered_date?: string | null;
  expected_delivery_date?: string | null;
  actual_delivery_date?: string | null;
  status?: string | null;
  payment_terms_summary?: string | null;
  notes?: string | null;
  linked_delivery_task_wbs_code?: string | null;
};

export type MilestoneValues = {
  milestone_name: string;
  pct_of_total: number | null;
  trigger_event: string | null;
  expected_date: string | null;
  amount: number | null;
  paid_at: string | null;
  paid_amount: number | null;
  sort_order: number | null;
  notes: string | null;
};

export type MilestoneImportRow = {
  rowNumber: number;
  values: MilestoneValues;
  issues: string[];
};

export type PoImportRow = {
  // The first sheet row this PO appeared on, which is where the preview points.
  rowNumber: number;
  poNumber: string;
  values: PoValues;
  milestones: MilestoneImportRow[];
  issues: string[];
};

export type PoBuild = {
  rows: PoImportRow[];
  rejected: { rowNumber: number; label: string; reason: string }[];
  notes: string[];
  // True when a milestone column was mapped, so rows were grouped by PO number
  // and each row is a payment rather than a purchase order.
  hasMilestones: boolean;
};

// Rows a procurement log carries that are not purchase orders: the totals
// block at the bottom, and section banners.
const NON_PO_RE = /^(grand\s+)?(sub)?totals?$|^total\b/i;

// Header fields are taken from the first row of a PO's group that supplies
// one. A later row that says something different about the same field is a
// disagreement inside the sheet, and the sheet is the only place it can be
// fixed, so it is named rather than silently resolved.
function takeHeaderField<T>(
  current: T | undefined,
  next: T | null,
  label: string,
  issues: string[],
): T | null | undefined {
  if (next === null || next === undefined || next === "") return current;
  if (current === undefined || current === null || current === "") return next;
  if (current === next) return current;
  issues.push(
    `${label} is "${String(current)}" on the first row of this PO and "${String(next)}" further down. The first one is used.`,
  );
  return current;
}

export function buildPoRows(
  grid: ParsedGrid,
  mapping: (PoColumnKey | null)[],
): PoBuild {
  const col = (k: PoColumnKey) => mapping.indexOf(k);
  const has = (k: PoColumnKey) => mapping.includes(k);
  const rejected: PoBuild["rejected"] = [];
  const notes: string[] = [];
  const hasMilestones = MILESTONE_COLUMN_KEYS.some((k) => has(k));

  let skippedTotals = 0;
  let skippedBlank = 0;

  const cell = (r: string[], k: PoColumnKey): string => {
    const i = col(k);
    return i === -1 ? "" : (r[i] ?? "").trim();
  };

  const byPo = new Map<string, PoImportRow>();
  const order: string[] = [];

  grid.rows.forEach((r, idx) => {
    // Row numbers are what the preview shows, so count the header.
    const rowNumber = idx + 1 + (grid.headers ? 1 : 0);
    const poNumber = cell(r, "po_number");
    const vendor = cell(r, "vendor_name");
    const description = cell(r, "description");
    const milestoneName = cell(r, "milestone_name");

    if (!poNumber && !vendor && !description && !milestoneName) {
      skippedBlank += 1;
      return;
    }
    if (
      NON_PO_RE.test(poNumber) ||
      NON_PO_RE.test(vendor) ||
      NON_PO_RE.test(description)
    ) {
      skippedTotals += 1;
      return;
    }
    if (!poNumber) {
      rejected.push({
        rowNumber,
        label: vendor || description || milestoneName || "(blank)",
        reason: "no PO number - every purchase order is matched on it",
      });
      return;
    }

    let entry = byPo.get(poNumber);
    if (!entry) {
      entry = {
        rowNumber,
        poNumber,
        values: { po_number: poNumber },
        milestones: [],
        issues: [],
      };
      byPo.set(poNumber, entry);
      order.push(poNumber);
    }

    const v = entry.values;
    const issues = entry.issues;

    const text = (k: PoColumnKey): string | null => (has(k) ? cell(r, k) || null : null);

    const money = (k: PoColumnKey): number | null | undefined => {
      if (!has(k)) return undefined;
      const raw = cell(r, k);
      if (!raw) return null;
      const n = parsePoMoney(raw);
      if (n === null) {
        issues.push(`${PO_COLUMN_LABELS[k]} "${raw}" could not be read`);
        return undefined;
      }
      return n;
    };

    const date = (k: PoColumnKey): string | null | undefined => {
      if (!has(k)) return undefined;
      const raw = cell(r, k);
      if (!raw) return null;
      const d = parseLooseDate(raw);
      if (d === null) {
        issues.push(`${PO_COLUMN_LABELS[k]} "${raw}" is not a date we can read`);
        return undefined;
      }
      return d;
    };

    if (has("vendor_name")) {
      v.vendor_name = takeHeaderField(v.vendor_name, vendor || null, "Vendor", issues);
    }
    if (has("description")) {
      v.description = takeHeaderField(v.description, description || null, "Description", issues);
    }
    if (has("total_value")) {
      const n = money("total_value");
      if (n !== undefined) {
        v.total_value = takeHeaderField(v.total_value, n, "PO total", issues);
      }
    }
    for (const k of ["ordered_date", "expected_delivery_date", "actual_delivery_date"] as const) {
      if (!has(k)) continue;
      const d = date(k);
      if (d !== undefined) {
        v[k] = takeHeaderField(v[k], d, PO_COLUMN_LABELS[k], issues);
      }
    }
    if (has("status")) {
      const raw = cell(r, "status");
      if (raw) {
        const s = normalizeStatus(raw);
        if (s === null) {
          issues.push(
            `Status "${raw}" is not one we recognise (active, complete, delivered, cancelled). The status is left as it is.`,
          );
        } else {
          v.status = takeHeaderField(v.status, s, "Status", issues);
        }
      } else if (v.status === undefined) {
        v.status = null;
      }
    }
    if (has("payment_terms_summary")) {
      v.payment_terms_summary = takeHeaderField(
        v.payment_terms_summary,
        text("payment_terms_summary"),
        "Payment terms",
        issues,
      );
    }
    if (has("notes")) {
      v.notes = takeHeaderField(v.notes, text("notes"), "PO notes", issues);
    }
    if (has("delivery_task_wbs")) {
      v.linked_delivery_task_wbs_code = takeHeaderField(
        v.linked_delivery_task_wbs_code,
        text("delivery_task_wbs"),
        "Delivery task WBS",
        issues,
      );
    }

    if (!hasMilestones) return;

    // A milestone row has to say something of its own. A PO's second row that
    // only repeats the PO number is a spreadsheet artefact, not a payment.
    const mIssues: string[] = [];
    const mMoney = (k: PoColumnKey): number | null => {
      if (!has(k)) return null;
      const raw = cell(r, k);
      if (!raw) return null;
      const n = parsePoMoney(raw);
      if (n === null) {
        mIssues.push(`${PO_COLUMN_LABELS[k]} "${raw}" could not be read`);
        return null;
      }
      return n;
    };
    const mDate = (k: PoColumnKey): string | null => {
      if (!has(k)) return null;
      const raw = cell(r, k);
      if (!raw) return null;
      const d = parseLooseDate(raw);
      if (d === null) {
        mIssues.push(`${PO_COLUMN_LABELS[k]} "${raw}" is not a date we can read`);
        return null;
      }
      return d;
    };

    let pct: number | null = null;
    if (has("pct_of_total")) {
      const raw = cell(r, "pct_of_total");
      if (raw) {
        pct = parsePct(raw);
        if (pct === null) mIssues.push(`Milestone % "${raw}" could not be read`);
      }
    }

    const amount = mMoney("milestone_amount");
    const paidAmount = mMoney("paid_amount");
    const paidAt = mDate("paid_at");
    const expected = mDate("milestone_expected_date");
    const trigger = text("trigger_event");
    const mNotes = text("milestone_notes");

    const saysSomething =
      milestoneName ||
      pct !== null ||
      amount !== null ||
      paidAmount !== null ||
      paidAt !== null ||
      expected !== null ||
      trigger !== null ||
      mNotes !== null;
    if (!saysSomething) return;

    if (!milestoneName) {
      rejected.push({
        rowNumber,
        label: `${poNumber} payment`,
        reason: "no milestone name - a payment on a PO is matched on its name",
      });
      return;
    }

    entry.milestones.push({
      rowNumber,
      values: {
        milestone_name: milestoneName,
        pct_of_total: pct,
        trigger_event: trigger,
        expected_date: expected,
        amount,
        paid_at: paidAt,
        paid_amount: paidAmount,
        sort_order: entry.milestones.length + 1,
        notes: mNotes,
      },
      issues: mIssues,
    });
  });

  const rows = order.map((po) => byPo.get(po)!);

  // A milestone name repeated inside one PO is ambiguous, not mergeable, and
  // on re-import it would match the same existing row twice.
  for (const po of rows) {
    const seen = new Map<string, number[]>();
    for (const m of po.milestones) {
      const key = m.values.milestone_name.toLowerCase();
      const at = seen.get(key) ?? [];
      at.push(m.rowNumber);
      seen.set(key, at);
    }
    for (const at of Array.from(seen.values())) {
      if (at.length > 1) {
        po.issues.push(
          `The same milestone name appears on rows ${at.join(", ")} of this PO. Give them different names or the import cannot tell them apart.`,
        );
      }
    }
  }

  if (hasMilestones) {
    const withMilestones = rows.filter((r) => r.milestones.length).length;
    notes.push(
      `Read as a payment schedule: ${rows.length} purchase order${rows.length === 1 ? "" : "s"} across ${grid.rows.length} rows, ${withMilestones} of them with milestones. Unmap every milestone column to read one row per PO instead.`,
    );
  }
  if (skippedTotals > 0) {
    notes.push(
      `${skippedTotals} total row${skippedTotals === 1 ? "" : "s"} skipped - those are computed, not purchase orders.`,
    );
  }
  if (skippedBlank > 0) {
    notes.push(`${skippedBlank} blank row${skippedBlank === 1 ? "" : "s"} skipped.`);
  }

  return { rows, rejected, notes, hasMilestones };
}

export type ExistingMilestone = {
  id: string;
  milestone_name: string;
  pct_of_total: number | null;
  trigger_event: string | null;
  expected_date: string | null;
  amount: number | null;
  paid_at: string | null;
  paid_amount: number | null;
  sort_order: number | null;
  notes: string | null;
};

export type ExistingOrder = {
  id: string;
  po_number: string | null;
  vendor_name: string;
  description: string | null;
  total_value: number | null;
  ordered_date: string | null;
  expected_delivery_date: string | null;
  actual_delivery_date: string | null;
  status: string | null;
  payment_terms_summary: string | null;
  notes: string | null;
  linked_delivery_task_wbs_code: string | null;
  milestones: ExistingMilestone[];
};

// A delivery task the import may point a PO at. Its finish date is what
// setProcurementDeliveryTaskLink copies onto the PO, and the import does the
// same, so a linked PO reads its delivery date off the schedule instead of off
// whatever the spreadsheet happened to say.
export type DeliveryTask = { wbs_code: string; end_date: string | null };

export type PoFieldChange = { field: PoColumnKey; from: unknown; to: unknown };

export type MilestoneFieldChange = {
  field: keyof MilestoneValues;
  from: unknown;
  to: unknown;
};

export type PoDiff = {
  adds: PoImportRow[];
  changes: { existing: ExistingOrder; row: PoImportRow; fields: PoFieldChange[] }[];
  // Milestones landing on a PO that already exists. Milestones on a PO being
  // added travel with it, because their order id does not exist yet.
  milestoneAdds: {
    poNumber: string;
    orderId: string;
    rowNumber: number;
    values: MilestoneValues;
  }[];
  milestoneChanges: {
    poNumber: string;
    id: string;
    name: string;
    fields: MilestoneFieldChange[];
  }[];
  unchangedCount: number;
  unchangedMilestoneCount: number;
  blocking: string[];
  warnings: string[];
};

export function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function cents(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  return Math.round(Number(n) * 100);
}

function sameMoney(a: number | null | undefined, b: number | null | undefined): boolean {
  return cents(a) === cents(b);
}

// A milestone's amount, worked out the way addMilestone works it out: the
// stated amount, or the percentage applied to whatever the PO total will be
// after this import.
function effectiveAmount(m: MilestoneValues, poTotal: number | null): number | null {
  if (m.amount !== null) return m.amount;
  if (m.pct_of_total !== null && poTotal !== null) return poTotal * (m.pct_of_total / 100);
  return null;
}

export function diffProcurement(
  existing: ExistingOrder[],
  build: PoBuild,
  mapping: (PoColumnKey | null)[],
  tasks: DeliveryTask[] = [],
): PoDiff {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const has = (k: PoColumnKey) => mapping.includes(k);

  if (!has("po_number")) {
    blocking.push(
      "No column is mapped to PO number. It is the key every purchase order is matched on.",
    );
  }

  const byPo = new Map<string, ExistingOrder>();
  for (const e of existing) {
    if (e.po_number) byPo.set(e.po_number, e);
  }
  const taskByWbs = new Map(tasks.map((t) => [t.wbs_code, t]));

  const adds: PoImportRow[] = [];
  const changes: PoDiff["changes"] = [];
  const milestoneAdds: PoDiff["milestoneAdds"] = [];
  const milestoneChanges: PoDiff["milestoneChanges"] = [];
  let unchangedCount = 0;
  let unchangedMilestoneCount = 0;

  for (const row of build.rows) {
    const match = byPo.get(row.poNumber);
    const v = row.values;

    // A delivery task the project does not have cannot be linked. Dropping the
    // link and saying so beats failing the whole import over one cell, and
    // beats writing a link that points at nothing.
    let linkWbs = v.linked_delivery_task_wbs_code ?? null;
    if (linkWbs && !taskByWbs.has(linkWbs)) {
      warnings.push(
        `${row.poNumber} points at delivery task ${linkWbs}, which is not on this project's schedule. The PO imports without the link - import the schedule branch first, then run this again.`,
      );
      linkWbs = null;
    }
    const linkedDate = linkWbs ? (taskByWbs.get(linkWbs)?.end_date ?? null) : null;

    // The link wins over a typed delivery date, the same way it does on the PO
    // page: the point of the link is that the schedule drives the date.
    let expected = v.expected_delivery_date;
    if (linkedDate) {
      if (
        expected !== undefined &&
        expected !== null &&
        expected !== linkedDate
      ) {
        warnings.push(
          `${row.poNumber} has an expected delivery of ${expected} in the sheet and is linked to task ${linkWbs}, which finishes ${linkedDate}. The task wins, the same as it does on the PO page.`,
        );
      }
      expected = linkedDate;
    }

    const poTotal =
      v.total_value !== undefined && v.total_value !== null
        ? v.total_value
        : match
          ? (match.total_value === null ? null : Number(match.total_value))
          : null;

    // Milestone arithmetic, checked against the PO it hangs off. Both of these
    // are warnings, not blocks: a PO really can be part-scheduled, and a sheet
    // really can be mid-edit. They are worth saying out loud because neither
    // shows up anywhere afterwards.
    if (row.milestones.length && poTotal !== null && poTotal > 0) {
      const sum = row.milestones.reduce(
        (s, m) => s + (effectiveAmount(m.values, poTotal) ?? 0),
        0,
      );
      if (cents(sum)! > cents(poTotal)!) {
        warnings.push(
          `${row.poNumber}: its milestones add up to ${formatUsd(sum)} against a PO total of ${formatUsd(poTotal)}. The extra ${formatUsd(sum - poTotal)} would show as committed cost the PO does not carry.`,
        );
      }
    }
    if (
      row.milestones.length > 1 &&
      row.milestones.every((m) => m.values.pct_of_total !== null)
    ) {
      const pctSum = row.milestones.reduce((s, m) => s + (m.values.pct_of_total ?? 0), 0);
      if (Math.abs(pctSum - 100) > 0.5) {
        warnings.push(
          `${row.poNumber}: its milestone percentages add up to ${pctSum.toFixed(1)}%, not 100%.`,
        );
      }
    }

    // A payment recorded as already made with nothing to bank. The projection
    // drops a payment whose amount is not above zero and does so silently, so
    // an imported row like this would read as paid and carry no cost.
    for (const m of row.milestones) {
      const amt = effectiveAmount(m.values, poTotal);
      const rec = recordedPayment(amt, m.values.paid_at);
      if (!rec.ok) {
        blocking.push(
          `Row ${m.rowNumber} (${row.poNumber}, ${m.values.milestone_name}) has a paid date and no amount or %. ${rec.error}`,
        );
      }
    }

    if (!match) {
      if (!v.vendor_name) {
        blocking.push(
          `Row ${row.rowNumber} (${row.poNumber}) is a new purchase order with no vendor. A PO cannot be created without one.`,
        );
      }
      adds.push({
        ...row,
        values: {
          ...v,
          linked_delivery_task_wbs_code: linkWbs,
          expected_delivery_date: expected,
        },
      });
      continue;
    }

    const fields: PoFieldChange[] = [];
    const cmpText = (key: PoColumnKey, next: unknown, prev: unknown) => {
      if (next === undefined) return;
      if ((next ?? null) === (prev ?? null)) return;
      // An empty cell on a sheet is silence, not an instruction to erase what
      // is already recorded. Only a value that says something changes a field.
      if (next === null) return;
      fields.push({ field: key, from: prev, to: next });
    };

    cmpText("vendor_name", v.vendor_name, match.vendor_name);
    cmpText("description", v.description, match.description);
    cmpText("ordered_date", v.ordered_date, match.ordered_date);
    cmpText("expected_delivery_date", expected, match.expected_delivery_date);
    cmpText("actual_delivery_date", v.actual_delivery_date, match.actual_delivery_date);
    cmpText("status", v.status, match.status);
    cmpText("payment_terms_summary", v.payment_terms_summary, match.payment_terms_summary);
    cmpText("notes", v.notes, match.notes);
    cmpText("delivery_task_wbs", linkWbs, match.linked_delivery_task_wbs_code);

    if (
      has("total_value") &&
      v.total_value !== undefined &&
      v.total_value !== null &&
      !sameMoney(v.total_value, match.total_value === null ? null : Number(match.total_value))
    ) {
      fields.push({
        field: "total_value",
        from: match.total_value,
        to: v.total_value,
      });
    }

    // Lowering a PO total under what has already been paid against it. The PO
    // page reads paid against total, so this would show the PO over 100% paid
    // and understate the commitment the job is still carrying.
    const totalChange = fields.find((f) => f.field === "total_value");
    if (totalChange) {
      const paid = match.milestones.reduce((s, m) => s + Number(m.paid_amount ?? 0), 0);
      const next = Number(totalChange.to ?? 0);
      if (paid > 0 && cents(next)! < cents(paid)!) {
        warnings.push(
          `${row.poNumber} has ${formatUsd(paid)} already paid against it and this import drops its total to ${formatUsd(next)}. The PO would read as more than fully paid.`,
        );
      }
    }

    if (fields.length) changes.push({ existing: match, row, fields });
    else unchangedCount += 1;

    // Milestones match on name inside their own PO, case and spacing ignored.
    // Nothing is deleted: a milestone on the app that is missing from the sheet
    // is far more likely to be a filtered export than a cancelled payment.
    const existingByName = new Map(
      match.milestones.map((m) => [m.milestone_name.trim().toLowerCase(), m]),
    );
    for (const m of row.milestones) {
      const prev = existingByName.get(m.values.milestone_name.trim().toLowerCase());
      if (!prev) {
        milestoneAdds.push({
          poNumber: row.poNumber,
          orderId: match.id,
          rowNumber: m.rowNumber,
          values: { ...m.values, amount: effectiveAmount(m.values, poTotal) },
        });
        continue;
      }
      const mFields: MilestoneFieldChange[] = [];
      const cmpM = (
        field: keyof MilestoneValues,
        next: unknown,
        before: unknown,
        money = false,
      ) => {
        if (next === null || next === undefined) return;
        const same = money
          ? sameMoney(next as number, before as number)
          : (next ?? null) === (before ?? null);
        if (!same) mFields.push({ field, from: before, to: next });
      };
      cmpM("pct_of_total", m.values.pct_of_total, prev.pct_of_total);
      cmpM("trigger_event", m.values.trigger_event, prev.trigger_event);
      cmpM("expected_date", m.values.expected_date, prev.expected_date);
      cmpM("amount", effectiveAmount(m.values, poTotal), prev.amount, true);
      cmpM("paid_at", m.values.paid_at, prev.paid_at);
      cmpM("paid_amount", m.values.paid_amount, prev.paid_amount, true);
      cmpM("notes", m.values.notes, prev.notes);

      if (mFields.length) {
        milestoneChanges.push({
          poNumber: row.poNumber,
          id: prev.id,
          name: prev.milestone_name,
          fields: mFields,
        });
      } else {
        unchangedMilestoneCount += 1;
      }
    }
  }

  return {
    adds,
    changes,
    milestoneAdds,
    milestoneChanges,
    unchangedCount,
    unchangedMilestoneCount,
    blocking,
    warnings,
  };
}

export type MilestoneInsert = {
  milestone_name: string;
  pct_of_total: number | null;
  trigger_event: string | null;
  expected_date: string | null;
  amount: number | null;
  paid_at: string | null;
  paid_amount: number | null;
  sort_order: number | null;
  notes: string | null;
};

export type ProcurementImportPlan = {
  adds: {
    po_number: string;
    vendor_name: string;
    description: string | null;
    total_value: number | null;
    ordered_date: string | null;
    expected_delivery_date: string | null;
    actual_delivery_date: string | null;
    status: string;
    payment_terms_summary: string | null;
    notes: string | null;
    linked_delivery_task_wbs_code: string | null;
    milestones: MilestoneInsert[];
  }[];
  changes: { id: string; patch: Record<string, unknown> }[];
  milestoneAdds: { procurement_order_id: string; values: MilestoneInsert }[];
  milestoneChanges: { id: string; patch: Record<string, unknown> }[];
};

// The database column a mapped field writes to. Only delivery_task_wbs differs
// from its key, because the column name says what it is rather than what the
// spreadsheet calls it.
function dbField(field: PoColumnKey): string {
  return field === "delivery_task_wbs" ? "linked_delivery_task_wbs_code" : field;
}

function toInsert(values: MilestoneValues, poTotal: number | null): MilestoneInsert {
  const amount = effectiveAmount(values, poTotal);
  return {
    milestone_name: values.milestone_name,
    pct_of_total: values.pct_of_total,
    trigger_event: values.trigger_event,
    expected_date: values.expected_date,
    amount,
    paid_at: values.paid_at,
    // A milestone recorded as paid with no explicit paid amount banks the
    // amount it is worth. Leaving it null would date the cost correctly and
    // then count it as zero.
    paid_amount: values.paid_at ? (values.paid_amount ?? amount) : values.paid_amount,
    sort_order: values.sort_order,
    notes: values.notes,
  };
}

export function planFromPoDiff(diff: PoDiff): ProcurementImportPlan {
  return {
    adds: diff.adds.map((r) => {
      const total = r.values.total_value ?? null;
      return {
        po_number: r.poNumber,
        vendor_name: r.values.vendor_name ?? "",
        description: r.values.description ?? null,
        total_value: total,
        ordered_date: r.values.ordered_date ?? null,
        expected_delivery_date: r.values.expected_delivery_date ?? null,
        actual_delivery_date: r.values.actual_delivery_date ?? null,
        status: r.values.status ?? "active",
        payment_terms_summary: r.values.payment_terms_summary ?? null,
        notes: r.values.notes ?? null,
        linked_delivery_task_wbs_code: r.values.linked_delivery_task_wbs_code ?? null,
        milestones: r.milestones.map((m) => toInsert(m.values, total)),
      };
    }),
    changes: diff.changes.map((c) => {
      const patch: Record<string, unknown> = {};
      for (const f of c.fields) patch[dbField(f.field)] = f.to ?? null;
      return { id: c.existing.id, patch };
    }),
    milestoneAdds: diff.milestoneAdds.map((m) => ({
      procurement_order_id: m.orderId,
      // effectiveAmount was already applied when the add was built, so the
      // percentage is not applied a second time here.
      values: toInsert(m.values, null),
    })),
    milestoneChanges: diff.milestoneChanges.map((c) => {
      const patch: Record<string, unknown> = {};
      for (const f of c.fields) patch[f.field] = f.to ?? null;
      return { id: c.id, patch };
    }),
  };
}
