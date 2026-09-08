// Break a "Construct Basin N ESC" lump task into the seven work items the field
// actually reports on, and repair the references that a leaf-to-summary
// promotion silently breaks.
//
// WHY THE BREAKDOWN EXISTS
// The sub could not put a defensible percentage on "Construct Basin 1 ESC" as
// a single line, so eleven days of reports came back as guesses between 2% and
// 90%. Seven items that each get COMPLETED replace an estimate with an
// observation: the riser is either in or it is not. The percentage is then
// arithmetic over the seven, which is a number that survives being asked where
// it came from.
//
// WHY THIS IS NOT JUST SEVEN INSERTS
// The moment 5.1.1.6 has children it stops being a leaf, and three things in
// the app change behaviour without saying so:
//
//   1. CPM.  leavesOf() (schedule-cpm.ts:189) drops summary rows from the
//      graph, and an unresolvable predecessor is SKIPPED, not errored. So
//      "5.1.1.11 County Inspection", which lists 5.1.1.6 as a predecessor,
//      would quietly stop waiting on Basin 1 and forecast as if it could start
//      on day one. Its link is repointed to the last Basin 1 subtask.
//
//   2. Billing.  computeBillingSuggestions strips summary codes out of a SOV
//      line's links (billing-actions.ts:298). Line 6.03 Fencing/SWPPP
//      ($203,835.79) links to 5.1.1.6, so the link would be dropped and the
//      duration-weighted percent on a $203K line would move with no edit and
//      no record. The link is replaced with the seven leaves it decomposes to.
//
//   3. Pinning.  summaryCodesOf() (schedule-picker.ts:63) removes summary rows
//      from the DPR task picker, so the crew can no longer pin to 5.1.1.6.
//      That is the intended effect - it is why we are doing this - but the
//      eight existing pins stay attached to the parent and its stored 5% is
//      ignored by the rollup from here on. Not repaired by this script; see
//      the note printed at the end.
//
// DATES
// The seven subtasks fill the parent's existing baselined window exactly -
// 2026-08-13 to 2026-08-21 is 7 working days, one per item, chained FS. This
// invents no slip and moves no parent date. It is the original allowance,
// itemised. Real durations come from the CM; re-forecast in the grid.
//
// NOTE: dates do not roll up. If the real durations run past the parent's end
// date, the parent row keeps its stored dates and has to be edited too.
//
//   node scripts/breakdown-schedule-tasks.mjs --parent=5.1.1.8 --dry-run
//   node scripts/breakdown-schedule-tasks.mjs --parent=5.1.1.8

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

// Which lump task to break down. Basin 1 ran 2026-09-08; Basin 2 is the same
// scope, the same sub and the same 7-working-day window, so it takes the same
// item list rather than a second invented one.
const parentArg = process.argv.find((a) => a.startsWith("--parent="));
const PARENT = parentArg ? parentArg.slice("--parent=".length) : null;

// [wbs suffix, name, start, end] - one working day each, FS chained, filling
// the parent's existing baselined window exactly. Every breakdown below fits
// its parent's planned span with no day left over, so none of them invents
// slip or moves a parent date.
//
// Both basins are the same scope for the same sub over the same 7-day window,
// so they take the same item list rather than a second invented one.
const BASIN_ESC = [
  [1, "Culvert outflow",       "2026-08-13", "2026-08-13"],
  [2, "Riser install",         "2026-08-14", "2026-08-14"],
  [3, "Lined inlets install",  "2026-08-17", "2026-08-17"],
  [4, "Emergency spillway",    "2026-08-18", "2026-08-18"],
  [5, "Embankment",            "2026-08-19", "2026-08-19"],
  [6, "Diversion ditch line",  "2026-08-20", "2026-08-20"],
  [7, "Matting and seeding",   "2026-08-21", "2026-08-21"],
];

