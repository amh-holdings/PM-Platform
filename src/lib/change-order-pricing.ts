/**
 * Change order cost buildup and Exhibit H derivation.
 *
 * Pure math - no Supabase, no React - so it can be unit tested and reused by
 * the detail page, the CO list roll-ups, and the AFP.
 *
 * The buildup replaces the old single-lump model (one cost_amount, one blanket
 * profit_pct). Each cost line carries bare cost only. Markup is a single CO
 * level rate applied once to the direct cost total, which is how AHC prices
 * OH&P on a change order and how the owner expects to read it: a cost column
 * that ties to the quotes, then one markup line underneath.
 */

import { parseMoney, splitRow } from "@/lib/paste-table";

/**
 * The markup the contract allows: one overall rate on the direct cost total.
 * Not a default that invites tuning - the agreement permits this and nothing
 * more, so a CO priced above it is out of contract and the editor says so.
 */
export const CONTRACT_MARKUP_PCT = 10;

export const COST_CATEGORIES = [
  "labor",
  "material",
  "equipment",
  "subcontractor",
  "freight",
  "other",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<CostCategory, string> = {
  labor: "Labor",
  material: "Material",
  equipment: "Equipment",
  subcontractor: "Subcontractor",
  freight: "Freight",
  other: "Other",
};

export type CostLine = {
  id: string;
  sortOrder: number | null;
  category: CostCategory;
  description: string;
  vendorName: string | null;
  quantity: number;
  unit: string | null;
  unitCost: number;
  costCodeId: string | null;
  notes: string | null;
  /**
   * Whether this line is in the markup base.
   *
   * A boolean, never a rate. Per-line rates were the old model and they are not
   * coming back - see the note on `markup` below. But a permit paid at cost, a
   * tax line, or an owner-direct purchase AHC only administers is not
   * markup-bearing at all, and the only ways to handle that before this were to
   * leave the cost off the buildup, which hides it from the owner's cost
   * column, or to drop the whole CO's rate, which under-marks up everything
   * else.
   */
  markupApplies: boolean;
};

/**
 * How the opt-out is stored, without a schema change.
 *
 * `change_order_cost_lines.markup_pct` was created by 0046 for the per-line
 * RATE model that the same migration then abandoned. Nothing has read it since
 * and the app wrote null into it on every save, so it was free:
 *
 *   0     held out of the markup base
 *   null  bears the change order's markup
 *
 * Which is the literal reading of the column, not a repurposing - a line whose
 * markup rate is zero earns no markup.
 *
 * ANY OTHER VALUE READS AS "BEARS MARKUP". A rate written from outside the app
 * is ignored rather than honoured, because a per-line rate is the thing 0046
 * removed and reviving it here through the back door would put a sum of
 * rounded products in front of the owner. That is also exactly how such a row
 * behaved before this feature existed, so nothing regresses.
 */
export function markupAppliesFromRate(rate: number | string | null | undefined): boolean {
  if (rate == null) return true;
  return Number(rate) !== 0;
}

/** The inverse, for writing. */
export function rateFromMarkupApplies(markupApplies: boolean): number | null {
  return markupApplies ? null : 0;
}

export type PricedLine = CostLine & {
  /** quantity x unitCost. A line is cost only - markup is not per line. */
  extendedCost: number;
};

export type BuildupInput = {
  lines: CostLine[];
  /** The one markup rate, applied to the direct cost total. */
  markupPct: number | null;
  /** Percent of (direct cost + markup). Null or 0 means no bond line. */
  bondPct: number | null;
  /** Percent of (direct cost + markup). Null or 0 means no tax line. */
  taxPct: number | null;
};

export type Buildup = {
  lines: PricedLine[];
  /** Sum of every line's extendedCost, markup-bearing or not. */
  directCost: number;
  /** The part of directCost the markup is computed on. */
  markupableCost: number;
  /** The part held out of the markup base. directCost - markupableCost. */
  excludedCost: number;
  /** How many lines are held out, for the editor to report without recounting. */
  excludedLineCount: number;
  /** The rate that produced `markup`. 0 when the CO sets none. */
  markupPct: number;
  /** markupableCost x markupPct. This is the CO's profit. */
  markup: number;
  /** directCost + markup. Bond and tax are computed off this. */
  subtotal: number;
  bond: number;
  tax: number;
  /** What the owner is billed: subtotal + bond + tax. Becomes co_value. */
  billable: number;
  /**
   * AHC's real outlay. Bond and tax are pass-through costs, not margin, so
   * they land here rather than inflating profit.
   */
  totalCost: number;
  /** billable - totalCost. Equals markup by construction. */
  profit: number;
  /** profit / totalCost as a percent, or null when there is no cost. */
  effectiveMarginPct: number | null;
  /** Cost by category. Markup is not split across categories - it sits once
   *  on the total - so there is no per-category billable to report. */
  byCategory: Array<{ category: CostCategory; cost: number }>;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function priceBuildup(input: BuildupInput): Buildup {
  const markupPct = input.markupPct ?? 0;

  const lines: PricedLine[] = input.lines.map((l) => ({
    ...l,
    extendedCost: round2(l.quantity * l.unitCost),
  }));

  const directCost = round2(lines.reduce((s, l) => s + l.extendedCost, 0));
  // The base is every line that bears markup. Lines held out still count toward
  // direct cost and toward what the owner is billed - they are excluded from
  // the multiplication, not from the change order.
  const markupable = lines.filter((l) => l.markupApplies);
  const markupableCost = round2(markupable.reduce((s, l) => s + l.extendedCost, 0));
  const excludedCost = round2(directCost - markupableCost);
  // Once, on the base. Marking up each line and summing the results is the same
  // number only when every line shares a rate, and it rounds per line, so the
  // total the owner sees would drift by pennies from cost x rate. Holding a
  // line out changes WHAT is multiplied, never how many times.
  const markup = round2(markupableCost * (markupPct / 100));
  const subtotal = round2(directCost + markup);
  const bond = round2(subtotal * ((input.bondPct ?? 0) / 100));
  const tax = round2(subtotal * ((input.taxPct ?? 0) / 100));
  const billable = round2(subtotal + bond + tax);
  const totalCost = round2(directCost + bond + tax);
  const profit = round2(billable - totalCost);

  const byCategory = COST_CATEGORIES.map((category) => ({
    category,
    cost: round2(
      lines.filter((l) => l.category === category).reduce((s, l) => s + l.extendedCost, 0),
    ),
  })).filter((c) => c.cost !== 0);

  return {
    lines,
    directCost,
    markupableCost,
    excludedCost,
    excludedLineCount: lines.length - markupable.length,
    markupPct,
    markup,
    subtotal,
    bond,
    tax,
    billable,
    totalCost,
    profit,
    effectiveMarginPct: totalCost > 0 ? round2((profit / totalCost) * 100) : null,
    byCategory,
  };
}

/* ------------------------------------------------------------------ */
/* Exhibit H                                                           */
/* ------------------------------------------------------------------ */

export type ExhibitHProject = {
  name: string;
  client: string | null;
  contractorLegalName: string | null;
  agreementDate: string | null;
  originalContractValue: number | null;
  /** Current contract price, used only as a fallback for the original. */
  contractValue: number | null;
  guaranteedMechanicalCompletionDate: string | null;
  /** Sits between the other two on the owner's form. Migration 0052. */
  guaranteedPlacedInServiceDate: string | null;
  guaranteedSubstantialCompletionDate: string | null;
};

export type ExhibitHCo = {
  coNumber: string;
  dateOfChangeOrder: string | null;
  billable: number;
  mechCompletionDeltaDays: number | null;
  pisCompletionDeltaDays: number | null;
  substCompletionDeltaDays: number | null;
};

/** Any other CO on the project, used to compute Exhibit H line 2. */
export type PriorCo = {
  id: string;
  coNumber: string;
  coValue: number;
  status: string;
};

export type ExhibitH = {
  projectName: string;
  owner: string;
  contractor: string;
  coNumber: string;
  dateOfChangeOrder: string | null;
  agreementDate: string | null;
  /** Line 1. */
  originalContractPrice: number | null;
  /** True when line 1 fell back to the current contract value. */
  originalContractPriceIsFallback: boolean;
  /** Line 2 amount and the CO numbers that make it up. */
  netPreviousChangeOrders: number;
  previousChangeOrderNumbers: string[];
  /** Line 3 = line 1 + line 2. */
  contractPricePriorToThisCo: number | null;
  /** Line 4. Sign carries the increase / decrease. */
  thisChangeOrderAmount: number;
  direction: "increased" | "decreased" | "unchanged";
  /** Line 5 = line 3 + line 4. */
  newContractPrice: number | null;
  mechanical: CompletionAdjustment;
  placedInService: CompletionAdjustment;
  substantial: CompletionAdjustment;
  /** Fields Exhibit H needs that the project record does not yet carry. */
  missing: string[];
};

export type CompletionAdjustment = {
  currentDate: string | null;
  deltaDays: number | null;
  direction: "increased" | "decreased" | "unchanged";
  revisedDate: string | null;
};

/**
 * CO numbers in the order the owner's records read them, digits as numbers so
 * CO-9 comes before CO-10.
 */
export function compareCoNumbers(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Adds whole days to a YYYY-MM-DD string without tripping over timezones. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function adjust(currentDate: string | null, deltaDays: number | null): CompletionAdjustment {
  const direction =
    deltaDays == null || deltaDays === 0 ? "unchanged" : deltaDays > 0 ? "increased" : "decreased";
  return {
    currentDate,
    deltaDays,
    direction,
    revisedDate:
      currentDate && deltaDays != null ? addDays(currentDate, deltaDays) : currentDate,
  };
}

/**
 * Builds every number and date Exhibit H asks for. Deliberately does NOT
 * render the form - Phil fills out the owner's document by hand and copies
 * these values across.
 *
 * Line 2 counts only APPROVED change orders, which is the form's
 * "previously authorized" wording. A CO still in review is not authorized and
 * must not move the contract price.
 */
export function deriveExhibitH(
  project: ExhibitHProject,
  co: ExhibitHCo,
  priorCos: PriorCo[],
): ExhibitH {
  // PREVIOUSLY authorized, not "every other approved CO on the project".
  //
  // This summed every approved change order except this one, in both
  // directions, so CO-01's form reported the net of CO-02 through CO-06 -
  // change orders that did not exist when CO-01 was written - and its line 5
  // came out at the project's current contract price rather than the price
  // CO-01 actually produced. Every form but the newest was wrong, and each one
  // is a document that went to the owner.
  //
  // Ordered by CO number rather than by approval date. That is the sequence
  // the owner's records follow, it is the list this very line prints, and it
  // gives the property the form depends on: each CO's line 5 equals the next
  // CO's line 3, so the set of forms telescopes from the original contract
  // price to the current one.
  //
  // Still approved-only. A CO in review has not been authorized and must not
  // move the contract price.
  const approved = priorCos
    .filter((p) => p.status === "approved")
    .filter((p) => compareCoNumbers(p.coNumber, co.coNumber) < 0)
    .sort((a, b) => compareCoNumbers(a.coNumber, b.coNumber));

  const netPreviousChangeOrders = round2(approved.reduce((s, p) => s + p.coValue, 0));

  const originalContractPriceIsFallback =
    project.originalContractValue == null && project.contractValue != null;
  const originalContractPrice =
    project.originalContractValue ?? (originalContractPriceIsFallback ? project.contractValue : null);

  const contractPricePriorToThisCo =
    originalContractPrice != null ? round2(originalContractPrice + netPreviousChangeOrders) : null;

  const thisChangeOrderAmount = round2(co.billable);
  const newContractPrice =
    contractPricePriorToThisCo != null
      ? round2(contractPricePriorToThisCo + thisChangeOrderAmount)
      : null;

  const missing: string[] = [];
  if (project.originalContractValue == null) missing.push("Original contract price");
  if (!project.agreementDate) missing.push("Date of agreement");
  if (!project.guaranteedMechanicalCompletionDate)
    missing.push("Guaranteed Mechanical Completion Date");
  // Only reported missing once the CO actually moves it. A project with no PIS
  // date is ordinary - not every agreement names one - and listing it on every
  // change order would train Phil to ignore the missing-fields list.
  if (
    !project.guaranteedPlacedInServiceDate &&
    (co.pisCompletionDeltaDays ?? 0) !== 0
  ) {
    missing.push("Guaranteed Placed-in-Service Date");
  }
  if (!project.guaranteedSubstantialCompletionDate)
    missing.push("Guaranteed Substantial Completion Date");
  if (!co.dateOfChangeOrder) missing.push("Date of change order");

  return {
    projectName: project.name,
    owner: project.client ?? "",
    contractor: project.contractorLegalName ?? "American Helios Constructors (AHC)",
    coNumber: co.coNumber,
    dateOfChangeOrder: co.dateOfChangeOrder,
    agreementDate: project.agreementDate,
    originalContractPrice,
    originalContractPriceIsFallback,
    netPreviousChangeOrders,
    previousChangeOrderNumbers: approved.map((p) => p.coNumber),
    contractPricePriorToThisCo,
    thisChangeOrderAmount,
    direction:
      thisChangeOrderAmount > 0 ? "increased" : thisChangeOrderAmount < 0 ? "decreased" : "unchanged",
    newContractPrice,
    mechanical: adjust(project.guaranteedMechanicalCompletionDate, co.mechCompletionDeltaDays),
    placedInService: adjust(project.guaranteedPlacedInServiceDate, co.pisCompletionDeltaDays),
    substantial: adjust(project.guaranteedSubstantialCompletionDate, co.substCompletionDeltaDays),
    missing,
  };
}

/* ------------------------------------------------------------------ */
/* Workflow                                                            */
/* ------------------------------------------------------------------ */

export const CO_STATUSES = [
  "draft",
  "internal_review",
  "submitted",
  "approved",
  "rejected",
  "void",
] as const;
export type CoStatus = (typeof CO_STATUSES)[number];

export const CO_STATUS_LABELS: Record<CoStatus, string> = {
  draft: "Draft",
  internal_review: "Internal review",
  submitted: "Submitted to owner",
  approved: "Approved",
  rejected: "Rejected",
  void: "Void",
};

/** Which statuses each status may move to. */
export const CO_TRANSITIONS: Record<CoStatus, CoStatus[]> = {
  draft: ["internal_review", "void"],
  internal_review: ["draft", "submitted", "void"],
  submitted: ["approved", "rejected", "internal_review"],
  // Reopening an approved CO is possible but pulls it back out of the contract
  // value and off the AFP, so it routes through internal_review deliberately.
  approved: ["internal_review", "void"],
  rejected: ["internal_review", "void"],
  void: ["draft"],
};

/**
 * What a change order is still missing before anyone can approve it, or null
 * when it is ready.
 *
 * The rule used to be "at least one cost line", which assumed every change
 * order is about money. Most are. A time-only CO is not: it moves a guaranteed
 * completion date and carries no cost at all, and under the old rule it could
 * be drafted and submitted but never approved, so it sat in the owner's queue
 * forever with the Approve button greyed out and a tooltip telling Phil to add
 * a cost line that does not exist.
 *
 * So the question is whether the CO changes ANYTHING the contract cares about:
 * priced scope, or the schedule.
 *
 * `coValue !== 0` rather than `> 0` on purpose. A credit change order is
 * negative and is still priced scope - the old check quietly blocked those too.
 */
export function coApprovalBlocker(co: {
  hasCostLines: boolean;
  coValue: number;
  mechCompletionDeltaDays: number | null;
  pisCompletionDeltaDays?: number | null;
  substCompletionDeltaDays: number | null;
}): string | null {
  if (co.hasCostLines || co.coValue !== 0) return null;
  const movesTime =
    (co.mechCompletionDeltaDays ?? 0) !== 0 ||
    (co.pisCompletionDeltaDays ?? 0) !== 0 ||
    (co.substCompletionDeltaDays ?? 0) !== 0;
  if (movesTime) return null;
  return "Add a cost line, or a completion date change on the Exhibit H panel, before approving.";
}

/**
 * Whether a change order may be deleted outright rather than voided.
 *
 * Void and draft only. An approved CO is in the contract value and on the
 * owner's G703, a submitted one is in their hands, and a rejected one is the
 * record of a decision they made - deleting any of those loses history the
 * project is answerable for. Void already means withdrawn, and a draft never
 * left the building.
 */
export function canDeleteCo(status: string): boolean {
  return status === "void" || status === "draft";
}

export function canTransition(from: string, to: string): boolean {
  const list = CO_TRANSITIONS[from as CoStatus];
  return Array.isArray(list) && list.includes(to as CoStatus);
}

/** Only an approved CO moves contract value and earns an SOV line on the AFP. */
export function countsTowardContract(status: string): boolean {
  return status === "approved";
}

/* ------------------------------------------------------------------ */
/* Bulk entry                                                          */
/* ------------------------------------------------------------------ */

export type ParsedCostLine = {
  category: CostCategory;
  description: string;
  vendorName: string | null;
  quantity: number;
  unit: string | null;
  unitCost: number;
  /** False when the pasted markup column said zero for this row. */
  markupApplies: boolean;
};

export type ParseResult = {
  lines: ParsedCostLine[];
  /** One entry per input row that could not be used, with the reason. */
  skipped: Array<{ row: number; text: string; reason: string }>;
  /** True when a header row was detected and used to map columns. */
  usedHeader: boolean;
  /**
   * True when the paste carried a NON-ZERO markup rate. The column is still
   * read, so the columns after it land in the right fields, but a rate is
   * dropped: markup is one CO-level rate, not a per-line number. Say so rather
   * than letting a pasted 15% quietly disappear.
   *
   * A zero in that column is not dropped. It is the spreadsheet saying this
   * line does not bear markup, which the buildup can now honour, so the row
   * comes back with markupApplies false and nothing is flagged.
   */
  ignoredMarkupColumn: boolean;
};

const HEADER_ALIASES: Record<string, string[]> = {
  description: ["description", "desc", "item", "scope", "work"],
  vendorName: ["vendor", "sub", "subcontractor", "supplier", "company"],
  quantity: ["qty", "quantity", "count"],
  unit: ["unit", "uom", "units"],
  unitCost: ["unit cost", "unitcost", "rate", "unit price", "price", "cost", "each"],
  markupPct: ["markup", "markup %", "markup%", "margin", "oh&p", "ohp"],
  category: ["category", "type", "cat"],
};

const CATEGORY_ALIASES: Record<string, CostCategory> = {
  labor: "labor",
  labour: "labor",
  material: "material",
  materials: "material",
  equipment: "equipment",
  equip: "equipment",
  rental: "equipment",
  subcontractor: "subcontractor",
  sub: "subcontractor",
  subs: "subcontractor",
  freight: "freight",
  shipping: "freight",
  delivery: "freight",
  other: "other",
};

function matchHeader(cells: string[]): Record<string, number> | null {
  const map: Record<string, number> = {};
  cells.forEach((cell, i) => {
    const c = cell.toLowerCase().replace(/[_-]+/g, " ").trim();
    if (!c) return;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] != null) continue;
      if (aliases.includes(c)) map[field] = i;
    }
  });
  // A description column plus one number column is enough to trust the row as
  // a header. Anything less and it is probably just the first data row.
  const hasNumber = map.unitCost != null || map.quantity != null;
  return map.description != null && hasNumber ? map : null;
}

