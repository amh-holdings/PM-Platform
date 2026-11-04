// The bid analyzer: bid rounds, the documents subs owe us, the bidder
// tracker and the leveling math. Pure - no Supabase, no server imports - so
// pages, actions and the test script share one definition.
//
// The runbook itself lives in Notion (Runbook - RFP to Submitted EPC Price).
// This file holds only what the app computes. A round is a new bid or a
// rebid on a BD opportunity, or a pre-construction reprice on a live project.

export const ROUND_KINDS = ["new_bid", "rebid", "preconstruction"] as const;
export type RoundKind = (typeof ROUND_KINDS)[number];
export const ROUND_KIND_LABEL: Record<RoundKind, string> = {
  new_bid: "New bid",
  rebid: "Rebid",
  preconstruction: "Pre-construction reprice",
};

// ------------------------------------------------------------ documents ----

export type DocStage = "with_bid" | "before_award" | "before_mobilization" | "supplier";
export type DocItem = { key: string; label: string };

export const DOC_STAGE_LABEL: Record<DocStage, string> = {
  with_bid: "With the bid",
  before_award: "Before award",
  before_mobilization: "Before mobilization",
  supplier: "Equipment supplier quote",
};

export const REQUIRED_DOCS: Record<DocStage, DocItem[]> = {
  with_bid: [
    { key: "bid_sheet", label: "Completed bid sheet (a PDF proposal alone is not a bid)" },
    { key: "cover_ack", label: "Signed Cover Sheet acknowledging Reference Documents and COI requirements" },
    { key: "quantity_basis", label: "Quantity basis on every countable line" },
    { key: "material_labor", label: "Material and labor, or labor only, per line" },
    { key: "labor_basis", label: "Labor basis: wage determination used, apprenticeship, per diem" },
    { key: "bond_basis", label: "Bond included or % adder, surety name and rating" },
    { key: "coi_current", label: "Current COI, insurance included" },
    { key: "state_license", label: "Copy of the state license and business registration" },
    { key: "exclusions", label: "Exclusions and clarifications list" },
    { key: "validity", label: "Validity 120 days minimum, escalation clauses stated" },
    { key: "schedule", label: "Install schedule, crew size, mobilization assumptions" },
    { key: "redlines", label: "Subcontract redlines or exceptions" },
    { key: "lower_tiers", label: "Lower-tier subs and suppliers" },
    { key: "safety", label: "EMR letter and OSHA 300A, last 3 years" },
    { key: "references", label: "Three comparable solar references" },
    { key: "payment_terms", label: "Payment terms requested" },
  ],
  before_award: [
    { key: "w9", label: "W-9" },
    { key: "safety_manual", label: "Health and safety manual" },
    { key: "financials", label: "Last 3 years of financials (large packages)" },
    { key: "owner_flowdowns", label: "Owner flow-downs: code of conduct, prohibited foreign entity, apprenticeship plan, qualification form" },
  ],
  before_mobilization: [
    { key: "subcontract", label: "Executed subcontract and signed schedule of values" },
    { key: "pp_bond", label: "Payment and performance bond at 100% (start at award, about 3 weeks)" },
    { key: "coi_endorsed", label: "Endorsed COI: AHC, Owner LLC, affiliates and lenders additional insured, primary and non-contributory, waiver of subrogation" },
    { key: "workers_comp", label: "Workers comp proof, hired and non-owned auto at minimum" },
    { key: "qaqc_plan", label: "Project-specific QA/QC plan, submittals and cut sheets" },
    { key: "baseline_schedule", label: "Baseline schedule within 7 days of notice to proceed" },
    { key: "lien_forms", label: "Lien waiver and sworn statement on the state forms" },
  ],
  supplier: [
    { key: "sup_pricing", label: "Unit and extended price delivered, freight and tax separate" },
    { key: "sup_lead_time", label: "Lead time from release and latest release date" },
    { key: "sup_submittals", label: "Manufacturer, model and submittal data per item" },
    { key: "sup_terms", label: "Warranty and payment terms" },
    { key: "sup_validity", label: "Validity 120 days, escalation and tariff exposure" },
    { key: "sup_pfe", label: "Prohibited foreign entity confirmation" },
    { key: "sup_order_terms", label: "Minimum order, cancellation and restocking terms" },
    { key: "sup_vendor_setup", label: "W-9, COI and credit application" },
  ],
};

export function docStagesFor(kind: string): DocStage[] {
  return kind === "supplier" ? ["supplier"] : ["with_bid", "before_award", "before_mobilization"];
}

/** The documents that make a bid complete: With the bid for subs, the quote list for suppliers. */
export function bidDocsFor(kind: string): DocItem[] {
  return kind === "supplier" ? REQUIRED_DOCS.supplier : REQUIRED_DOCS.with_bid;
}

