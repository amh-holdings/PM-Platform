// Import the 5.2 Mechanical branch of the Sweet Springs schedule and re-point
// the owner SOV lines that depend on it.
//
// WHY THIS IS AN INSERT, NOT A REBASELINE
// The civil-only rebaseline (scripts/civil-only-2026-08.mjs) left the live
// schedule holding 24 rows, all 5.1.x. Every 5.2.x task that used to exist -
// the 17 dateless placeholders visible in
// db/snapshots/schedule_tasks_sweet-springs_pre-civil-only.json - is gone, and
// none of them ever carried a field-report pin. So there is no remap problem
// here and no pins to move: this is a clean create.
//
// The hazard is on the BILLING side instead. billing_lines still carries links
// into 5.2 codes that have had no matching task for weeks:
//
//   8.01 Piles and Racking Installed  $319,317.44  -> ["5.2.7","5.2.8","5.2.9"]
//   8.02 Modules Installed             $65,227.45  -> null
//   9.00 Mechanical Completion        $160,000.00  -> ["5.2","5.4.1"]
//   12.00 Final Completion                  $0.00  -> [...,"5.2.17"]
//
// computeBillingSuggestions skips a missing code silently, so these have been
// contributing $0 and saying nothing about it. The moment 5.2 exists again they
// come alive - 8.01 in particular would start earning off three racking tasks
// while every pile task, which is most of the line's real content, stayed
// invisible. So the links are corrected in the same transaction as the insert,
// never after.
//
// Left deliberately alone, see the FLAGS section printed at the end:
//   9.00 points at the 5.2 SUMMARY row. The civil importer refuses SOV links to
//        summary rows outright. This is a $160,000 milestone line and changing
//        what earns it is Phil's call, not a mechanical consequence of an import.
//   8.03 points at 5.3.x electrical codes that do not exist either. Out of
//        scope for the mechanical branch and outside Sunstall's contract, which
//        excludes all electrical work (Exhibit A).
//
//   node scripts/import-mechanical-schedule.mjs --dry-run
//   node scripts/import-mechanical-schedule.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

// ---- The mechanical schedule, transcribed from the source ------------------
// [wbs, name, status, durationDays, start, end, predecessors, assignedTo]
//
// Predecessors in the source are row numbers, not WBS codes. Translated here
// via ROW_TO_WBS below. Row 187 = 5.2, 188 = 5.2.1 ... 203 = 5.2.16.
//
// DURATIONS ARE TRANSCRIBED VERBATIM and several do not recompute from their
// own start/end on a 5-day week (5.2.6 spans 5 working days but reads 4d;
// 5.2.9 spans 6 but reads 5d; 5.2.14 spans 6 but reads 5d). That is the source
// schedule's arithmetic, driven by the half-day tasks and SS+lag links ahead of
// them. It is not corrected here - the platform should mirror the schedule that
// governs the subcontract, not a tidied-up version of it.
//
// assignedTo: Sunstall everywhere EXCEPT the three inspection tasks. Exhibit A
// of the subcontract excludes "third-party inspections or testing" from
// Sunstall's price, so 5.2.5 / 5.2.10 / 5.2.15 are AHC's cost, and owner SOV
// 5.08 "3rd Party/ QA/CC" ($20,000) is where they live.
const SUN = "Sunstall, Inc.";
const QAQC = "AHC / 3rd Party QA-QC";

