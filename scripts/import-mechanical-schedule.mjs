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
// 9.00 is DE-LINKED from 5.2 rather than re-pointed - see STRIP below.
//
// Left deliberately alone, see the FLAGS section printed at the end:
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
// HALF-DAY TASKS. 5.2.2 Pile Unloading and 5.2.3 Pile Staging are both 0.5d in
// the source. schedule_tasks.duration_days is an INTEGER column, so they are
// stored as 1. They must not round to 0: schedule-cpm.ts:196 treats
// duration_days === 0 as a MILESTONE, which would make Pile Unloading an
// instant that consumes no time and can never be late. Rounding up is safe
// because both tasks already start and finish on the same day (2026-11-02) and
// the CPM engine works to day granularity anyway - the source is expressing
// "these two share one day", and start_date = end_date already says that. The
// true 0.5d is recorded on the task description.
//
// DURATIONS ARE OTHERWISE TRANSCRIBED VERBATIM and several do not recompute from their
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
  ["5.2.1",  "Array Layout and Marking",        "Not Started", 1,   "2026-10-30", "2026-10-30", "5.1.3.2",        SUN],
  ["5.2.2",  "Pile Unloading",                  "Not Started", 0.5, "2026-11-02", "2026-11-02", "5.2.1",          SUN],
  ["5.2.3",  "Pile Staging",                    "Not Started", 0.5, "2026-11-02", "2026-11-02", "5.2.2",          SUN],
  ["5.2.4",  "Pile Driving",                    "Not Started", 4,   "2026-11-03", "2026-11-06", "5.2.3",          SUN],
  ["5.2.5",  "Pile Installation Inspection",    "Not Started", 4,   "2026-11-03", "2026-11-06", "5.2.4SS",        QAQC],
  ["5.2.6",  "Pile Remediation",                "Not Started", 4,   "2026-11-09", "2026-11-13", "5.2.5",          SUN],
  ["5.2.7",  "Racking Unloading",               "Not Started", 2,   "2026-11-03", "2026-11-04", "5.2.3",          SUN],
  ["5.2.8",  "Staging for Racking to the field","Not Started", 2,   "2026-11-03", "2026-11-04", "5.2.3",          SUN],
  ["5.2.9",  "Racking Assembly",                "Not Started", 5,   "2026-11-06", "2026-11-13", "5.2.4SS+3" ,     SUN],
  ["5.2.10", "Racking Inspection",              "Not Started", 5,   "2026-11-06", "2026-11-13", "5.2.9SS",        QAQC],
  ["5.2.11", "Racking Remediation",             "Not Started", 2,   "2026-11-16", "2026-11-17", "5.2.10",         SUN],
  ["5.2.12", "Module Unloading",                "Not Started", 1,   "2026-11-05", "2026-11-05", "5.2.7",          SUN],
  ["5.2.13", "Module Staging",                  "Not Started", 1,   "2026-11-05", "2026-11-05", "5.2.12SS",       SUN],
  ["5.2.14", "Module Installation",             "Not Started", 5,   "2026-11-10", "2026-11-17", "5.2.9SS+2" ,     SUN],
  ["5.2.15", "Module Inspection",               "Not Started", 5,   "2026-11-10", "2026-11-17", "5.2.14SS",       QAQC],
  ["5.2.16", "QA/QC Closeout",                  "Not Started", 3,   "2026-11-16", "2026-11-18", "5.2.14SS+3",    SUN],
];

// 5.2.1's predecessors in the source are rows 179 and 121, both outside the
// mechanical block. Phil identified them 2026-09-03:
//
//   179 = Site Grading    -> 5.1.3.2, live in the civil branch. LINKED.
//   121 = Pile Delivery   -> procurement, which has not been imported into the
//                            schedule yet. NOT LINKED, deliberately: a
//                            predecessor string naming a code with no task is
//                            the same silent-skip failure that left the owner
//                            SOV reading $0 for weeks. It goes in when the
//                            procurement branch does.
//
// This single link is what anchors the whole mechanical branch. Every other 5.2
// task chains off 5.2.1, so without it all sixteen float free of the project:
// civil could slip a month and mechanical would still claim a 10/30 start.
// Half-day source durations, preserved as text since the column cannot hold them.
const HALF_DAY = {
  "5.2.2": "Source duration 0.5 day; stored as 1 because duration_days is an integer column and 0 would read as a milestone. Shares 2026-11-02 with 5.2.3.",
  "5.2.3": "Source duration 0.5 day; stored as 1 because duration_days is an integer column and 0 would read as a milestone. Shares 2026-11-02 with 5.2.2.",
};

