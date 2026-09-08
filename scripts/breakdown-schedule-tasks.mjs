// Break a lump schedule task into the work items the field actually reports
// on, and repair the references that a leaf-to-summary promotion silently
// breaks.
//
// WHY THE BREAKDOWN EXISTS
// The sub could not put a defensible percentage on "Construct Basin 1 ESC" as
// a single line, so eleven days of reports came back as guesses between 2% and
// 90%. Items that each get COMPLETED replace an estimate with an observation:
// the riser is either in or it is not. The percentage is then arithmetic over
// the items, which is a number that survives being asked where it came from.
//
// WHAT A LEAF-TO-SUMMARY PROMOTION BREAKS, SILENTLY
// Nothing warns you. Four code paths change behaviour the moment a task has a
// child, and three of them fail quietly rather than loudly:
//
//   1. CPM.  leavesOf() (schedule-cpm.ts:189) drops summary rows from the
//      graph, and an unresolvable predecessor is SKIPPED, not errored. Any
//      successor naming the parent would quietly stop waiting on it and
//      forecast as if it could start on day one. Every such link is repointed
//      to the last subtask.
//
//   2. Incoming logic.  A summary loses its own predecessors too. The first
//      child inherits them. Missed on the first pass against 5.1.1.8, which
//      waited on 5.1.1.7.7 and briefly forecast three days early because the
//      link had nowhere to live.
//
//   3. Billing.  computeBillingSuggestions strips summary codes out of a SOV
//      line's links (billing-actions.ts:298), so a percent on a six-figure
//      owner SOV line moves with no edit and no record. The parent's link is
//      replaced with the leaves it decomposes to.
//
//   4. Pinning.  summaryCodesOf() (schedule-picker.ts:63) removes summary rows
//      from the DPR task picker, so the crew can no longer pin to the parent.
//      That is the intended effect - it is why we are doing this - but existing
//      pins stay attached to the parent and its stored percent is ignored by
//      the rollup from here on. Not repaired here; the count is printed.
//
// DATES INVENT NOTHING
// Every breakdown fills its parent's existing baselined window exactly, and
// carries the parent's baseline label down so variance still reads against the
// original commitment. Durations are counted from the dates rather than typed,
// so the two can never disagree.
//
// NOTE: dates do not roll up. If real durations run past the parent's end
// date, the parent row keeps its stored dates and has to be edited too.
//
//   node scripts/breakdown-schedule-tasks.mjs --parent=5.1.3.3 --dry-run
//   node scripts/breakdown-schedule-tasks.mjs --parent=5.1.3.3 --replace

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
// --replace tears out an existing breakdown first. Without it a parent that
// already has children is refused, so a re-run cannot quietly double them up.
const REPLACE = process.argv.includes("--replace");

const parentArg = process.argv.find((a) => a.startsWith("--parent="));
const PARENT = parentArg ? parentArg.slice("--parent=".length) : null;

// [n, name, start, end, predecessor?]
// Duration is counted from the dates, never typed.

// Both Phase 1 ESC basins are the same scope for the same sub over the same
// 7-working-day window, so they take the same item list rather than a second
// invented one.
const BASIN_ESC = [
  [1, "Culvert outflow",       "2026-08-13", "2026-08-13"],
  [2, "Riser install",         "2026-08-14", "2026-08-14"],
  [3, "Lined inlets install",  "2026-08-17", "2026-08-17"],
  [4, "Emergency spillway",    "2026-08-18", "2026-08-18"],
  [5, "Embankment",            "2026-08-19", "2026-08-19"],
  [6, "Diversion ditch line",  "2026-08-20", "2026-08-20"],
  [7, "Matting and seeding",   "2026-08-21", "2026-08-21"],
];

// PHASE 2 IS NOT A SECOND BASIN BUILD.
// The basins already exist - Phase 1 built them as ESC sediment basins. Phase 2
// converts them to permanent stormwater ponds, so the work is dewater, muck out
// the sediment that collected while they were doing their ESC job, and seed.
// An earlier revision put the Phase 1 construction items here, which described
// building a basin that was already built.
const BASIN_CONVERSION_1 = [
  [1, "Dewatering",        "2026-10-21", "2026-10-22"],
  [2, "Muck and cleanout", "2026-10-23", "2026-10-26"],
  [3, "Permanent seeding", "2026-10-27", "2026-10-27"],
];
const BASIN_CONVERSION_2 = [
  [1, "Dewatering",        "2026-10-28", "2026-10-29"],
  [2, "Muck and cleanout", "2026-10-30", "2026-11-03"],
  [3, "Permanent seeding", "2026-11-04", "2026-11-04"],
];