const NEW = [
  ["5.2",    "Mechanical",                      "Not Started", 13,  "2026-10-30", "2026-11-18", null,             null],
  ["5.2.1",  "Array Layout and Marking",        "Not Started", 1,   "2026-10-30", "2026-10-30", null,             SUN],
  ["5.2.2",  "Pile Unloading",                  "Not Started", 0.5, "2026-11-02", "2026-11-02", "5.2.1",          SUN],
  ["5.2.3",  "Pile Staging",                    "Not Started", 0.5, "2026-11-02", "2026-11-02", "5.2.2",          SUN],
  ["5.2.4",  "Pile Driving",                    "Not Started", 4,   "2026-11-03", "2026-11-06", "5.2.3",          SUN],
  ["5.2.5",  "Pile Installation Inspection",    "Not Started", 4,   "2026-11-03", "2026-11-06", "5.2.4SS",        QAQC],
  ["5.2.6",  "Pile Remediation",                "Not Started", 4,   "2026-11-09", "2026-11-13", "5.2.5",          SUN],
  ["5.2.7",  "Racking Unloading",               "Not Started", 2,   "2026-11-03", "2026-11-04", "5.2.3",          SUN],
  ["5.2.8",  "Staging for Racking to the field","Not Started", 2,   "2026-11-03", "2026-11-04", "5.2.3",          SUN],
  ["5.2.9",  "Racking Assembly",                "Not Started", 5,   "2026-11-06", "2026-11-13", "5.2.4SS+3d",     SUN],
  ["5.2.10", "Racking Inspection",              "Not Started", 5,   "2026-11-06", "2026-11-13", "5.2.9SS",        QAQC],
  ["5.2.11", "Racking Remediation",             "Not Started", 2,   "2026-11-16", "2026-11-17", "5.2.10",         SUN],
  ["5.2.12", "Module Unloading",                "Not Started", 1,   "2026-11-05", "2026-11-05", "5.2.7",          SUN],
  ["5.2.13", "Module Staging",                  "Not Started", 1,   "2026-11-05", "2026-11-05", "5.2.12SS",       SUN],
  ["5.2.14", "Module Installation",             "Not Started", 5,   "2026-11-10", "2026-11-17", "5.2.9SS+2d",     SUN],
  ["5.2.15", "Module Inspection",               "Not Started", 5,   "2026-11-10", "2026-11-17", "5.2.14SS",       QAQC],
  ["5.2.16", "QA/QC Closeout",                  "Not Started", 3,   "2026-11-16", "2026-11-18", "5.2.14SS+3d",    SUN],
];

// 5.2.1's predecessors in the source are rows 179 and 121, which sit OUTSIDE the
// mechanical block. Neither row is resolvable from the live schedule - the
// civil-only rebaseline deleted every non-5.1 row, and the surviving civil rows
// carry source_row_id values in the R3xx range, so nothing here maps to 179 or
// 121. Storing a guess would be worse than storing nothing: the schedule engine
// treats predecessors as real logic. The raw text is preserved on the task's
// description so it is not silently lost, and the import prints a flag.
const UNRESOLVED_PRED = {
  "5.2.1": "Source-schedule predecessors: rows 179, 121 (outside the mechanical block, not yet mapped to WBS).",
};

// ---- Owner SOV re-links ----------------------------------------------------
// 8.01 currently earns off racking only. Piles are the larger half of the line
//      and were not linked at all. Array layout is the setting-out that pile
//      driving depends on and belongs with it.
// 8.02 had no links whatsoever.
// Both exclude the 5.2 summary row, per the summary-row rule the civil importer
// enforces. Remediation tasks are included: they are rework inside the same
// scope, and leaving them out would let the line read 100% with defects open.
const SOV = {
  "8.01": ["5.2.1", "5.2.2", "5.2.3", "5.2.4", "5.2.5", "5.2.6", "5.2.7", "5.2.8", "5.2.9", "5.2.10", "5.2.11"],
  "8.02": ["5.2.12", "5.2.13", "5.2.14", "5.2.15"],
};

// Dangling codes to rewrite in place on lines this import does not otherwise
// own. 5.2.17 "Final Adjustments" existed only in the old placeholder tree; the
// governing schedule ends at 5.2.16 QA/QC Closeout. Line 12.00 is $0, so this
// is a hygiene fix with no money attached.
const DANGLING = { "12.00": { "5.2.17": "5.2.16" } };

