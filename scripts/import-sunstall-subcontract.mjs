// Create the Sunstall, Inc. mechanical subcontract and its schedule of values.
//
// Source documents:
//   Sweet Spring Solar - SUBCONTRACT AGREEMENT (fully executed), dated 2026-08-20
//   Exhibit B - Schedule of Values (the file is named "Exhibit E" but the
//   document header and Section 14.1's enumeration both say Exhibit B; the
//   four line values match Exhibit B's payment schedule exactly, so it is
//   Exhibit B and the filename is wrong, not the content).
//
// WHAT MAKES THIS SUBCONTRACT DIFFERENT FROM PYRAMID'S
//
// 1. THERE IS NO RETENTION. Article 4 has no retainage clause of any kind -
//    not a percentage, not a release trigger, nothing. Pyramid is held at 5%.
//    subcontractors.retainage_pct is therefore written as 0 here, because that
//    is what the executed agreement says. If AHC intended 5% it has to come
//    from a change order, not from a default in this table.
//
// 2. MOBILIZATION IS DUE BEFORE IT IS EARNED. Exhibit B reads "Mobilization
//    Payment: $33,293.33 - Due on the Effective Date". The Effective Date was
//    2026-08-20. The crew does not reach site until 5.2.1 on 2026-10-30. So
//    $33,293.33 - 20% of the subcontract - is contractually payable roughly ten
//    weeks before any of it is earned in the field.
//
//    The line is still mapped 'on_site', deliberately. The platform's job is to
//    say what has been EARNED against field evidence; the Effective Date term
//    governs when AP pays, not when value exists. Mapping it any other way
//    would have the app assert that a crew that has not arrived has performed.
//
//   node scripts/import-sunstall-subcontract.mjs --dry-run
//   node scripts/import-sunstall-subcontract.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) {
  const t = l.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PID = process.env.PROJECT_ID || "53cff193-21e4-45ff-833d-43813e8578a0";
const DRY = process.argv.includes("--dry-run");

const SUB = {
  company_name: "Sunstall, Inc.",
  trade: "Mechanical / Racking",
  contract_value: 166466.64,
  // No retention clause exists in the executed agreement. See note 1 above.
  retainage_pct: 0,
  // Section 4.3(a) leaves the primary payment window BLANK. The only number in
  // the clause is in the postmark sentence: a mailed remittance counts as on
  // time if postmarked "on or before the thirtieth (30th) calendar day
  // following receipt of the Invoice". Net 30 from invoice receipt is the only
  // reading the document supports.
  payment_terms: "Net 30",
  payment_terms_days: 30,
  coi_status: "pending",
  w9_status: "pending",
  active: true,
};

// [item, description, value, method, taskCodes, commodityKeys, notes]
const LINES = [
  [
    "1", "Mobilization", 33293.33, "on_site", [], [],
    "Mobilize crews, pile-driving equipment and site setup, incl. general conditions and IRA prevailing wage / apprenticeship compliance. Earned when the crew reaches site (first field report). NOTE: Exhibit B makes this payable on the Effective Date 2026-08-20, ~10 weeks before mobilization on 2026-10-30 - a payment-timing term, not an earning term.",
  ],
  [
    "2", "Pile Driving", 43173.31, "commodity", [], ["piles"],
    "Locate and mark pile positions and drive ~412 piles to embedment, incl. receiving and handling of Contractor-furnished pile material. Exhibit B: 'Earned by piles driven and verified to tolerance' - so the piles commodity (412 ea) is the direct measure.",
  ],
  [
    "3", "Racking Installation", 45000.00, "commodity", [], ["racking"],
    "Receive, offload and stage Contractor-furnished racking and install all tracker structural components on the driven pile foundations. Exhibit B: 'Earned by structure set, aligned and torqued', which is the racking commodity. The SOV gives no row count, but the FTC BOM does: 60 tracker rows, confirmed by 60 slew drives, 60 row controllers, 60 W6x25 drive posts, and the torque-beam solve (16 int-2s + 24 int-1s + 12 ext-2s + 8 ext-1s). The same breakdown reproduces the SOV's 412 piles exactly, which is what makes the row count trustworthy.",
  ],
  [
    "4", "Modules Installation", 45000.00, "commodity", [], ["modules"],
    "Receive, offload and stage Contractor-furnished modules and install ~2,356 modules. Exhibit B: 'Earned by modules mounted and secured'. WARNING: the same line also carries QA/QC punchlist correction, torque verification records, as-built documentation, warranty assignment, waste disposal, demobilization and broom-clean per Section 5.6 - none of which affect the stated earning trigger. Combined with 0% retention, AHC holds nothing against closeout once the last module is secured.",
  ],
];