const BREAKDOWNS = {
  "5.1.1.6": BASIN_ESC,            // Construct Basin 1 ESC, 7 working days
  "5.1.1.7": BASIN_ESC,            // Construct Basin 2 ESC, 7 working days
  "5.1.1.8": [                     // Construct Construction Entrance, 2 days
    [1, "Culvert under main entrance",  "2026-08-24", "2026-08-24"],
    [2, "Ditch line tie in to culvert", "2026-08-25", "2026-08-25"],
  ],
  "5.1.3.3": BASIN_CONVERSION_1,   // Build Basin 1, 5 working days
  "5.1.3.4": BASIN_CONVERSION_2,   // Build Basin 2, 6 working days
};

if (!PARENT || !BREAKDOWNS[PARENT]) {
  console.error("Usage: node scripts/breakdown-schedule-tasks.mjs --parent=<wbs> [--replace] [--dry-run]");
  console.error(`Known: ${Object.keys(BREAKDOWNS).join(", ")}`);
  process.exit(1);
}
const CHILDREN = BREAKDOWNS[PARENT];
const LAST = `${PARENT}.${CHILDREN.length}`;
const NEW_CODES = CHILDREN.map(([n]) => `${PARENT}.${n}`);

/** Mon-Fri days inclusive. The windows here contain no federal holidays. */
function workingDays(a, b) {
  let n = 0;
  for (let d = new Date(`${a}T00:00:00Z`); d <= new Date(`${b}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

/** Strip a relationship suffix and lag: "5.1.3.3.7SS+2" -> "5.1.3.3.7". */
const bare = (tok) => tok.trim().replace(/(SS|FF|SF|FS)?([+-]\d+d?)?$/i, "");

const { data: tasks, error: tErr } = await sb
  .from("schedule_tasks").select("*").eq("project_id", PID);
if (tErr) { console.error(tErr); process.exit(1); }

const parent = tasks.find((t) => t.wbs_code === PARENT);
if (!parent) { console.error(`${PARENT} not found`); process.exit(1); }

const existing = tasks.filter((t) => t.wbs_code.startsWith(PARENT + "."));
if (existing.length && !REPLACE) {
  console.error(`${PARENT} already has ${existing.length} child row(s). Pass --replace to rebuild them.`);
  process.exit(1);
}

// Anything outside the branch that points at the parent OR at a child being
// torn out has to land somewhere real. From outside, the meaningful anchor is
// "this branch finished", so every such reference goes to the new last child.
const retired = new Set([PARENT, ...existing.map((t) => t.wbs_code)]);
const doomed = new Set(existing.map((t) => t.wbs_code));

// Stranded pins, reported but not moved: reassigning them would mean inventing
// which item earned the work.
const { data: pins } = await sb
  .from("inspections").select("id, status")
  .eq("project_id", PID).eq("schedule_task_id", parent.id);

const rows = CHILDREN.map(([n, name, start, end, pred]) => ({
  project_id: PID,
  wbs_code: `${PARENT}.${n}`,
  task_name: name,
  phase: parent.phase,
  assigned_to: parent.assigned_to,
  status: "Not Started",
  duration_days: workingDays(start, end),
  start_date: start,
  end_date: end,
  // The first child inherits the parent's own predecessors - see note 2 above.
  predecessors: pred ?? (n === 1 ? (parent.predecessors ?? null) : `${PARENT}.${n - 1}`),
  is_at_risk: false,
  is_internal: parent.is_internal,
  non_ahc_delay: false,
  is_milestone: false,
  level_code: `${PARENT}.${n}`.split(".").length,
  parent_wbs_code: PARENT,
  // sort_order convention for a branch is parent + 1, 2, ... Parents sit on
  // multiples of 10, so this slots in without renumbering anything.
  sort_order: (parent.sort_order ?? 0) + n,
  // Carrying the parent's baseline label down keeps every variance report
  // reading against the same commitment instead of showing unbaselined rows.
  baseline_start: start,
  baseline_end: end,
  baseline_duration_days: workingDays(start, end),
  baseline_set_at: parent.baseline_set_at,
  baseline_label: parent.baseline_label,
}));

// --- Reference repairs -----------------------------------------------------
// Summary rows are included deliberately: a summary still stores predecessors,
// and its first child inherits them, so a stale link there is a real one.
const predFixes = tasks
  .filter((t) => !doomed.has(t.wbs_code) && t.wbs_code !== PARENT)
  .filter((t) => (t.predecessors ?? "").split(",").some((p) => retired.has(bare(p))))
  .map((t) => ({
    id: t.id,
    wbs_code: t.wbs_code,
    task_name: t.task_name,
    before: t.predecessors,
    after: t.predecessors.split(",")
      .map((p) => (retired.has(bare(p)) ? p.trim().replace(bare(p), LAST) : p.trim()))
      // A successor that named two retired codes would now name LAST twice.
      .filter((p, i, a) => a.indexOf(p) === i)
      .join(", "),
  }));

// The parent's own predecessors move to child 1, so if the parent itself points
// at a retired code (it can, after a prior run repointed it), fix it too.
const parentPredFix = (parent.predecessors ?? "").split(",").some((p) => retired.has(bare(p)))
  ? {
      id: parent.id,
      wbs_code: parent.wbs_code,
      after: parent.predecessors.split(",")
        .map((p) => (retired.has(bare(p)) ? p.trim().replace(bare(p), LAST) : p.trim()))
        .join(", "),
    }
  : null;

const { data: lines, error: lErr } = await sb
  .from("billing_lines")
  .select("id, item_number, description, scheduled_value, linked_task_wbs_codes")
  .eq("project_id", PID);
if (lErr) { console.error(lErr); process.exit(1); }

const lineFixes = (lines ?? [])
  .filter((l) => (l.linked_task_wbs_codes ?? []).some((c) => retired.has(c)))
  .map((l) => {
    // Expand at the first retired code and drop the rest, so a line that named
    // all seven old leaves does not come back naming the new ones seven times.
    const after = [];
    let inserted = false;
    for (const c of l.linked_task_wbs_codes) {
      if (retired.has(c)) { if (!inserted) { after.push(...NEW_CODES); inserted = true; } }
      else after.push(c);
    }
    return { id: l.id, item_number: l.item_number, description: l.description, before: l.linked_task_wbs_codes, after };
  });

// --- Report ----------------------------------------------------------------
console.log(`${DRY ? "DRY RUN" : "APPLYING"} - ${REPLACE ? "REPLACING" : "adding"} subtasks under ${PARENT} ${parent.task_name}\n`);
if (existing.length) {
  console.log(`DELETE ${existing.length} existing child row(s)`);
  for (const e of existing.sort((a, b) => a.wbs_code.localeCompare(b.wbs_code))) {
    console.log(`  ${e.wbs_code.padEnd(11)} ${e.task_name}`);
  }
  console.log("");
}
console.log("INSERT");
for (const r of rows) {
  console.log(`  ${r.wbs_code.padEnd(11)} ${r.task_name.padEnd(28)} ${r.start_date} -> ${r.end_date}  ${r.duration_days}d  pred ${r.predecessors ?? "-"}`);
}
console.log(`  ${rows.reduce((s, r) => s + r.duration_days, 0)} working days total; parent window is ${parent.start_date} -> ${parent.end_date} (${workingDays(parent.start_date, parent.end_date)}d)`);

console.log("\nPREDECESSOR REPOINTS (summary rows are dropped from the CPM graph)");
if (!predFixes.length && !parentPredFix) console.log("  none");
if (parentPredFix) console.log(`  ${parentPredFix.wbs_code} (the parent itself)\n    before: ${parent.predecessors}\n    after:  ${parentPredFix.after}`);
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
if (pins?.length) {
  console.log(`\nPINS stranded on the parent: ${pins.length} (${pins.map((p) => p.status).join(", ")})`);
  console.log("  Left attached. The parent's stored percent is ignored by the rollup from here on.");
}

if (DRY) { console.log("\nNothing written."); process.exit(0); }

// --- Write -----------------------------------------------------------------
// Order matters. Repoint the survivors off the doomed codes FIRST, so the
// schedule never contains a predecessor pointing at a row that is already gone.
if (parentPredFix) {
  const r = await sb.from("schedule_tasks").update({ predecessors: parentPredFix.after }).eq("id", parentPredFix.id);
  if (r.error) { console.error("PARENT PRED UPDATE FAILED", r.error); process.exit(1); }
  console.log(`\nRepointed ${parentPredFix.wbs_code} (parent).`);
}
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
if (existing.length) {
  const del = await sb.from("schedule_tasks").delete().in("id", existing.map((e) => e.id));
  if (del.error) { console.error("DELETE FAILED:", del.error); process.exit(1); }
  console.log(`Deleted ${existing.length} old child row(s).`);
}
const ins = await sb.from("schedule_tasks").insert(rows).select("wbs_code");
if (ins.error) { console.error("INSERT FAILED:", ins.error); process.exit(1); }
console.log(`Inserted ${ins.data.length} tasks.`);
console.log("\nDone.");