export function missingDocs(kind: string, stage: DocStage, have: Iterable<string>): DocItem[] {
  const set = new Set(have);
  if (!docStagesFor(kind).includes(stage)) return [];
  return REQUIRED_DOCS[stage].filter((d) => !set.has(d.key));
}

// -------------------------------------------------------------- bidders ----

export const PACKAGES = [
  "civil",
  "mechanical",
  "electrical",
  "medium_voltage",
  "commissioning",
  "tracker_piles",
  "electrical_equipment",
  "scada",
  "met_station",
  "engineering",
  "other",
] as const;
export type RfpPackage = (typeof PACKAGES)[number];

export const PACKAGE_LABEL: Record<RfpPackage, string> = {
  civil: "Civil (fence, landscaping, survey staking)",
  mechanical: "Mechanical",
  electrical: "Electrical",
  medium_voltage: "Medium voltage",
  commissioning: "Commissioning",
  tracker_piles: "Tracker and pile supply",
  electrical_equipment: "Electrical equipment",
  scada: "SCADA",
  met_station: "Met station",
  engineering: "Engineering",
  other: "Other",
};

export const BIDDER_KINDS = ["sub", "supplier"] as const;
export const BIDDER_KIND_LABEL: Record<(typeof BIDDER_KINDS)[number], string> = {
  sub: "Subcontractor",
  supplier: "Supplier",
};

export const BIDDER_STATUSES = ["invited", "confirmed", "at_risk", "received", "carried", "declined"] as const;
export type BidderStatus = (typeof BIDDER_STATUSES)[number];
export const BIDDER_STATUS_LABEL: Record<BidderStatus, string> = {
  invited: "Invited",
  confirmed: "Intent confirmed",
  at_risk: "At risk",
  received: "Bid received",
  carried: "Carried",
  declined: "Declined",
};

export const DECLINE_REASONS = ["capacity", "schedule", "footprint", "license", "wage", "bonding", "scope", "unknown"] as const;
export const DECLINE_REASON_LABEL: Record<(typeof DECLINE_REASONS)[number], string> = {
  capacity: "Capacity / backlog",
  schedule: "Schedule",
  footprint: "Outside their footprint",
  license: "No state license",
  wage: "Wage basis",
  bonding: "Bonding",
  scope: "Scope fit",
  unknown: "No reason given",
};

/** Target and floor from the runbook: three per package, never fewer than two live. */
export const TARGET_BIDDERS = 3;
export const MIN_LIVE_BIDDERS = 2;
export const SILENT_DAYS = 14;
export const VALIDITY_WARN_DAYS = 14;
export const COVERAGE_WARN_DAYS = 14;

export type BidderLite = {
  id: string;
  firm: string;
  package: string;
  kind: string;
  status: string;
  invited_on: string | null;
  last_contact_on: string | null;
  validity_date: string | null;
  license_verified_on: string | null;
};

function daysFrom(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** Still in the running for the package: not declined. */
export function isLive(status: string): boolean {
  return status !== "declined";
}

/** Waiting on a number from them: invited, confirmed or at risk. */
export function isAwaitingBid(status: string): boolean {
  return status === "invited" || status === "confirmed" || status === "at_risk";
}

export type BidderFlag =
  | { kind: "silent"; days: number }
  | { kind: "validity_soon"; days: number }
  | { kind: "validity_lapsed"; days: number }
  | { kind: "license_unverified" };

/**
 * What needs attention on one bidder today. Silence counts from the last
 * contact, else the invite. Validity only matters once there is a number.
 * License applies to subs only: suppliers do not pull permits.
 */
export function bidderFlags(b: BidderLite, today: string): BidderFlag[] {
  const flags: BidderFlag[] = [];
  if (!isLive(b.status)) return flags;
  const since = b.last_contact_on ?? b.invited_on;
  if (isAwaitingBid(b.status) && since) {
    const days = daysFrom(since, today);
    if (days >= SILENT_DAYS) flags.push({ kind: "silent", days });
  }
  if ((b.status === "received" || b.status === "carried") && b.validity_date) {
    const days = daysFrom(today, b.validity_date);
    if (days < 0) flags.push({ kind: "validity_lapsed", days: -days });
    else if (days <= VALIDITY_WARN_DAYS) flags.push({ kind: "validity_soon", days });
  }
  if (b.kind === "sub" && !b.license_verified_on) flags.push({ kind: "license_unverified" });
  return flags;
}

export function flagText(f: BidderFlag): string {
  switch (f.kind) {
    case "silent":
      return `${f.days} days silent`;
    case "validity_soon":
      return f.days === 0 ? "Validity ends today" : `Validity ends in ${f.days} days`;
    case "validity_lapsed":
      return `Validity lapsed ${f.days} days ago`;
    case "license_unverified":
      return "State license not verified";
  }
}

export type PackageCoverage = {
  package: string;
  live: number;
  received: number;
  declined: number;
  /** Fewer than two live bidders. A price we cannot test. */
  thin: boolean;
  /** Below the target of three. */
  belowTarget: boolean;
};

/** Coverage per package that has at least one bidder, in PACKAGES order. */
export function packageCoverage(bidders: BidderLite[]): PackageCoverage[] {
  const by = new Map<string, BidderLite[]>();
  for (const b of bidders) by.set(b.package, [...(by.get(b.package) ?? []), b]);
  const order = (p: string) => {
    const i = (PACKAGES as readonly string[]).indexOf(p);
    return i === -1 ? PACKAGES.length : i;
  };
  return Array.from(by.entries())
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([pkg, list]) => {
      const live = list.filter((b) => isLive(b.status)).length;
      return {
        package: pkg,
        live,
        received: list.filter((b) => b.status === "received" || b.status === "carried").length,
        declined: list.filter((b) => b.status === "declined").length,
        thin: live < MIN_LIVE_BIDDERS,
        belowTarget: live < TARGET_BIDDERS,
      };
    });
}

