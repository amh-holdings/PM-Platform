// Exhibit S: the EPC list of required deliverables, and the file name each
// one must carry in the owner's data room.
//
// Phil: "build a submittal checklist according to exhibit S, it should
// suggest as well file name". The exhibit lists every document by the name it
// must be uploaded under, built from one rule:
//
//   Project SPV_Item description_Status_vYYYY-MM-DD
//
// where Status (PX for a partially executed certificate) appears only on
// documents that need a signature. Everything else drops it:
//
//   Project SPV_Item description_vYYYY-MM-DD
//
// Exhibit GG is the device naming convention (MVSG 1, MVT 1, IN 1.1.1, CB
// 1.1.1, 1.1.MS). It names equipment, not files, so it comes in only where
// Exhibit S asks for one file per device: the inverter, transformer,
// switchgear and met station photos in Part III. There the device ID goes in
// parentheses after the item, the way Exhibit S writes "Switchgear ID Label
// (Gear ID)", so two inverters' photos never share a file name.
//
// This file is the catalog and the naming rule, nothing else. Pure, so the
// page and the tests use the same names.

export type DeliverablePart = "I" | "II" | "III";

export const PART_LABEL: Record<DeliverablePart, string> = {
  I: "Part I - Due prior to Mechanical Completion",
  II: "Part II - Due prior to Substantial Completion",
  III: "Part III - Due prior to Final Completion",
};

/**
 * How the per-device rows are named. The Exhibit GG ones are checked against
 * the convention; the free-text ones (a piece of equipment, a road) are not.
 */
export type DeviceKind = "IN" | "MVT" | "MVSG" | "MS" | "equipment" | "road" | "period";

export const DEVICE_HINT: Record<DeviceKind, string> = {
  IN: "Exhibit GG inverter ID, e.g. IN 1.1.1",
  MVT: "Exhibit GG transformer ID, e.g. MVT 1",
  MVSG: "Exhibit GG switchgear ID, e.g. MVSG 1",
  MS: "Exhibit GG met station ID, e.g. 1.1.MS",
  equipment: "The equipment, e.g. Inverter",
  road: "Road name, or N-S-E-W from site if it has none",
  period: "The date of the report",
};