// ===========================================================================
const { data: existing } = await sb.from("subcontractors").select("id,company_name,contract_value,retainage_pct,payment_terms").eq("project_id", PID).eq("company_name", SUB.company_name).maybeSingle();

const { data: comms } = await sb.from("commodities").select("id,key,label,uom,total_quantity,sov_item").eq("project_id", PID).eq("category", "mechanical");
const commByKey = Object.fromEntries((comms || []).map((c) => [c.key, c]));

const { data: tasks } = await sb.from("schedule_tasks").select("wbs_code,task_name").eq("project_id", PID);
const liveCodes = new Set((tasks || []).map((t) => t.wbs_code));

// --- validate --------------------------------------------------------------
const problems = [];
// This script depends on import-mechanical-schedule.mjs having run: line 3 links
// to 5.2.x tasks. On APPLY that is fatal, since a link to a missing code is
// exactly the silent-$0 failure the mechanical import exists to prevent. On a
// dry run it is only a pending prerequisite - the whole point of the preview is
// to show the plan before either step has been applied - so it degrades to a
// warning and the preview still renders.
const pending = [];
const total = LINES.reduce((s, l) => s + l[2], 0);
if (Math.abs(total - SUB.contract_value) > 0.005) {
  problems.push(`SOV lines total $${total.toFixed(2)} but the contract price is $${SUB.contract_value.toFixed(2)}`);
}
for (const l of LINES) {
  for (const k of l[5]) if (!commByKey[k]) problems.push(`line ${l[0]} references commodity "${k}", which does not exist on this project`);
  for (const c of l[4]) if (!liveCodes.has(c)) (DRY ? pending : problems).push(`line ${l[0]} references task ${c}, which is not in the live schedule - run import-mechanical-schedule.mjs first`);
  if (l[3] === "schedule" && !l[4].length) problems.push(`line ${l[0]} is method 'schedule' with no linked tasks`);
  if (l[3] === "commodity" && !l[5].length) problems.push(`line ${l[0]} is method 'commodity' with no linked commodities`);
}
if (existing) problems.push(`"${SUB.company_name}" already exists on this project (${existing.id}) - this script only creates`);
if (problems.length) {
  console.error("Refusing to run:\n" + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}

console.log(`Project ${PID}    mode: ${DRY ? "DRY RUN" : "APPLY"}\n`);
console.log("=".repeat(104));
console.log("A. SUBCONTRACTOR");
console.log("=".repeat(104));
console.log(`\n  ${SUB.company_name}   (${SUB.trade})`);
console.log(`  Contract price      $${SUB.contract_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
console.log(`  Retainage           ${SUB.retainage_pct}%   <- no retention clause exists in the executed agreement`);
console.log(`  Payment terms       ${SUB.payment_terms} from invoice receipt`);
console.log(`  Effective date      2026-08-20`);
console.log(`  Delay LDs           $500/day past the Guaranteed Substantial Completion Date`);
console.log(`  Change order cap    profit + overhead not to exceed 10% of actual cost (Section 2.4)`);

console.log("\n" + "=".repeat(104));
console.log("B. SCHEDULE OF VALUES - Exhibit B");
console.log("=".repeat(104));
console.log(`\n  ${"Item".padEnd(5)} ${"Description".padEnd(23)} ${"Value".padStart(13)} ${"% of sub".padStart(9)}  ${"Method".padEnd(10)} Evidence`);
console.log("  " + "-".repeat(100));
for (const l of LINES) {
  const ev = l[3] === "commodity"
    ? l[5].map((k) => `${commByKey[k].label} (${commByKey[k].total_quantity} ${commByKey[k].uom})`).join(", ")
    : l[3] === "schedule" ? l[4].join(", ")
    : "first field report on site";
  console.log(`  ${l[0].padEnd(5)} ${l[1].padEnd(23)} ${("$" + l[2].toLocaleString(undefined, { minimumFractionDigits: 2 })).padStart(13)} ${((l[2] / SUB.contract_value * 100).toFixed(1) + "%").padStart(9)}  ${l[3].padEnd(10)} ${ev}`);
}
console.log("  " + "-".repeat(100));
console.log(`  ${"".padEnd(5)} ${"TOTAL".padEnd(23)} ${("$" + total.toLocaleString(undefined, { minimumFractionDigits: 2 })).padStart(13)} ${"100.0%".padStart(9)}`);

console.log("\n" + "=".repeat(104));
console.log("C. MAPPING NOTES");
console.log("=".repeat(104));
for (const l of LINES) console.log(`\n  ${l[0]}. ${l[1]}\n     ${l[6].replace(/(.{92}\s)/g, "$1\n     ")}`);

console.log("\n" + "=".repeat(104));
console.log("D. FLAGS - read before applying");
console.log("=".repeat(104));
const flags = [
  `Zero retention. Article 4 carries no retainage clause at all. Pyramid is held at 5%. Written as 0% because that is the executed text - if 5% was intended, it needs a change order, not a silent default.`,
  `Mobilization ($33,293.33, 20% of the subcontract) is due on the Effective Date 2026-08-20, which has already passed, while mobilization to site is not scheduled until 2026-10-30. Check whether this has already been invoiced.`,
  `Line 4 bundles closeout, as-builts, demob and broom-clean into a line earned by modules installed. With 0% retention there is no holdback left once the last module is secured.`,
  `Modules: the executed SOV says ~2,356 but the FTC BOM's module rail / cam plate / python clip counts all come to 2,616. Line 4 is a $45,000 lump sum priced against 2,356, so an 11% larger array is a change-order conversation, not a quiet absorption. Confirm which layout is current.`,
  `Contractor identity is inconsistent in the executed document. The recital names American Helios Constructors, LLC as Contractor, but the Section 14.5 notice block reads "If to Contractor: Wellhead Projects, Inc." and Exhibit A refers to material "provided prefabricated and drilled as needed by Wellhead". Reads as carry-over from Sunstall's proposal to Wellhead. Notices sent under this agreement currently address the wrong entity.`,
  `Section 4.3(a) has a blank where the payment window belongs. Net 30 is inferred from the postmark sentence, which is the only number in the clause.`,
];
if (pending.length) {
  flags.push(`PREREQUISITE: ${pending.length} task link(s) do not resolve yet. Run import-mechanical-schedule.mjs before applying this one; on apply, a missing code is fatal rather than a warning.\n     ${pending.join("\n     ")}`);
}
flags.forEach((f, i) => console.log(`\n  ${i + 1}. ${f}`));

if (DRY) { console.log("\n[dry-run] Nothing written.\n"); process.exit(0); }

// --- apply -----------------------------------------------------------------
const { data: sub, error: sErr } = await sb.from("subcontractors").insert({ project_id: PID, ...SUB }).select("id").single();
if (sErr) { console.error(`FATAL creating subcontractor: ${sErr.message}`); process.exit(1); }

let sort = 10;
for (const l of LINES) {
  const { error } = await sb.from("sub_sov_lines").insert({
    project_id: PID,
    subcontractor_id: sub.id,
    item_number: l[0],
    description: l[1],
    scheduled_value: l[2],
    verification_method: l[3],
    linked_task_wbs_codes: l[4],
    linked_commodity_ids: l[5].map((k) => commByKey[k].id),
    mapping_notes: l[6],
    // Mapping is derived from Exhibit B's own stated earning language, not a
    // judgement call, so it is marked confirmed on import. Line 3 is the
    // exception in substance - it is a stand-in until the racking count lands -
    // and its note says so.
    mapping_confirmed_at: "2026-09-01T00:00:00Z",
    sort_order: sort,
    active: true,
  });
  if (error) { console.error(`FATAL creating SOV line ${l[0]}: ${error.message}`); process.exit(1); }
  sort += 10;
}

console.log(`\nApplied: subcontractor ${sub.id} created with ${LINES.length} SOV lines totalling $${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}.\n`);