const NOTE = {
  "5.2.1": "Also succeeds Pile Delivery (source row 121), which is procurement and not yet in the schedule. Add that predecessor when the procurement branch is imported.",
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

// SCOPE: this import touches 8.01 and 8.02 ONLY.
//
// An earlier revision also rewrote 12.00's dangling 5.2.17 and stripped 5.2 off
// 9.00 Mechanical Completion. Both were reverted 2026-09-03 - they belong to the
// Completion scope, which Phil has not started, and an import for one branch has
// no business editing another branch's billing lines even to fix them.
//
// The maps stay wired into the run so the work is one edit away when Completion
// is actually imported, but they are empty and this import writes neither.
const DANGLING = {};
const STRIP = {};

// KNOWN, DELIBERATELY LEFT ALONE - do not "fix" these here:
//   9.00 Mechanical Completion ($160,000) points at the 5.2 SUMMARY row. That
//        link is live now that 5.2 exists. It reads 0% today because every
//        mechanical task is Not Started with a null percent, so nothing is
//        mis-billed yet - but it starts averaging Sunstall's sixteen tasks the
//        moment the first one progresses, currently 2026-10-30. Mechanical
//        Completion is the EPC Exhibit J milestone certified to the Owner, not
//        Sunstall finishing (Phil, 2026-09-03), so it must be resolved before
//        then. It belongs in the Completion import, not this one.
//   12.00 Final Completion ($0) points at 5.2.17, which no longer exists, plus
//        two civil codes the civil re-import retired. No money attached.
//   8.03 Optimizer/String Wire ($20,000) points at 5.3.x. Resolves with the
//        electrical import. Never modified by this script.

// ---- Contract quantities from Exhibit B / Schedule of Values ---------------
// The commodity totals seeded in 0035 are the client's placeholders. Percent
// complete on 8.01 and 8.02 divides installed quantity by these, so a wrong
// total is a wrong bill: at 500 piles instead of 412, every pile driven earns
// 18% less than it should.
//
// The counts come from the FTC Solar tracker BOM (03_Engineering/BOM_Single_Lines/
// SS_BOM_Working_Copy.xlsx), which resolves the racking row count the SOV omits.
// The BOM breaks the array into four row types and gives a per-row-type quantity
// for every part, so the row count can be solved rather than guessed:
//
//   torque beams   INT PARTIAL 32 @ 2/row -> 16 interior 2-string rows
//                  INT 1S      48 @ 2/row -> 24 interior 1-string rows
//                  EXT PARTIAL 24 @ 2/row -> 12 exterior 2-string rows
//                  EXT 1S      16 @ 2/row ->  8 exterior 1-string rows
//                                            ---
//                                             60 rows
//
// and three independent one-per-row parts agree exactly: slew drives 60,
// row controllers v3 60, W6x25 drive posts 60.
//
// The piles then check out arithmetically, which is what makes the whole set
// trustworthy: 60 drive posts + passive posts at 8/8/4/4 per row type
// (8x16 + 4x24 + 8x12 + 4x8 = 352) = 412, exactly the SOV's figure.
const COMMODITY_TOTALS = {
  piles:   { total: 412,  why: "Sunstall Exhibit B line 2 ('approximately 412 piles'), confirmed by the FTC BOM: 60 W6x25 drive posts + 352 W6x7 passive posts" },
  racking: { total: 60,   why: "FTC BOM: 60 slew drives / 60 row controllers / 60 drive posts, and the torque-beam solve 16+24+12+8 = 60 rows" },
  // modules stays on the SUBCONTRACT figure, not the BOM figure - see the flag.
  // The BOM's module rail, cam plate and python clip all come to 2,616
  // (28 two-string rows x 58 + 32 one-string rows x 31), 260 more than the
  // executed subcontract's "approximately 2,356". Both are internally
  // consistent, so this is a real discrepancy and not an arithmetic slip. The
  // executed document wins until someone confirms which layout is current.
  modules: { total: 2356, why: "Sunstall Exhibit B line 4: 'install approximately 2,356 modules' (executed 2026-08-20)" },
};

// ===========================================================================
const parentOf = (c) => (c.includes(".") ? c.slice(0, c.lastIndexOf(".")) : null);
const newCodes = new Set(NEW.map((r) => r[0]));
const summaryCodes = new Set(NEW.map((r) => parentOf(r[0])).filter((p) => p && newCodes.has(p)));
const newByCode = Object.fromEntries(NEW.map((r) => [r[0], r]));

const { data: tasks, error: tErr } = await sb.from("schedule_tasks").select("*").eq("project_id", PID);
if (tErr) { console.error("FATAL reading schedule_tasks: " + tErr.message); process.exit(1); }
const liveCodes = new Set(tasks.map((t) => t.wbs_code));
const existingMech = tasks.filter((t) => t.wbs_code === "5.2" || (t.wbs_code || "").startsWith("5.2."));

const { data: bl, error: bErr } = await sb.from("billing_lines").select("id,item_number,description,scheduled_value,linked_task_wbs_codes").eq("project_id", PID);
if (bErr) { console.error("FATAL reading billing_lines: " + bErr.message); process.exit(1); }
const blByItem = Object.fromEntries(bl.map((l) => [l.item_number, l]));

const { data: comms } = await sb.from("commodities").select("id,key,label,uom,total_quantity,total_verified,sov_item,category").eq("project_id", PID).eq("category", "mechanical");

// --- validate --------------------------------------------------------------
// A partially-applied run leaves 5.2 rows behind (the first attempt died on the
// integer-duration column after inserting two). Re-running must be able to clear
// them - but only after proving nothing is attached. Pins are the thing that
// must never be destroyed by a re-import, so that is checked against the
// database rather than assumed from history.
const { data: mechPins } = existingMech.length
  ? await sb.from("inspections").select("id, dpr_id").in("schedule_task_id", existingMech.map((t) => t.id))
  : { data: [] };

const problems = [];
if (mechPins && mechPins.length) {
  problems.push(`${mechPins.length} field-report pin(s) are attached to existing 5.2 tasks. This script deletes and recreates the branch, which would orphan them. Write a remap instead.`);
}
for (const [item, codes] of Object.entries(SOV)) {
  if (!blByItem[item]) problems.push(`SOV ${item} is not a billing line on this project`);
  for (const c of codes) {
    if (!newCodes.has(c)) problems.push(`SOV ${item} references ${c}, not in the new schedule`);
    if (summaryCodes.has(c)) problems.push(`SOV ${item} references ${c}, which is a SUMMARY row`);
  }
}
// Grammar copied verbatim from src/lib/schedule-cpm.ts:138. Validating against
// a hand-rolled approximation is how "5.2.4SS+3d" got through the first time:
// the trailing unit made the token fail the real regex, parsePredecessors drops
// an unmatched token silently, and three tasks imported with no logic at all.
const REL_RE = /^([0-9.]+?)(FS|SS|FF|SF)?([+-]\d+)?$/i;
for (const r of NEW) {
  const p = r[6];
  if (!p) continue;
  for (const dep of p.split(",").map((s) => s.trim())) {
    const m = dep.match(REL_RE);
    if (!m) { problems.push(`${r[0]} predecessor "${dep}" cannot be parsed by the CPM engine - lag is "+3", not "+3d"`); continue; }
    const code = m[1];
    // A predecessor may point outside the mechanical branch (5.2.1 succeeds
    // civil Site Grading), so check the live schedule too - but check it, since
    // a link to a code with no task is silently ignored by the CPM engine.
    if (!newCodes.has(code) && !liveCodes.has(code)) problems.push(`${r[0]} predecessor "${dep}" resolves to ${code}, which is neither in the new schedule nor live`);
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
console.log(`\n  Live schedule holds ${tasks.length} tasks, ${existingMech.length} of them under 5.2.`);
if (existingMech.length) console.log(`  Those ${existingMech.length} carry no pins and will be DELETED first (${existingMech.map((t) => t.wbs_code).join(", ")}), then all ${NEW.length} rows re-inserted.\n`);
else console.log(`  All ${NEW.length} rows below are INSERTS.\n`);
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
for (const [item, codes] of Object.entries(STRIP)) {
  const line = blByItem[item];
  if (!line) continue;
  const was = line.linked_task_wbs_codes || [];
  const now = was.filter((c) => !codes.includes(c));
  if (JSON.stringify(was) === JSON.stringify(now)) continue;
  console.log(`\n  ${item}  ${String(line.description).replace(/\n/g, " ").slice(0, 60)}   $${Number(line.scheduled_value).toLocaleString()}`);
  console.log(`      STRIPPED ${codes.join(", ")}:  ${was.join(", ")}  ->  ${now.length ? now.join(", ") : "(none)"}`);
  console.log(`      Mechanical Completion is the EPC milestone under Exhibit J, not Sunstall's scope finishing.`);
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
flags.push(`MODULE COUNT DISCREPANCY. The executed subcontract says "approximately 2,356 modules"; the FTC BOM's module rail / cam plate / python clip counts all come to 2,616 (28 two-string rows x 58 + 32 one-string rows x 31). Both are internally consistent, so this is 260 real modules, ~11%, not a rounding difference. Applied as 2,356 because the subcontract is the executed document, but SOV 8.02 ($${Number(blByItem["8.02"].scheduled_value).toLocaleString()}) divides by this number, and Sunstall's $45,000 lump sum was priced against 2,356. Confirm which layout is current before the first module goes on.`);
const l900 = blByItem["9.00"];
if (l900) flags.push(`9.00 "${l900.description.trim()}" ($${Number(l900.scheduled_value).toLocaleString()}) is DE-LINKED from 5.2 by this import. It keeps only 5.4.1, which has no task yet, so the line earns nothing and reads as unsubstantiated until the 5.4 Completion branch is imported. That is the intended state - it is the EPC Exhibit J milestone, not Sunstall's completion.`);
const l803 = blByItem["8.03"];
if (l803) flags.push(`8.03 "${l803.description.trim()}" ($${Number(l803.scheduled_value).toLocaleString()}) links to ${JSON.stringify(l803.linked_task_wbs_codes)} - electrical codes with no tasks live. Outside Sunstall's scope (Exhibit A excludes all electrical). Untouched; resolves when 5.3 is imported.`);
const sg = tasks.find((t) => t.wbs_code === "5.1.3.2");
flags.push(`5.2.1 Array Layout now succeeds 5.1.3.2 Site Grading (${sg?.start_date} to ${sg?.end_date}), which anchors the whole branch. Mechanical starts 2026-10-30, so there are ~6 working days of float behind civil. Beyond that, civil slippage pushes mechanical - and under Section 3.4 that is a "delay due to others", so it relieves Sunstall of the $500/day LDs rather than triggering them.`);
flags.push(`Pile Delivery (source row 121) is NOT linked. It is procurement, which is not in the schedule yet. Piles must be on site before 5.2.2 Pile Unloading on 2026-11-02 and nothing in the app will warn if that delivery slips. Add the link when the procurement branch is imported.`);
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

// 1a. Clear any partially-applied branch. Proven pin-free above.
for (const t of existingMech) {
  const { error } = await sb.from("schedule_tasks").delete().eq("id", t.id);
  if (error) { console.error(`FATAL deleting stale ${t.wbs_code}: ${error.message}`); process.exit(1); }
}
if (existingMech.length) console.log(`Cleared ${existingMech.length} stale 5.2 row(s).`);

// 1b. Insert the tasks. Sort order continues past civil's last row (240) so the
//    mechanical branch lands below it in schedule views ordered by sort_order.
let sort = 300;
let inserted = 0;
for (const r of NEW) {
  const { error } = await sb.from("schedule_tasks").insert({
    project_id: PID,
    wbs_code: r[0],
    task_name: r[1],
    description: [NOTE[r[0]], HALF_DAY[r[0]]].filter(Boolean).join(" ") || null,
    status: r[2],
    duration_days: Math.max(1, Math.round(r[3])),
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
    baseline_duration_days: Math.max(1, Math.round(r[3])),
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
// 4. Strip codes that must not earn this line.
for (const [item, codes] of Object.entries(STRIP)) {
  const line = blByItem[item];
  if (!line) continue;
  const now = (line.linked_task_wbs_codes || []).filter((c) => !codes.includes(c));
  if (JSON.stringify(line.linked_task_wbs_codes) === JSON.stringify(now)) continue;
  const { error } = await sb.from("billing_lines").update({ linked_task_wbs_codes: now }).eq("id", line.id);
  if (error) { console.error(`FATAL stripping codes on ${item}: ${error.message}`); process.exit(1); }
}
// 5. Correct the contract quantities. total_verified is set at the same time:
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