// ---- Contract quantities from Exhibit B / Schedule of Values ---------------
// The commodity totals seeded in 0035 are the client's placeholders. Percent
// complete on 8.01 and 8.02 divides installed quantity by these, so a wrong
// total is a wrong bill: at 500 piles instead of 412, every pile driven earns
// 18% less than it should.
const COMMODITY_TOTALS = {
  piles:   { total: 412,  why: "Exhibit B line 2: 'drive approximately 412 piles to the required embedment'" },
  modules: { total: 2356, why: "Exhibit B line 4: 'install approximately 2,356 modules'" },
  // racking: NOT SET. The SOV gives no row/table count for racking, and the
  // total drives 8.01's percentage. Left at its placeholder and flagged.
};

// ===========================================================================
const parentOf = (c) => (c.includes(".") ? c.slice(0, c.lastIndexOf(".")) : null);
const newCodes = new Set(NEW.map((r) => r[0]));
const summaryCodes = new Set(NEW.map((r) => parentOf(r[0])).filter((p) => p && newCodes.has(p)));
const newByCode = Object.fromEntries(NEW.map((r) => [r[0], r]));

const { data: tasks, error: tErr } = await sb.from("schedule_tasks").select("*").eq("project_id", PID);
if (tErr) { console.error("FATAL reading schedule_tasks: " + tErr.message); process.exit(1); }
const existingMech = tasks.filter((t) => t.wbs_code === "5.2" || (t.wbs_code || "").startsWith("5.2."));

const { data: bl, error: bErr } = await sb.from("billing_lines").select("id,item_number,description,scheduled_value,linked_task_wbs_codes").eq("project_id", PID);
if (bErr) { console.error("FATAL reading billing_lines: " + bErr.message); process.exit(1); }
const blByItem = Object.fromEntries(bl.map((l) => [l.item_number, l]));

const { data: comms } = await sb.from("commodities").select("id,key,label,uom,total_quantity,total_verified,sov_item,category").eq("project_id", PID).eq("category", "mechanical");