const BREAKDOWNS = {
  "5.1.1.6": BASIN_ESC, // Construct Basin 1 ESC, applied 2026-09-08
  "5.1.1.7": BASIN_ESC, // Construct Basin 2 ESC, applied 2026-09-08
  "5.1.1.8": [         // Construct Construction Entrance, 2 days
    [1, "Culvert under main entrance",   "2026-08-24", "2026-08-24"],
    [2, "Ditch line tie in to culvert",  "2026-08-25", "2026-08-25"],
  ],
  // PHASE 2 PERMANENT BASINS - the same seven items, but they do NOT fit one
  // per day: Build Basin 1 is 5 working days and Build Basin 2 is 6. Rather
  // than stretch the parent - which would push Final Grading, Convert to
  // Stormwater Ponds and Permanent Seeding, and invent slip nobody has
  // forecast - the items that a crew would realistically run together are
  // overlapped start-to-start. The 5th element is an explicit predecessor.
  // These overlaps are a placeholder that fits the committed window. They are
  // the first thing the CM's real durations should overwrite.
  "5.1.3.3": [        // Build Basin 1, 5 working days, Oct 21-27
    [1, "Culvert outflow",      "2026-10-21", "2026-10-21"],
    [2, "Riser install",        "2026-10-22", "2026-10-22", "5.1.3.3.1"],
    [3, "Lined inlets install", "2026-10-22", "2026-10-22", "5.1.3.3.2SS"],
    [4, "Emergency spillway",   "2026-10-23", "2026-10-23", "5.1.3.3.2, 5.1.3.3.3"],
    [5, "Embankment",           "2026-10-26", "2026-10-26", "5.1.3.3.4"],
    [6, "Diversion ditch line", "2026-10-26", "2026-10-26", "5.1.3.3.5SS"],
    [7, "Matting and seeding",  "2026-10-27", "2026-10-27", "5.1.3.3.5, 5.1.3.3.6"],
  ],
  "5.1.3.4": [        // Build Basin 2, 6 working days, Oct 28 - Nov 4
    [1, "Culvert outflow",      "2026-10-28", "2026-10-28"],
    [2, "Riser install",        "2026-10-29", "2026-10-29", "5.1.3.4.1"],
    [3, "Lined inlets install", "2026-10-30", "2026-10-30", "5.1.3.4.2"],
    [4, "Emergency spillway",   "2026-11-02", "2026-11-02", "5.1.3.4.3"],
    [5, "Embankment",           "2026-11-03", "2026-11-03", "5.1.3.4.4"],
    [6, "Diversion ditch line", "2026-11-03", "2026-11-03", "5.1.3.4.5SS"],
    [7, "Matting and seeding",  "2026-11-04", "2026-11-04", "5.1.3.4.5, 5.1.3.4.6"],
  ],
};

if (!PARENT || !BREAKDOWNS[PARENT]) {
  console.error(`Usage: node scripts/breakdown-schedule-tasks.mjs --parent=<wbs> [--dry-run]`);
  console.error(`Known: ${Object.keys(BREAKDOWNS).join(", ")}`);
  process.exit(1);
}
const CHILDREN = BREAKDOWNS[PARENT];

const LAST = `${PARENT}.${CHILDREN.length}`;

const { data: tasks, error: tErr } = await sb
  .from("schedule_tasks").select("*").eq("project_id", PID);
if (tErr) { console.error(tErr); process.exit(1); }

const parent = tasks.find((t) => t.wbs_code === PARENT);
if (!parent) { console.error(`${PARENT} not found`); process.exit(1); }

const existing = tasks.filter((t) => t.wbs_code.startsWith(PARENT + "."));
if (existing.length) {
  console.error(`${PARENT} already has ${existing.length} child row(s). Refusing to re-run.`);
  process.exit(1);
}

// sort_order: the branch convention is parent + 1, 2, ... (schedule-actions.ts
// nextChildCode/slotting). Parent is 70 and the next sibling 5.1.1.7 is 80, so
// 71-77 slot in without renumbering anything.
// THE FIRST CHILD INHERITS THE PARENT'S PREDECESSORS.
// A summary row is dropped from the CPM graph, and its incoming logic goes
// with it - so a parent that waited on something produces a first child that
// waits on nothing and starts on the data date. This was missed on the first
// run against 5.1.1.8, which waited on 5.1.1.7.7 and briefly forecast three
// days early because the link had nowhere to live.
const rows = CHILDREN.map(([n, name, start, end, pred]) => ({
  project_id: PID,
  wbs_code: `${PARENT}.${n}`,
  task_name: name,
  phase: parent.phase,
  assigned_to: parent.assigned_to,
  status: "Not Started",
  duration_days: 1,
  start_date: start,
  end_date: end,
  predecessors: pred ?? (n === 1 ? (parent.predecessors ?? null) : `${PARENT}.${n - 1}`),
  is_at_risk: false,
  is_internal: parent.is_internal,
  non_ahc_delay: false,
  is_milestone: false,
  level_code: `${PARENT}.${n}`.split(".").length,
  parent_wbs_code: PARENT,
  sort_order: (parent.sort_order ?? 70) + n,
  // The parent is baselined "Civil schedule 2026-08-19" over exactly this
  // window. Carrying that label down keeps every variance report reading
  // against the same commitment instead of showing seven unbaselined rows.
  baseline_start: start,
  baseline_end: end,
  baseline_duration_days: 1,
  baseline_set_at: parent.baseline_set_at,
  baseline_label: parent.baseline_label,
}));

