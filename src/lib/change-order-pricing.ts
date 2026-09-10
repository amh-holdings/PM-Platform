/**
 * Change order cost buildup and Exhibit H derivation.
 *
 * Pure math - no Supabase, no React - so it can be unit tested and reused by
 * the detail page, the CO list roll-ups, and the AFP.
 *
 * The buildup replaces the old single-lump model (one cost_amount, one blanket
 * profit_pct). Each cost line prices its own scope; markup is per line with the
 * CO's profit_pct as the fallback, which is what lets a 5% pass-through on a
 * sub quote sit next to 10% on self-perform work in the same CO.
 */

import { parseMoney, splitRow } from "@/lib/paste-table";

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
  /** null means "inherit the CO's default markup". */
  markupPct: number | null;
  costCodeId: string | null;
  notes: string | null;
};

export type PricedLine = CostLine & {
  /** quantity x unitCost */
  extendedCost: number;
  /** markupPct, or the CO default when the line does not override it. */
  effectiveMarkupPct: number;
  /** Whether effectiveMarkupPct came from the CO default rather than the line. */
  markupInherited: boolean;
  markupDollars: number;
  /** extendedCost + markupDollars */
  billable: number;
};

export type BuildupInput = {
  lines: CostLine[];
  /** CO-level default markup applied to lines that do not set their own. */
  defaultMarkupPct: number | null;
  /** Percent of (direct cost + markup). Null or 0 means no bond line. */
  bondPct: number | null;
  /** Percent of (direct cost + markup). Null or 0 means no tax line. */
  taxPct: number | null;
};

export type Buildup = {
  lines: PricedLine[];
  /** Sum of every line's extendedCost. */
  directCost: number;
  /** Sum of every line's markupDollars. This is the CO's profit. */
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
  byCategory: Array<{ category: CostCategory; cost: number; billable: number }>;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function priceBuildup(input: BuildupInput): Buildup {
  const fallback = input.defaultMarkupPct ?? 0;

  const lines: PricedLine[] = input.lines.map((l) => {
    const extendedCost = round2(l.quantity * l.unitCost);
    const markupInherited = l.markupPct == null;
    const effectiveMarkupPct = markupInherited ? fallback : (l.markupPct as number);
    const markupDollars = round2(extendedCost * (effectiveMarkupPct / 100));
    return {
      ...l,
      extendedCost,
      effectiveMarkupPct,
      markupInherited,
      markupDollars,
      billable: round2(extendedCost + markupDollars),
    };
  });

  const directCost = round2(lines.reduce((s, l) => s + l.extendedCost, 0));
  const markup = round2(lines.reduce((s, l) => s + l.markupDollars, 0));
  const subtotal = round2(directCost + markup);
  const bond = round2(subtotal * ((input.bondPct ?? 0) / 100));
  const tax = round2(subtotal * ((input.taxPct ?? 0) / 100));
  const billable = round2(subtotal + bond + tax);
  const totalCost = round2(directCost + bond + tax);
  const profit = round2(billable - totalCost);

  const byCategory = COST_CATEGORIES.map((category) => {
    const inCat = lines.filter((l) => l.category === category);
    return {
      category,
      cost: round2(inCat.reduce((s, l) => s + l.extendedCost, 0)),
      billable: round2(inCat.reduce((s, l) => s + l.billable, 0)),
    };
  }).filter((c) => c.cost !== 0 || c.billable !== 0);

  return {
    lines,
    directCost,
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
  guaranteedSubstantialCompletionDate: string | null;
};

export type ExhibitHCo = {
  coNumber: string;
  dateOfChangeOrder: string | null;
  billable: number;
  mechCompletionDeltaDays: number | null;
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
  const approved = priorCos
    .filter((p) => p.status === "approved")
    .sort((a, b) => a.coNumber.localeCompare(b.coNumber, undefined, { numeric: true }));

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
  markupPct: number | null;
};

export type ParseResult = {
  lines: ParsedCostLine[];
  /** One entry per input row that could not be used, with the reason. */
  skipped: Array<{ row: number; text: string; reason: string }>;
  /** True when a header row was detected and used to map columns. */
  usedHeader: boolean;
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
  if (rows.length === 0) return { lines, skipped, usedHeader: false };

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
    const markupPct = parseMoney(at("markupPct"));

    const rawCategory = at("category").toLowerCase().trim();
    const category = CATEGORY_ALIASES[rawCategory] ?? defaultCategory;

    lines.push({
      category,
      description,
      vendorName: at("vendorName").trim() || null,
      quantity,
      unit: at("unit").trim() || null,
      unitCost,
      markupPct,
    });
  });

  return { lines, skipped, usedHeader };
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
