// The RFP workspace: the AHC RFP Process runbook, the documents subs owe us,
// and the bid tracker math. Pure - no Supabase, no server imports - so pages,
// actions and the test script share one definition.
//
// Source of truth for the words is the Notion card "RFP and Proposal Process -
// Map for Automation" and its runbook in the Runbook Library. Built from the
// Sweet Springs, Standard Solar and Sussex CSG 1 RFPs (2026). When the runbook
// changes, change it here and there together.
//
// Step keys are stored in rfp_step_checks. Never rename a key once it ships:
// a renamed key silently unchecks that step on every live bid. Add a new key
// and retire the old one instead.

export type RfpStep = { key: string; text: string };
export type RfpPhase = {
  key: string;
  num: string;
  title: string;
  /** Who does it. "Phil" marks a review gate. */
  owner: string;
  steps: RfpStep[];
  /** Guidance that is not a checkbox: how to do the steps well. */
  notes?: string[];
};

export const RFP_PHASES: RfpPhase[] = [
  {
    key: "intake",
    num: "1",
    title: "Intake",
    owner: "Zarina",
    steps: [
      { key: "intake.access", text: "Data room access for everyone on the bid" },
      { key: "intake.drive", text: "Drive: one parent folder, one subfolder per project, vendor folders per project" },
      { key: "intake.download", text: "Download everything, extract every zip, log the download date" },
      { key: "intake.client_form", text: "Check for a client bid breakdown or project breakout form. If issued, it governs how we submit" },
      { key: "intake.owner_split", text: "Confirm the Owner and JV split: Owner furnished equipment, Annex A labor, site general conditions" },
      { key: "intake.state_county", text: "Confirm the state and county of every site" },
    ],
    notes: ["Portfolios cross state lines. Livingston was called Virginia and is in Maryland."],
  },
  {
    key: "state",
    num: "1b",
    title: "State Profile",
    owner: "Zarina",
    steps: [
      { key: "state.profile", text: "State Profile exists and is current for every project state" },
      { key: "state.wage", text: "County Building and Heavy wage determinations pulled by number" },
      { key: "state.license", text: "Electrical and medium voltage licensing rules confirmed for the state" },
      { key: "state.bond_tax", text: "Out-of-state contractor bond or tax, sales tax and lien waiver forms confirmed" },
      { key: "state.block", text: "State Requirements block written into the sub email, Tab 1 Cover and Tab 6 Required Submittals" },
    ],
    notes: [
      "Projects 1 MWac and over carry Davis-Bacon and 15% registered apprenticeship at all tiers. Under 1 MWac, ask for an alternate price without it.",
      "Nothing state-specific lives in any other phase. It lives in the State Profile.",
    ],
  },
  {
    key: "analyze",
    num: "2",
    title: "Analyze the document set",
    owner: "Claude, Zarina checks",
    steps: [
      { key: "analyze.one_pass", text: "One pass in Claude across the full set" },
      { key: "analyze.fact_sheet", text: "Fact sheet: DC/AC, address, parcel, AHJ, utility and voltage, modules, strings, tracker, rows, piles, inverters, fence, GCR, acres" },
      { key: "analyze.consistency", text: "Consistency check: module count x wattage = DC size, drawing quantities match the permit set, every conflict flagged with both sources" },
      { key: "analyze.missing", text: "Missing document list verified by hand" },
      { key: "analyze.owner_rfi", text: "Numbered request for information sent to the Owner before the bid package goes out" },
    ],
  },
  {
    key: "package",
    num: "3",
    title: "Build the bid package",
    owner: "Zarina builds, Phil approves",
    steps: [
      { key: "package.scope", text: "Scope inventory: every work item with quantity and source sheet" },
      { key: "package.workbook", text: "Workbook tabs: Cover, Bid Instructions, Reference Documents, RFI Form, Bid Sheet, Required Submittals" },
      { key: "package.quantities", text: "Quantity on every countable line. Unit prices only for field conditions" },
      { key: "package.cost_lines", text: "Separate lines for bond, insurance, prevailing wage, apprenticeship, sales tax and state contractor bond or tax" },
      { key: "package.reference_docs", text: "Reference Documents carry geotech, IFC pile plan, tracker drawings and BOM, single line, fence detail, wage determinations, COI requirements, form of subcontract, schedule" },
      { key: "package.terms", text: "Bids due 10 business days, RFIs 5, validity 120 days. Labor basis from the State Profile stated" },
      { key: "package.phil_review", text: "Phil review: what we bid" },
    ],
    notes: [
      "Sections: A General Conditions, B Engineering, C Civil, D Procurement, E Structural and Mechanical, F Electrical, G Commissioning, H Commercial.",
      "One unified bid sheet. Blank line = excluded. New scope = new line. Unneeded lines marked not applicable, not deleted.",
      "Before sending: fill the RFI contact fields and click every link in the email.",
    ],
  },
  {
    key: "bidders",
    num: "4",
    title: "Build the bidder list",
    owner: "Zarina",
    steps: [
      { key: "bidders.three", text: "Three bidders per package, bench of two more" },
      { key: "bidders.license", text: "License check in the project state for every bidder, even known subs" },
      { key: "bidders.footprint", text: "Footprint check: the state is inside their operating area" },
      { key: "bidders.bonding", text: "Bonding capacity and surety rating, prevailing wage capability, NDA in place" },
    ],
  },
  {
    key: "issue",
    num: "5",
    title: "Issue",
    owner: "Zarina",
    steps: [
      { key: "issue.sub_email", text: "Sub email sent: link, scopes, due dates, submission requirements and the With the bid list in the body" },
      { key: "issue.equipment_rfq", text: "Equipment RFQ sent separately with the supplier quote list" },
      { key: "issue.logged", text: "Every send logged here and the vendor folder created" },
      { key: "issue.intent", text: "Intent to bid asked for within 3 business days" },
    ],
  },
  {
    key: "chase",
    num: "6",
    title: "Chase and collect",
    owner: "Zarina",
    steps: [
      { key: "chase.weekly", text: "Weekly check-in with every live bidder, same day each week" },
      { key: "chase.replace", text: "Every decline asked why and replaced from the bench the same week" },
      { key: "chase.coverage", text: "Two weeks before due: every package has at least two live bidders" },
      { key: "chase.filed", text: "Every returned file in the vendor folder and its documents checked off here" },
    ],
    notes: ["Silence is not a bid in progress. Two weeks of silence = at risk."],
  },
  {
    key: "extract",
    num: "7",
    title: "Extract",
    owner: "Claude, Zarina checks",
    steps: [
      { key: "extract.lines", text: "Every bid read line by line. A PDF proposal without the bid sheet is not a bid" },
      { key: "extract.foot", text: "Each bid reconciled to the vendor's printed total" },
      { key: "extract.quantity_basis", text: "Each bidder's quantity basis recorded" },
    ],
    notes: ["Common defects: amounts in the wrong column, freight or mobilization on the proposal but not the bid sheet, in-scope lines left blank, quantities priced on an old layout."],
  },
  {
    key: "level",
    num: "8",
    title: "Level",
    owner: "Claude builds",
    steps: [
      { key: "level.workbook", text: "Bid comparison workbook: YYYYMMDD_Project_AHC_BidComparison_R#" },
      { key: "level.whole_scope", text: "Whole-scope rule held: a sub keeps its whole bid, general conditions counted once" },
      { key: "level.material", text: "Material double count checked between installers and supplier packages" },
    ],
  },
  {
    key: "clarify",
    num: "9",
    title: "Clarify scope",
    owner: "Zarina",
    steps: [
      { key: "clarify.confirm", text: "Confirmed with every bidder: material or labor only, quantity basis, wage, apprenticeship, insurance, bonds, state license, validity" },
      { key: "clarify.excluded", text: "Excluded scope assigned to someone or carried as a named allowance" },
      { key: "clarify.answers", text: "Every bidder question answered to the whole package" },
    ],
    notes: ["Ask \"can you confirm this is in your scope,\" not \"please price.\" Short emails, bullets, no acronyms."],
  },
  {
    key: "negotiate",
    num: "10",
    title: "Negotiate",
    owner: "Phil",
    steps: [
      { key: "negotiate.unit_price", text: "High lines pushed by unit price, plus general conditions, then best overall number" },
    ],
    notes: ["Never name the other bidder or send their sheet. Call first, email confirms the call."],
  },
  {
    key: "history",
    num: "11",
    title: "Price unbid scope from history",
    owner: "Claude builds",
    steps: [
      { key: "history.list", text: "Every unbid line listed before any rollup" },
      { key: "history.allowances", text: "Priced from unit rates on the latest comparable job, labeled allowance with source and date" },
      { key: "history.variance", text: "Side by side against the prior project, every variance over 20% explained" },
    ],
  },
  {
    key: "price",
    num: "12",
    title: "Build the price",
    owner: "Phil approves",
    steps: [
      { key: "price.stack", text: "Carried sub per package plus allowances, AHC general conditions, insurance and bonds 2% plus any state contractor bond or tax" },
      { key: "price.benchmark", text: "$ per watt checked against a benchmark project" },
      { key: "price.frozen", text: "Price frozen and dated. Everything downstream cites it" },
    ],
  },
  {
    key: "review",
    num: "13",
    title: "Executive review",
    owner: "Phil",
    steps: [
      { key: "review.booked", text: "Meeting booked the day the price froze, backed off the Owner deadline and the shortest validity" },
      { key: "review.deck", text: "Seven-slide deck and bullet talk track sent 1 business day ahead" },
      { key: "review.outcome", text: "Outcome recorded in writing the same day" },
    ],
  },
  {
    key: "proposal",
    num: "14",
    title: "Proposal and submission",
    owner: "Zarina drafts, Phil approves",
    steps: [
      { key: "proposal.draft", text: "Proposal drafted after the price was approved" },
      { key: "proposal.foot", text: "Client form, proposal and approved price foot to one number" },
      { key: "proposal.exclusions", text: "Sub exclusions we don't carry are our exclusions. Allowances stated as qualifications" },
      { key: "proposal.internal_review", text: "Internal review by someone other than the author" },
      { key: "proposal.submitted", text: "Phil review, then submitted. Date, version and our validity logged" },
    ],
  },
  {
    key: "award",
    num: "15",
    title: "After award",
    owner: "Phil",
    steps: [
      { key: "award.subcontracts", text: "Subcontract scope written from the comparison and the confirmed clarifications" },
      { key: "award.open_items", text: "Each sub's open items locked before signing" },
      { key: "award.mobilization_docs", text: "Every carried sub's Before mobilization documents in hand" },
      { key: "award.pos", text: "Equipment POs released against lead times" },
    ],
  },
];

export const ALL_STEP_KEYS: string[] = RFP_PHASES.flatMap((p) => p.steps.map((s) => s.key));

export type PhaseProgress = { key: string; done: number; total: number; complete: boolean };

/** Done counts per phase, ignoring stored keys the runbook no longer has. */
export function phaseProgress(checked: Iterable<string>): PhaseProgress[] {
  const set = new Set(checked);
  return RFP_PHASES.map((p) => {
    const done = p.steps.filter((s) => set.has(s.key)).length;
    return { key: p.key, done, total: p.steps.length, complete: done === p.steps.length };
  });
}

/** The first phase with anything left. Null when the whole runbook is done. */
export function currentPhase(checked: Iterable<string>): RfpPhase | null {
  const progress = phaseProgress(checked);
  const i = progress.findIndex((p) => !p.complete);
  return i === -1 ? null : RFP_PHASES[i];
}

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