/** Inside the last two weeks before bids are due, when a thin package needs a new invite now. */
export function coverageDeadlinePassed(bidDue: string | null, today: string): boolean {
  if (!bidDue) return false;
  return daysFrom(today, bidDue) <= COVERAGE_WARN_DAYS;
}

/** Two-letter state code, upper case, or null. "de" -> "DE", "Delaware" -> null. */
export function stateCode(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

export const STATE_FIELDS = [
  { key: "labor", label: "Labor: federal and state wage law, apprenticeship" },
  { key: "wage_determinations", label: "Wage determinations by county" },
  { key: "licensing", label: "Licensing: electrical, medium voltage, business registration, trade permits" },
  { key: "contractor_bond_tax", label: "Out-of-state contractor bond or tax" },
  { key: "sales_tax", label: "Sales and use tax" },
  { key: "lien_waivers", label: "Lien waivers and sworn statements" },
  { key: "stormwater", label: "Stormwater permit, agency, operator of record" },
  { key: "codes", label: "Codes in force" },
  { key: "other_reviews", label: "Fire marshal, DOT and other state reviews" },
  { key: "engineering", label: "Engineering: PE license and firm registration" },
  { key: "notes", label: "Notes" },
] as const;
export type StateFieldKey = (typeof STATE_FIELDS)[number]["key"];

/** The fields a usable profile cannot leave blank. Bids go out on these. */
export const STATE_REQUIRED_FIELDS: StateFieldKey[] = ["labor", "licensing", "contractor_bond_tax", "sales_tax"];

export function stateProfileGaps(profile: Partial<Record<StateFieldKey, string | null>> | null): StateFieldKey[] {
  if (!profile) return [...STATE_REQUIRED_FIELDS];
  return STATE_REQUIRED_FIELDS.filter((k) => !profile[k]?.trim());
}

// -------------------------------------------------------------- leveling ----
//
// Rules from the Sub Bid Comparison + Award runbook:
//   - Level at package level, not line by line.
//   - A blank line is excluded. Zero on the sheet is exposure, not savings,
//     so a package a bidder never priced is "not bid", never $0.
//   - A sub keeps its whole bid: carrying one package from a sub whose bid
//     covers others is flagged.
//   - Only confirmed extractions count. Claude reads, Phil confirms.

export type BidLineLite = { bidder_id: string; package: string; amount: number | null };

export type LevelBidder = { id: string; firm: string; confirmed: boolean };

export type LevelCell = { bidderId: string; amount: number | null; isLow: boolean };

export type LevelRow = {
  package: string;
  cells: LevelCell[];
  low: number | null;
  /** High minus low across bidders that priced the package. Null under two prices. */
  spread: number | null;
  baseline: number | null;
  carriedBidderId: string | null;
  carried: number | null;
  /** Carried minus baseline. Null if either is missing. */
  variance: number | null;
};

export type Leveling = {
  bidders: LevelBidder[];
  rows: LevelRow[];
  carriedTotal: number;
  baselineTotal: number;
  /** Packages with no carried price yet. The total is not a price until this is empty. */
  uncarried: string[];
  wholeScope: { bidderId: string; firm: string; carriedIn: string[]; pricedButNotCarried: string[] }[];
};

function packageOrder(p: string): number {
  const i = (PACKAGES as readonly string[]).indexOf(p);
  return i === -1 ? PACKAGES.length : i;
}

/** Sum of priced lines per bidder per package. Blank lines do not count. */
export function packageTotals(lines: BidLineLite[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const l of lines) {
    if (l.amount === null || l.amount === undefined) continue;
    const byPkg = out.get(l.bidder_id) ?? new Map<string, number>();
    byPkg.set(l.package, (byPkg.get(l.package) ?? 0) + Number(l.amount));
    out.set(l.bidder_id, byPkg);
  }
  return out;
}

export function level(input: {
  bidders: LevelBidder[];
  lines: BidLineLite[];
  /** Packages that must appear even with no bids: invited scope, estimates, mappings. */
  packages: string[];
  baseline: Map<string, number>;
  carried: Map<string, string | null>;
}): Leveling {
  const confirmed = input.bidders.filter((b) => b.confirmed);
  const ids = new Set(confirmed.map((b) => b.id));
  const totals = packageTotals(input.lines.filter((l) => ids.has(l.bidder_id)));

  const pkgs = new Set(input.packages);
  totals.forEach((byPkg) => byPkg.forEach((_v, p) => pkgs.add(p)));
  input.baseline.forEach((_v, p) => pkgs.add(p));
  const ordered = Array.from(pkgs).sort((a, b) => packageOrder(a) - packageOrder(b) || a.localeCompare(b));

  const rows: LevelRow[] = ordered.map((pkg) => {
    const amounts = confirmed.map((b) => totals.get(b.id)?.get(pkg) ?? null);
    const priced = amounts.filter((a): a is number => a !== null);
    const low = priced.length ? Math.min(...priced) : null;
    const spread = priced.length >= 2 ? Math.max(...priced) - Math.min(...priced) : null;
    const cells = confirmed.map((b, i) => ({
      bidderId: b.id,
      amount: amounts[i],
      isLow: priced.length >= 2 && amounts[i] === low,
    }));
    const carriedBidderId = input.carried.get(pkg) ?? null;
    const carried = carriedBidderId ? totals.get(carriedBidderId)?.get(pkg) ?? null : null;
    const baseline = input.baseline.has(pkg) ? input.baseline.get(pkg)! : null;
    return {
      package: pkg,
      cells,
      low,
      spread,
      baseline,
      carriedBidderId: carried === null ? null : carriedBidderId,
      carried,
      variance: carried !== null && baseline !== null ? carried - baseline : null,
    };
  });

  const wholeScope: Leveling["wholeScope"] = [];
  for (const b of confirmed) {
    const pricedPkgs = Array.from(totals.get(b.id)?.keys() ?? []);
    const carriedIn = rows.filter((r) => r.carriedBidderId === b.id).map((r) => r.package);
    if (!carriedIn.length) continue;
    const pricedButNotCarried = pricedPkgs.filter((p) => !carriedIn.includes(p));
    if (pricedButNotCarried.length) wholeScope.push({ bidderId: b.id, firm: b.firm, carriedIn, pricedButNotCarried });
  }

  return {
    bidders: confirmed,
    rows,
    carriedTotal: rows.reduce((n, r) => n + (r.carried ?? 0), 0),
    baselineTotal: rows.reduce((n, r) => n + (r.baseline ?? 0), 0),
    uncarried: rows.filter((r) => r.carried === null).map((r) => r.package),
    wholeScope,
  };
}

/** Extracted lines against the vendor's printed total. Within a dollar foots. */
export function footCheck(printed: number | null, lines: { amount: number | null }[]): {
  extracted: number;
  foots: boolean | null;
  difference: number | null;
} {
  const extracted = lines.reduce((n, l) => n + (l.amount === null ? 0 : Number(l.amount)), 0);
  if (printed === null) return { extracted, foots: null, difference: null };
  const difference = Math.round((extracted - printed) * 100) / 100;
  return { extracted, foots: Math.abs(difference) <= 1, difference };
}

/** Package budget on a live project: the sum of its mapped cost codes' estimated cost. */
export function costCodeBaseline(
  mappings: { package: string; cost_code_id: string }[],
  costCodes: { id: string; estimated_cost: number | null }[],
): Map<string, number> {
  const est = new Map(costCodes.map((c) => [c.id, Number(c.estimated_cost ?? 0)]));
  const out = new Map<string, number>();
  for (const m of mappings) out.set(m.package, (out.get(m.package) ?? 0) + (est.get(m.cost_code_id) ?? 0));
  return out;
}

/** Turns what Claude returns into lines we will store. Drops anything unusable. */
export function cleanExtractedLines(
  raw: unknown,
  fallbackPackage: string,
): { package: string; description: string; quantity: number | null; unit: string | null; amount: number | null; source_ref: string | null }[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const out = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const description = str(r.description);
    if (!description) continue;
    const pkg = str(r.package);
    out.push({
      package: pkg && (PACKAGES as readonly string[]).includes(pkg) ? pkg : fallbackPackage,
      description: description.slice(0, 500),
      quantity: num(r.quantity),
      unit: str(r.unit)?.slice(0, 40) ?? null,
      amount: num(r.amount),
      source_ref: str(r.source_ref)?.slice(0, 120) ?? null,
    });
  }
  return out;
}