// --- Reference repairs -----------------------------------------------------
const succ = tasks.filter((t) =>
  (t.predecessors ?? "").split(",").some((p) => p.trim().replace(/(SS|FF|SF|FS)?([+-]\d+d?)?$/i, "") === PARENT),
);
const predFixes = succ.map((t) => ({
  id: t.id,
  wbs_code: t.wbs_code,
  task_name: t.task_name,
  before: t.predecessors,
  after: t.predecessors
    .split(",")
    .map((p) => (p.trim().replace(/(SS|FF|SF|FS)?([+-]\d+d?)?$/i, "") === PARENT
      ? p.trim().replace(PARENT, LAST) : p.trim()))
    .join(", "),
}));

const { data: lines, error: lErr } = await sb
  .from("billing_lines")
  .select("id, item_number, description, scheduled_value, linked_task_wbs_codes")
  .eq("project_id", PID);
if (lErr) { console.error(lErr); process.exit(1); }
const lineFixes = (lines ?? [])
  .filter((l) => (l.linked_task_wbs_codes ?? []).includes(PARENT))
  .map((l) => ({
    id: l.id,
    item_number: l.item_number,
    description: l.description,
    before: l.linked_task_wbs_codes,
    after: l.linked_task_wbs_codes.flatMap((c) =>
      c === PARENT ? rows.map((r) => r.wbs_code) : [c]),
  }));

// --- Report ----------------------------------------------------------------
console.log(`${DRY ? "DRY RUN" : "APPLYING"} - subtasks under ${PARENT} ${parent.task_name}\n`);
console.log("INSERT");
for (const r of rows) {
  console.log(`  ${r.wbs_code.padEnd(10)} ${r.task_name.padEnd(22)} ${r.start_date} -> ${r.end_date}  ${r.duration_days}d  pred ${r.predecessors ?? "-"}`);
}
console.log("\nPREDECESSOR REPOINTS (summary rows are dropped from the CPM graph)");
if (!predFixes.length) console.log("  none");
for (const f of predFixes) {
  console.log(`  ${f.wbs_code} ${f.task_name}`);
  console.log(`    before: ${f.before}`);
  console.log(`    after:  ${f.after}`);
}
console.log("\nSOV RELINKS (summary links are stripped from billing suggestions)");
if (!lineFixes.length) console.log("  none");
for (const f of lineFixes) {
  console.log(`  ${f.item_number} ${f.description}`);
  console.log(`    before: ${JSON.stringify(f.before)}`);
  console.log(`    after:  ${JSON.stringify(f.after)}`);
}

if (DRY) {
  console.log("\nNothing written.");
  process.exit(0);
}

const ins = await sb.from("schedule_tasks").insert(rows).select("wbs_code");
if (ins.error) { console.error("INSERT FAILED:", ins.error); process.exit(1); }
console.log(`\nInserted ${ins.data.length} tasks.`);

for (const f of predFixes) {
  const r = await sb.from("schedule_tasks").update({ predecessors: f.after }).eq("id", f.id);
  if (r.error) { console.error("PRED UPDATE FAILED", f.wbs_code, r.error); process.exit(1); }
  console.log(`Repointed ${f.wbs_code}.`);
}
for (const f of lineFixes) {
  const r = await sb.from("billing_lines").update({ linked_task_wbs_codes: f.after }).eq("id", f.id);
  if (r.error) { console.error("SOV UPDATE FAILED", f.item_number, r.error); process.exit(1); }
  console.log(`Relinked SOV ${f.item_number}.`);
}
console.log("\nDone.");