/**
 * Parses cost lines pasted out of a spreadsheet.
 *
 * A CO buildup gets assembled in Excel long before it reaches this app, so
 * retyping it row by row is the slow path. Column order is read from a header
 * row when there is one; otherwise it falls back to the positional order the
 * paste box documents.
 *
 * Rows that cannot be read are reported rather than dropped - silently losing
 * a line from a buildup is how a CO gets submitted short.
 *
 * A markup column is recognized so the columns around it still map correctly.
 * A rate in it is discarded and flagged, because the CO carries one rate. A
 * ZERO in it is kept, as the row opting out of the markup base.
 */
export function parsePastedCostLines(
  text: string,
  defaultCategory: CostCategory = "material",
): ParseResult {
  const rows = text
    .split(/\r?\n/)
    .map((r) => r.replace(/\s+$/, ""))
    .filter((r) => r.trim().length > 0);

  const lines: ParsedCostLine[] = [];
  const skipped: ParseResult["skipped"] = [];
  let ignoredMarkupColumn = false;
  if (rows.length === 0)
    return { lines, skipped, usedHeader: false, ignoredMarkupColumn };

  const headerMap = matchHeader(splitRow(rows[0]));
  const usedHeader = headerMap != null;
  // Positional fallback, matching the order shown in the paste box.
  const positional: Record<string, number> = {
    description: 0,
    quantity: 1,
    unit: 2,
    unitCost: 3,
    markupPct: 4,
    vendorName: 5,
    category: 6,
  };
  const map = headerMap ?? positional;

  const dataRows = usedHeader ? rows.slice(1) : rows;

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

    const unitCost = parseMoney(at("unitCost"));
    if (unitCost == null) {
      skipped.push({ row: rowNumber, text: row, reason: "No readable unit cost" });
      return;
    }

    // A blank quantity means one of whatever it is, which is how a lump-sum
    // quote line gets pasted.
    const quantity = parseMoney(at("quantity")) ?? 1;
    // Zero means "no markup on this one" and is honoured. Any other rate is a
    // per-line rate the buildup does not carry, so it is dropped and reported.
    const pastedMarkup = parseMoney(at("markupPct"));
    const markupApplies = pastedMarkup !== 0;
    if (pastedMarkup != null && pastedMarkup !== 0) ignoredMarkupColumn = true;

    const rawCategory = at("category").toLowerCase().trim();
    const category = CATEGORY_ALIASES[rawCategory] ?? defaultCategory;

    lines.push({
      category,
      description,
      vendorName: at("vendorName").trim() || null,
      quantity,
      unit: at("unit").trim() || null,
      unitCost,
      markupApplies,
    });
  });

  return { lines, skipped, usedHeader, ignoredMarkupColumn };
}

/* ------------------------------------------------------------------ */
/* Numbering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Picks the next CO number for a project by following whatever convention the
 * existing ones already use - prefix, separator and zero padding included.
 *
 * Always max + 1, never the first gap. Sweet Springs runs CO-01, CO-02, CO-04,
 * CO-05, CO-06: the missing CO-03 is a number that was used and withdrawn, not
 * a slot to reuse. Handing it out again would put two different scopes under
 * one number in the owner's records.
 */
export function nextCoNumber(existing: string[]): string {
  let bestPrefix = "CO-";
  let bestWidth = 2;
  let max = 0;
  let sawAny = false;

  for (const raw of existing) {
    const m = /^(.*?)(\d+)\s*$/.exec((raw ?? "").trim());
    if (!m) continue;
    const [, prefix, digits] = m;
    const value = Number(digits);
    if (!Number.isFinite(value)) continue;
    sawAny = true;
    if (value >= max) {
      max = value;
      bestPrefix = prefix;
      bestWidth = digits.length;
    }
  }

  const next = max + 1;
  // Keep the existing padding, but never truncate once the count outgrows it.
  const width = sawAny ? bestWidth : 2;
  return `${bestPrefix}${String(next).padStart(width, "0")}`;
}