const DEVICE_PATTERN: Partial<Record<DeviceKind, RegExp>> = {
  IN: /^IN \d+\.\d+\.\d+$/,
  MVT: /^MVT \d+$/,
  MVSG: /^(MVSG \d+|New Customer Pole #\d+)$/,
  MS: /^\d+\.\d+\.MS$/,
};

export type CatalogItem = {
  /** Stable across releases: rows on file are matched to the catalog by it. */
  key: string;
  part: DeliverablePart;
  /** The Exhibit S folder, numbered as the exhibit numbers it. */
  section: string;
  /** The item description exactly as Exhibit S spells it in the file name. */
  item: string;
  /** Signed certificates carry a status (PX) in the file name. */
  status?: "PX";
  /** One file per device. The ID goes in parentheses after the item. */
  perDevice?: DeviceKind;
  /** "(as applicable)" in the exhibit: may be marked not applicable. */
  asApplicable?: boolean;
  /**
   * Recurring through the job, not a one-time upload: one row per report,
   * keyed by its date (perDevice "period"), each carrying that date as its
   * vYYYY-MM-DD.
   */
  recurring?: "weekly" | "monthly";
  /** The exhibit's direction for this item, shortened. */
  note?: string;
};

const DISCIPLINES = ["Civil", "SCADA", "Electrical", "Met Station", "Structural", "Telecom"];

// The equipment list Part II asks for, in the singular the file names use
// ("Inverter Manual & Spec"). A slash is not allowed in a file name, so
// Relays/IEDs reads Relay-IED.
const EQUIPMENT = [
  "Inverter", "Module", "Racking", "Field MV Transformer", "Station Service Transformer",
  "Auxiliary Transformer", "Combiner Box", "SCADA Enclosure", "Telecommunications",
  "Weather Station & Sensors", "Relay-IED", "Switchgear", "Breaker", "Fuse",
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function items(part: DeliverablePart, section: string, names: string[], extra: Partial<CatalogItem> = {}): CatalogItem[] {
  return names.map((item) => ({ key: `${part}:${slug(section)}:${slug(item)}`, part, section, item, ...extra }));
}

function one(part: DeliverablePart, section: string, item: string, extra: Partial<CatalogItem> = {}): CatalogItem {
  return { key: `${part}:${slug(section)}:${slug(item)}`, part, section, item, ...extra };
}

export const EXHIBIT_S: CatalogItem[] = [
  // ---------------- Part I - prior to Mechanical Completion ----------------
  ...items("I", "1.1 Issued For Permit (IFP) Plans & Specs", DISCIPLINES.map((d) => `IFP ${d}`)),
  one("I", "1.2 Vendor Shop Drawings", "Shop Drawings", {
    perDevice: "equipment",
    note: "All shop drawings for contractor-furnished equipment, one file per piece of equipment.",
  }),
  ...items("I", "1.3 Issued For Construction (IFC) Plans & Specs", DISCIPLINES.map((d) => `IFC ${d}`)),
  ...items("I", "1.4 Study Reports & Calcs", [
    "Pile Load Tests", "Geotech Report", "Foundation Structural Calcs", "Racking Structural Calcs",
  ]),
  one("I", "1.4 Study Reports & Calcs", "Electrical Ampacity Calcs-Study Report", {
    note: "Wiring schedule and calcs may be in the stamped plans; CYMCAP or ETAP may also be used.",
  }),
  ...items("I", "1.4 Study Reports & Calcs", ["Reactive Power Study", "Grounding Study"], { asApplicable: true }),
  one("I", "1.4 Study Reports & Calcs", "Load Flow Model", { asApplicable: true, note: "As the utility requires." }),
  one("I", "1.4 Study Reports & Calcs", "Protection Coordination Study", { note: "Include AC and DC short circuit details." }),
  one("I", "1.4 Study Reports & Calcs", "AC & DC Arc Flash Studies", { note: "Arc flash labels on the equipment before Mechanical Completion." }),
  one("I", "1.4 Study Reports & Calcs", "AC Loading Study", { note: "Daily average expected parasitic consumption for the facility." }),
  one("I", "1.5 SWPPP (Storm Water Pollution Prevention Plan)", "SWPPP"),
  ...items("I", "1.6 SCADA & Protection Configurations", ["Relay As-Left Files", "Protection Philosophy", "SCADA Point Map"]),
  one("I", "2.1 Construction Roads (Pre-Existing Conditions)", "Pre-Existing Conditions", {
    perDevice: "road",
    note: "Video or photos of every road next to the site, in full, before construction starts.",
  }),
  one("I", "2.2 Weekly Progress Reports (based on Exhibit X)", "Weekly Progress Report", { recurring: "weekly", perDevice: "period" }),
  one("I", "2.3 Weekly Progress Meeting Minutes", "Weekly Meeting Minutes", { recurring: "weekly", perDevice: "period" }),
  one("I", "2.4 Monthly Progress Schedules", "Monthly Progress Schedule", { recurring: "monthly", perDevice: "period" }),
  ...items("I", "2.5 Insurance & Bonds", ["Liability Cert", "Payment Bond", "Performance Bond"]),
  ...items("I", "3.1 Supply Agreements", [
    "Inverter Supply Agreement", "Inverter Purchase Order", "Racking Supply Agreement", "Racking Purchase Order",
  ], { asApplicable: true }),
  ...items("I", "3.2 Module Accounting", ["Module Shipping Slips"], { asApplicable: true }),
  one("I", "3.2 Module Accounting", "FTD Reports", { asApplicable: true, note: "Module flash test from the manufacturer. Owner provided." }),
  ...items("I", "3.2 Module Accounting", ["Module Inspection Reports", "Nonconforming Module Matrix"], { asApplicable: true }),
  one("I", "4. Test Reports", "VLF Tan Delta Test Reports (MV Cables)", { note: "Per Exhibit R-2, Section 1.5. One compiled PDF." }),
  one("I", "4. Test Reports", "Concrete Break Test Reports", { note: "Every concrete pad on site. Third-party inspections where the AHJ requires." }),
  ...items("I", "4. Test Reports", ["DC System Test Reports", "DC Megger Test Reports"]),
  one("I", "4. Test Reports", "Fiber Test Reports (as applicable)", { asApplicable: true }),
  one("I", "4. Test Reports", "Electrical Trench Compaction Test Reports"),
  one("I", "4. Test Reports", "MV XFMR Field Test Reports", {
    note: "Power factor, exciting current, TTR, LTC ratio, bushing, winding resistance, insulation resistance, AC cable color check and oil sample, to NETA.",
  }),
  one("I", "4. Test Reports", "Array XFMR Factory Test Reports", { note: "Per IEEE C57.12.00 and C57.12.90, oil and all routine factory tests, one compiled PDF." }),
  one("I", "4. Test Reports", "Inverter Cold Commissioning Checklist", { note: "Completed per the inverter manufacturer's requirements." }),
  ...items("I", "4. Test Reports", ["PV Auxiliary Transformer Factory Test Report", "DC Disconnect Field Test Reports"]),
  one("I", "5. Miscellaneous", "MC Certificate", { status: "PX", note: "Partially executed by us. The owner issues the fully executed copy." }),

  // ---------------- Part II - prior to Substantial Completion ----------------
  ...items("II", "1. Test Reports", [
    "Relay Setting Test Report", "Fall of Potential and Grounding Continuity Test", "Capacity Test Report",
    "Availability Test Report", "Battery Back-up System Test Reports", "CT and PT Test Reports",
  ]),
  ...items("II", "1. Test Reports", [
    "Circuit Breaker Field Test Reports (as applicable)", "Circuit Breaker Factory Test Reports (as applicable)",
    "Recloser Field Test Reports (as applicable)", "Recloser Factory Test Reports (as applicable)",
    "Current Switcher Field Test Reports (as applicable)", "Current Switcher Factory Test Reports (as applicable)",
  ], { asApplicable: true }),
  ...items("II", "1. Test Reports", ["Meter Field Test Reports", "Phase Rotation Test", "Meter Factory Test Reports", "Relay Factory Test Reports"]),
  one("II", "1. Test Reports", "SCADA Test Reports", { note: "Installation, alarm and operational test reports." }),
  one("II", "1. Test Reports", "String Test Reports", {
    note: "Tabular I-V data for every string: ID, Vmp, Imp, Pmax, Voc, Isc, ratios, irradiance (500 W/m2 minimum), ambient temp and performance factor.",
  }),
  one("II", "1. Test Reports", "Inverter Commissioning", { note: "All vendor commissioning reports, studies and checklists, one compiled PDF." }),
  one("II", "2. Equipment List", "Equipment List", { note: "Owner's inventory form: quantities, make/model and serial numbers for every equipment type." }),
  ...items("II", "3. Factory Manuals & Specs", EQUIPMENT.map((e) => `${e} Manual & Spec`), { asApplicable: true }),
  one("II", "4. Operating Manuals", "Array Ops Manual", {
    note: "Emergency and scheduled shutdown/start-up, relay settings, evacuation, safety plan and LOTO.",
  }),
  ...items("II", "4. Operating Manuals", ["Substation Ops Manual", "Gentie Ops Manual"], { asApplicable: true }),
  ...items("II", "5. Warranties", EQUIPMENT.map((e) => `${e} Warranty Cert`), { asApplicable: true }),
  ...items("II", "6. As-Builts", DISCIPLINES.map((d) => `As-Built ${d}`), { note: "Final as-built survey and drawings, PDF and DWG." }),
  ...items("II", "7. Calibration Certs", ["Meter Calibration Cert", "Weather Station Sensor Calibration Cert"]),
  one("II", "8. Miscellaneous", "SC Certificate", { status: "PX", note: "Partially executed by us. The owner issues the fully executed copy." }),

  // ---------------- Part III - prior to Final Completion ----------------
  ...items("III", "1.1 Pictures - Inverters", [
    "Inverter ID Label", "Inverter Mfg Label", "Inverter Exterior",
  ], { perDevice: "IN" }),
  one("III", "1.1 Pictures - Inverters", "Inverter Interior", { perDevice: "IN", note: "Every interior cabinet and termination, one compiled PDF." }),
  ...items("III", "1.1 Pictures - Inverters", ["Inverter AC Connections", "Inverter DC Connections"], {
    perDevice: "IN", note: "As many photos as it takes, one compiled PDF.",
  }),
  ...items("III", "1.2 Pictures - Transformers", ["Transformer ID Label", "Transformer Mfg Label", "Transformer Exterior"], { perDevice: "MVT" }),
  one("III", "1.2 Pictures - Transformers", "Transformer Interior", { perDevice: "MVT", note: "Overview and terminations, one compiled PDF." }),
  one("III", "1.2 Pictures - Transformers", "Transformer SCADA", { perDevice: "MVT", note: "SCADA equipment including I/O, one compiled PDF." }),
  ...items("III", "1.3 Pictures - Switchgear", ["Switchgear ID Label", "Switchgear Mfg Label", "Switchgear Exterior"], { perDevice: "MVSG" }),
  one("III", "1.3 Pictures - Switchgear", "Switchgear Interior", { perDevice: "MVSG", note: "Doors open, showing where the breakers and disconnects sit. One compiled PDF." }),
  one("III", "1.4 Pictures - Racking", "Tracker Overview", { note: "The typical system with one photo each of motor, driveline and enclosure. One compiled PDF." }),
  ...items("III", "1.4 Pictures - Racking", ["Motor ID Labels", "Motor Mfg Labels", "Controller ID Labels", "Controller Mfg Labels"], {
    asApplicable: true, note: "Every unit's label, one compiled PDF.",
  }),
  ...items("III", "1.4 Pictures - Racking", ["Controller Exterior", "Controller Interior"], { asApplicable: true, note: "One typical controller." }),
  ...items("III", "1.5 Pictures - Met Stations", ["Met Station ID Labels", "Met Station Mfg Labels"], { perDevice: "MS" }),
  one("III", "1.5 Pictures - Met Stations", "Met Station Exterior", {
    perDevice: "MS", note: "Mast, sensors and enclosure. Pyranometers shot from the north to show the southern horizon.",
  }),
  ...items("III", "1.6 Pictures - SCADA Enclosure", ["SCADA ID Labels", "SCADA Mfg Labels", "SCADA Exterior", "SCADA Interior"]),
  ...items("III", "1.7 Pictures - Meters (Utility)", [
    "Meter Enc. Exterior", "Utility Meter Enc. Interior", "Utility Meter ID Label", "Utility Meter Mfg Label", "Utility Meter Face",
  ]),
  ...items("III", "1.7 Pictures - Meters (Owner Check Meter)", [
    "Owner Meter Enc. Exterior", "Owner Meter Enc. Interior", "Owner Meter ID Label", "Owner Meter Mfg Label", "Owner Meter Face",
  ]),
  ...items("III", "1.8 Pictures - Combiner Box", ["CB ID Labels", "CB Exterior NEC Labels"], { note: "Every box's labels, one compiled PDF." }),
  ...items("III", "1.8 Pictures - Combiner Box", ["CB Exterior", "CB Interior"], { note: "One typical combiner box." }),
  one("III", "2. Spare Parts", "Spare Parts Inventory", { note: "Quantities, make/model and serial numbers." }),
  one("III", "3. Test Reports", "IR Test Reports", { note: "Infrared scan of energized equipment." }),
  ...items("III", "4. SCADA & Protection Configurations", ["Plant Controllers", "Servers", "Network Equipment"], {
    note: "Consult the owner before sharing.",
  }),
  one("III", "5. Contacts", "Contact List", { note: "Major subs, equipment suppliers and service providers." }),
  one("III", "6. Miscellaneous", "FC Certificate", { status: "PX", note: "Partially executed by us. The owner issues the fully executed copy." }),
];

export const CATALOG_BY_KEY = new Map(EXHIBIT_S.map((c) => [c.key, c]));

/** Characters a file name in the data room cannot carry. */
const UNSAFE = /[\\/:*?"<>|]+/g;

/**
 * The file name Exhibit S requires, without an extension.
 *
 *   Sussex CSG 1 LLC_IFP Civil_v2026-11-03
 *   Sussex CSG 1 LLC_MC Certificate_PX_v2026-11-03
 *   Sussex CSG 1 LLC_Inverter ID Label (IN 1.1.1)_v2026-11-03
 *   Sussex CSG 1 LLC_Pre-Existing Conditions_Old Racetrack Rd_v2026-11-03
 */
export function deliverableFileName(input: {
  spv: string;
  item: CatalogItem;
  /** YYYY-MM-DD, the document's own date. */
  versionDate: string;
  deviceId?: string | null;
}): string {
  const spv = input.spv.trim().replace(UNSAFE, "-");
  const device = (input.deviceId ?? "").trim().replace(UNSAFE, "-");
  let item = input.item.item;
  // A recurring report: one file per issue, told apart by its date alone.
  // Phil: "The control number is not necessary in the file name. Filename
  // will just change at the end by the date." The control number stays on
  // the checklist for tracking; the name is the item and the doc date.
  if (input.item.perDevice === "period") {
    const status = input.item.status ? `_${input.item.status}` : "";
    return `${spv}_${item}${status}_v${input.versionDate}`;
  }
  if (device) {
    // The road is its own segment in Exhibit S; a device goes in parentheses.
    item = input.item.perDevice === "road" ? `${item}_${device}` : `${item} (${device})`;
  }
  const status = input.item.status ? `_${input.item.status}` : "";
  return `${spv}_${item}${status}_v${input.versionDate}`;
}

/** Null when the ID follows Exhibit GG, or the reason it doesn't. */
export function deviceIdProblem(kind: DeviceKind, deviceId: string): string | null {
  const id = deviceId.trim();
  if (!id) return kind === "period" ? "Pick the report date" : "Enter the device";
  if (kind === "period") {
    return /^\d{4}-\d{2}-\d{2}$/.test(id) && !Number.isNaN(Date.parse(`${id}T00:00:00Z`)) ? null : "Pick a valid date";
  }
  const pattern = DEVICE_PATTERN[kind];
  if (pattern && !pattern.test(id)) return `Not an Exhibit GG ID. ${DEVICE_HINT[kind]}.`;
  return null;
}

export const DELIVERABLE_STATES = ["not_started", "in_progress", "submitted", "accepted", "missed", "not_applicable"] as const;
export type DeliverableState = (typeof DELIVERABLE_STATES)[number];

export const STATE_LABEL: Record<DeliverableState, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  submitted: "Uploaded",
  accepted: "Accepted",
  missed: "Missed",
  not_applicable: "N/A",
};

/**
 * Done for counting: uploaded, accepted, not applicable to this site, or a
 * recurring report that was missed and the reason recorded. A missed week
 * with no reason is not done; it shows as a gap until somebody explains it.
 */
export function isDone(state: string): boolean {
  return state === "submitted" || state === "accepted" || state === "not_applicable" || state === "missed";
}

/**
 * The next report date for a recurring item: a week, or a month, after the
 * latest one on file. With none on file, today.
 */
export function nextPeriod(recurring: "weekly" | "monthly", latest: string | null, today: string): string {
  if (!latest) return today;
  const d = new Date(`${latest}T00:00:00Z`);
  if (recurring === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  // Same day next month, held to the month's end: Oct 31 is followed by
  // Nov 30, not Dec 1.
  const day = d.getUTCDate();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next.toISOString().slice(0, 10);
}

// ------------------------------- revisions -------------------------------
//
// A deliverable is submitted, reviewed, and sometimes sent back. A changed
// equipment design means a new cut sheet for approval. Each submission is a
// revision: Rev 0 first, Rev 1 after the first change, and so on, each with
// its own date, which Exhibit S already puts in the file name. No rev number
// goes in the name; the vYYYY-MM-DD is what tells the two files apart.

export const REVIEW_DECISIONS = ["submitted", "approved", "approved_as_noted", "revise_resubmit", "rejected"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const DECISION_LABEL: Record<ReviewDecision, string> = {
  submitted: "Submitted, awaiting review",
  approved: "Approved",
  approved_as_noted: "Approved as noted",
  revise_resubmit: "Revise and resubmit",
  rejected: "Rejected",
};

/** What the latest revision's decision makes the item's status. */
export function stateForDecision(decision: ReviewDecision): DeliverableState {
  if (decision === "approved" || decision === "approved_as_noted") return "accepted";
  if (decision === "submitted") return "submitted";
  return "in_progress";
}

/**
 * The weeks with no report on file. Weekly reports are expected every 7 days
 * from the first one, through the last full week. A report anywhere in a week's 7-day
 * window covers it, so a report sent a day late still counts, and a week
 * recorded as missed (with its reason) counts as accounted for.
 */
export function missedWeeks(reportDates: string[], today: string): string[] {
  const dates = reportDates.filter(Boolean).sort();
  if (dates.length === 0) return [];
  const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
  const covered = dates.map(day);
  const out: string[] = [];
  // Only weeks that have fully gone by: this week's report isn't late yet.
  for (let d = day(dates[0]); d + 7 <= day(today); d += 7) {
    if (!covered.some((c) => c >= d && c < d + 7)) out.push(new Date(d * 86400000).toISOString().slice(0, 10));
  }
  return out;
}