// --- validate --------------------------------------------------------------
const problems = [];
if (existingMech.length) {
  problems.push(`${existingMech.length} task(s) already exist under 5.2 - this script only creates. Re-point it at a remap before re-running.`);
}
for (const [item, codes] of Object.entries(SOV)) {
  if (!blByItem[item]) problems.push(`SOV ${item} is not a billing line on this project`);
  for (const c of codes) {
    if (!newCodes.has(c)) problems.push(`SOV ${item} references ${c}, not in the new schedule`);
    if (summaryCodes.has(c)) problems.push(`SOV ${item} references ${c}, which is a SUMMARY row`);
  }
}
for (const r of NEW) {
  const p = r[6];
  if (!p) continue;
  for (const dep of p.split(",").map((s) => s.trim())) {
    const code = dep.replace(/(SS|FF|SF)?([+-]\d+d)?$/, "");
    if (!newCodes.has(code)) problems.push(`${r[0]} predecessor "${dep}" resolves to ${code}, not in the new schedule`);
  }
}
for (const k of Object.keys(COMMODITY_TOTALS)) {
  if (!(comms || []).some((c) => c.key === k)) problems.push(`commodity "${k}" not found on this project`);
}
if (problems.length) {
  console.error("Refusing to run:\n" + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}

console.log(`Project ${PID}    mode: ${DRY ? "DRY RUN" : "APPLY"}\n`);
console.log("=".repeat(104));
console.log("A. SCHEDULE STRUCTURE - 5.2 Mechanical");
console.log("=".repeat(104));
console.log(`\n  Live schedule holds ${tasks.length} tasks, ${existingMech.length} of them under 5.2. All ${NEW.length} rows below are INSERTS.\n`);
console.log(`    ${"WBS".padEnd(8)} ${"Task".padEnd(34)} ${"Dur".padStart(5)}  ${"Start".padEnd(11)}${"Finish".padEnd(12)}${"Predecessors".padEnd(14)} Assigned`);
console.log("    " + "-".repeat(98));
for (const r of NEW) {
  const indent = "  ".repeat(r[0].split(".").length - 2);
  console.log(`    ${r[0].padEnd(8)} ${(indent + r[1]).slice(0, 34).padEnd(34)} ${(r[3] + "d").padStart(5)}  ${r[4].padEnd(11)}${r[5].padEnd(12)}${String(r[6] ?? "-").padEnd(14)} ${r[7] ?? "-"}`);
}

console.log("\n" + "=".repeat(104));
console.log("B. OWNER SOV RE-LINKS");
console.log("=".repeat(104));
for (const [item, codes] of Object.entries(SOV)) {
  const line = blByItem[item];
  const was = line.linked_task_wbs_codes;
  console.log(`\n  ${item}  ${line.description}   $${Number(line.scheduled_value).toLocaleString()}`);
  console.log(`      was:  ${was && was.length ? was.join(", ") : "(none)"}`);
  console.log(`      now:  ${codes.join(", ")}`);
  const added = codes.filter((c) => !(was || []).includes(c));
  const dropped = (was || []).filter((c) => !codes.includes(c));
  console.log(`      +${added.length} linked, -${dropped.length} unlinked${dropped.length ? " (" + dropped.join(", ") + ")" : ""}`);
}
for (const [item, map] of Object.entries(DANGLING)) {
  const line = blByItem[item];
  if (!line) continue;
  const was = line.linked_task_wbs_codes || [];
  const now = was.map((c) => map[c] ?? c);
  if (JSON.stringify(was) === JSON.stringify(now)) continue;
  console.log(`\n  ${item}  ${String(line.description).slice(0, 60)}   $${Number(line.scheduled_value).toLocaleString()}`);
  console.log(`      dangling code rewritten:  ${was.join(", ")}  ->  ${now.join(", ")}`);
}

console.log("\n" + "=".repeat(104));
console.log("C. CONTRACT QUANTITIES");
console.log("=".repeat(104));
for (const c of comms || []) {
  const fix = COMMODITY_TOTALS[c.key];
  const mark = fix ? (Number(c.total_quantity) === fix.total ? "ok" : "FIX") : "--";
  console.log(`\n  [${mark}] ${c.key.padEnd(16)} ${c.uom.padEnd(6)} sov=${c.sov_item}   placeholder ${c.total_quantity}${fix ? `  ->  ${fix.total}` : ""}`);
  if (fix) console.log(`       ${fix.why}`);
}

// --- flags -----------------------------------------------------------------
const flags = [];
if (!COMMODITY_TOTALS.racking) {
  const r = (comms || []).find((c) => c.key === "racking");
  flags.push(`racking commodity total stays at the placeholder ${r?.total_quantity} ${r?.uom}. The SOV gives no racking count, and this number is a denominator on SOV 8.01 ($${Number(blByItem["8.01"].scheduled_value).toLocaleString()}). Needs the tracker row/table count from the FTC Solar layout.`);
}
const l900 = blByItem["9.00"];
if (l900) flags.push(`9.00 "${l900.description.trim()}" ($${Number(l900.scheduled_value).toLocaleString()}) links to ${JSON.stringify(l900.linked_task_wbs_codes)}. 5.2 is a SUMMARY row and 5.4.1 does not exist. Left untouched - deciding what earns a $160k milestone is not an import's call. Candidate: 5.2.16 QA/QC Closeout.`);
const l803 = blByItem["8.03"];
if (l803) flags.push(`8.03 "${l803.description.trim()}" ($${Number(l803.scheduled_value).toLocaleString()}) links to ${JSON.stringify(l803.linked_task_wbs_codes)} - electrical codes with no tasks live. Outside Sunstall's scope (Exhibit A excludes all electrical). Untouched; resolves when 5.3 is imported.`);
flags.push(`5.2.1 predecessors (rows 179, 121) are unresolved. The task will import with no logic, so the schedule engine will not push it. Preserved in the task description.`);
flags.push(`Durations 5.2.6 / 5.2.9 / 5.2.14 do not recompute from their own dates on a 5-day week. Transcribed as printed in the source schedule.`);

console.log("\n" + "=".repeat(104));
console.log("D. FLAGS - read before applying");
console.log("=".repeat(104));
flags.forEach((f, i) => console.log(`\n  ${i + 1}. ${f}`));

if (DRY) { console.log("\n[dry-run] Nothing written.\n"); process.exit(0); }

// --- apply -----------------------------------------------------------------
mkdirSync("scripts/_backups", { recursive: true });
const ts = process.env.STAMP || "mech-import";
writeFileSync(`scripts/_backups/billing_lines_${ts}.json`, JSON.stringify(bl, null, 1));
writeFileSync(`scripts/_backups/commodities_${ts}.json`, JSON.stringify(comms, null, 1));
console.log(`\nBacked up billing_lines, commodities -> scripts/_backups/*_${ts}.json`);

// 1. Insert the tasks. Sort order continues past civil's last row (240) so the
//    mechanical branch lands below it in schedule views ordered by sort_order.
let sort = 300;
let inserted = 0;
for (const r of NEW) {
  const { error } = await sb.from("schedule_tasks").insert({
    project_id: PID,
    wbs_code: r[0],
    task_name: r[1],
    description: UNRESOLVED_PRED[r[0]] ?? null,
    status: r[2],
    duration_days: r[3],
    start_date: r[4],
    end_date: r[5],
    predecessors: r[6],
    assigned_to: r[7],
    phase: "Construction",
    parent_wbs_code: parentOf(r[0]),
    level_code: r[0].split(".").length,
    sort_order: sort,
    pct_complete: null,
    status_source: "manual",
    // Baselined on import: this branch has never had a baseline, and the
    // subcontract carries $500/day delay liquidated damages measured against
    // the agreed schedule, so the dates need a fixed reference from day one.
    baseline_start: r[4],
    baseline_end: r[5],
    baseline_duration_days: r[3],
    baseline_label: "Mechanical subcontract award 2026-08-20",
  });
  if (error) { console.error(`FATAL inserting ${r[0]}: ${error.message}`); process.exit(1); }
  sort += 10;
  inserted++;
}

// 2. Re-link the owner SOV.
for (const [item, codes] of Object.entries(SOV)) {
  const { error } = await sb.from("billing_lines").update({ linked_task_wbs_codes: codes }).eq("id", blByItem[item].id);
  if (error) { console.error(`FATAL relinking SOV ${item}: ${error.message}`); process.exit(1); }
}
// 3. Rewrite dangling codes on lines this import does not own.
for (const [item, map] of Object.entries(DANGLING)) {
  const line = blByItem[item];
  if (!line) continue;
  const now = (line.linked_task_wbs_codes || []).map((c) => map[c] ?? c);
  if (JSON.stringify(line.linked_task_wbs_codes) === JSON.stringify(now)) continue;
  const { error } = await sb.from("billing_lines").update({ linked_task_wbs_codes: now }).eq("id", line.id);
  if (error) { console.error(`FATAL rewriting dangling code on ${item}: ${error.message}`); process.exit(1); }
}
// 4. Correct the contract quantities. total_verified is set at the same time:
//    scripts/commodity/seed-commodities.ts overwrites total_quantity with
//    COMMODITIES[].placeholderTotal on every run EXCEPT where total_verified is
//    already true, so without the flag a routine re-seed would quietly put 500
//    piles and 12,000 modules back and shrink every earned percentage on 8.01
//    and 8.02. commodities.ts now carries the contract figures as well, so the
//    two agree either way.
let fixed = 0;
for (const [key, fix] of Object.entries(COMMODITY_TOTALS)) {
  const c = (comms || []).find((x) => x.key === key);
  if (Number(c.total_quantity) === fix.total && c.total_verified) continue;
  const { error } = await sb.from("commodities").update({ total_quantity: fix.total, total_verified: true }).eq("id", c.id);
  if (error) { console.error(`FATAL updating commodity ${key}: ${error.message}`); process.exit(1); }
  fixed++;
}

console.log(`\nApplied: ${inserted} tasks inserted, ${Object.keys(SOV).length} SOV lines relinked, ${fixed} commodity total(s) corrected.\n`);
