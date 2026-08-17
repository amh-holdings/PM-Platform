// Re-baseline the Sweet Springs CIVIL schedule (5.1.x) against the field.
//
// Source of truth for weeks 1-4 is Dennis Brookman's (Pyramid Excavation)
// look-ahead emailed to Mark on 2026-08-17:
//   Aug 17-21  finish timber processing + wood chip haul; begin debris/stump
//              haul; basins 1 & 2 de-stumped, cleared, topsoil stripped; begin
//              Basin 1 install; install RCP @ entrance; begin roadway 19th/20th
//   Aug 24-28  complete entrance, roadway, temp parking, begin laydown yard
//   Aug 31-9/4 complete Basin 1 & 2; county E&S inspections; begin full
//              de-stump/clearing with county approval
//   Sep 8-11   begin mass grading
//
// Everything after Sep 11 is derived (the sub's look-ahead stops there) and is
// flagged for Mark to confirm. Phil's decisions of 2026-08-17:
//   - ESC measures stay Not Started; they start alongside the basins.
//   - Fencing is a different sub (Hercules Fence) and comes out of the flow.
//   - "Flag runoff reduction compliance areas" is dropped.
//   - Progress is percent-only. Mark is final say on the number, so no target
//     quantities are set here.
//
// Dry run by default. Pass --apply to write.
//
//   node scripts/rebaseline-civil-2026-08.mjs
//   node scripts/rebaseline-civil-2026-08.mjs --apply

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
const PYRAMID = "Pyramid Excavation LLC";
const HERCULES = "Hercules Fence";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------- plan

// Tasks removed from the schedule entirely.
const DELETE = ["5.1.1.3"];

// WBS renumbers, applied before inserts so the unique(project_id, wbs_code)
// constraint stays satisfied. Permit Closeout moves down to make room for the
// new Mass Grading section, which belongs mid-flow rather than at the end.
const RENUMBER = [{ from: "5.1.3", to: "5.1.4" }];

// Updates to existing tasks. Dates are ISO. `pred` is written as WBS codes -
// the column previously held raw Smartsheet row numbers that were off by one
// against sort_order and resolved to nothing. An SS suffix is start-to-start.
const UPDATE = {
  // --- 5.1.1 Phase 1: ESC and site setup -------------------------------
  "5.1.1.1":  { end: "2026-08-21", assigned: PYRAMID, pred: null },
  "5.1.1.2":  { end: "2026-08-28", assigned: PYRAMID, pred: "5.1.1.1" },
  "5.1.1.4":  { start: "2026-08-24", end: "2026-08-28", assigned: PYRAMID, pred: "5.1.1.2" },
  "5.1.1.5":  { end: "2026-08-21", assigned: PYRAMID, pred: "5.1.1.1" },
  // Fencing leaves Pyramid's flow. Dennis's look-ahead never mentions it, so
  // dates are left alone and flagged rather than invented.
  "5.1.1.6":  { assigned: HERCULES, pred: null, atRisk: true,
                desc: "Hercules Fence scope. Dates need Mark's confirmation - not covered by Pyramid's look-ahead." },
  "5.1.1.7":  { start: "2026-08-24", end: "2026-08-28", assigned: PYRAMID, pred: "5.1.1.5" },
  "5.1.1.8":  { start: "2026-08-24", end: "2026-08-25", assigned: PYRAMID, pred: "5.1.1.7" },
  "5.1.1.9":  { start: "2026-08-26", end: "2026-08-27", assigned: PYRAMID, pred: "5.1.1.8" },
  "5.1.1.10": { start: "2026-08-31", end: "2026-09-04", assigned: PYRAMID, pred: "5.1.1.9" },
  "5.1.1.11": { start: "2026-08-31", end: "2026-09-04", assigned: "Orange County", pred: "5.1.1.10" },

  // --- 5.1.2 Phase 2: clearing and basins ------------------------------
  "5.1.2.1":  { start: "2026-08-17", end: "2026-08-21", assigned: PYRAMID, pred: "5.1.1.5" },
  "5.1.2.2":  { start: "2026-08-20", end: "2026-09-04", assigned: PYRAMID, pred: "5.1.2.1" },
  "5.1.2.3":  { start: "2026-08-17", end: "2026-08-21", assigned: PYRAMID, pred: "5.1.2.1SS" },
  "5.1.2.4":  { start: "2026-08-24", end: "2026-09-04", assigned: PYRAMID, pred: "5.1.2.3" },
  "5.1.2.5":  { start: "2026-09-01", end: "2026-09-18", assigned: PYRAMID, pred: "5.1.2.2, 5.1.2.4" },
  // Beyond the look-ahead window - derived by shifting the original sequence.
  "5.1.2.6":  { start: "2026-09-21", end: "2026-09-25", assigned: PYRAMID, pred: "5.1.2.5", derived: true },
  "5.1.2.7":  { start: "2026-09-28", end: "2026-09-29", assigned: PYRAMID, pred: "5.1.2.6", derived: true },
  "5.1.2.8":  { start: "2026-09-30", end: "2026-10-01", assigned: PYRAMID, pred: "5.1.2.7", derived: true },
  "5.1.2.9":  { start: "2026-10-02", end: "2026-10-09", assigned: PYRAMID, pred: "5.1.2.8", derived: true },
};

// New tasks. `after` places the row in sequence; sort_order is rebuilt from
// WBS order at the end so the value itself does not matter here.
const INSERT = [
  { wbs: "5.1.1.12", name: "Install RCP culvert at entrance",
    start: "2026-08-17", end: "2026-08-21", pred: "5.1.1.2", assigned: PYRAMID },
  { wbs: "5.1.1.13", name: "Construct access roadway",
    start: "2026-08-19", end: "2026-08-28", pred: "5.1.1.12", assigned: PYRAMID },
  { wbs: "5.1.1.14", name: "Temporary parking area",
    start: "2026-08-24", end: "2026-08-28", pred: "5.1.1.13", assigned: PYRAMID },
  { wbs: "5.1.1.15", name: "Establish laydown yard",
    start: "2026-08-26", end: "2026-09-04", pred: "5.1.1.13", assigned: PYRAMID },
  { wbs: "5.1.2.10", name: "Timber processing and wood chip haul-off",
    start: "2026-08-17", end: "2026-08-21", pred: null, assigned: PYRAMID },
  { wbs: "5.1.2.11", name: "Debris and stump haul-off",
    start: "2026-08-17", end: "2026-09-04", pred: "5.1.2.10SS", assigned: PYRAMID },
  // Largest remaining civil scope and previously absent from the schedule.
  // Dennis gives a start only, so end_date is deliberately left null for Mark
  // to fill rather than guessed at.
  { wbs: "5.1.3", name: "Mass Grading",
    start: "2026-09-08", end: null, pred: "5.1.2.5SS", assigned: PYRAMID, atRisk: true,
    desc: "Duration TBD - Dennis's look-ahead gives a start date only. Needs Mark and Dennis to set the finish." },
];

// Summary rows whose spans are recomputed from their children.
const SUMMARY = ["5.1", "5.1.1", "5.1.2"];

// ---------------------------------------------------------------- helpers

const depthOf = (wbs) => String(wbs).split(".").length;
const wbsKey = (wbs) => String(wbs).split(".").map((n) => Number(n));
const cmpWbs = (a, b) => {
  const A = wbsKey(a), B = wbsKey(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? -1, y = B[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
};

function log(tag, msg) {
  console.log(`  ${tag.padEnd(9)} ${msg}`);
}

// ---------------------------------------------------------------- run

const { data: before, error: readErr } = await db
  .from("schedule_tasks")
  .select("*")
  .eq("project_id", PROJECT_ID);
if (readErr) {
  console.error(readErr);
  process.exit(1);
}
const byWbs = new Map(before.map((t) => [t.wbs_code, t]));

// Projected state, mutated alongside every DB write. The structural and
// summary passes run against this rather than re-reading, so a dry run reports
// exactly what an --apply run would do instead of echoing unchanged rows.
let projected = before.map((t) => ({ ...t }));
const projByWbs = () => new Map(projected.map((t) => [t.wbs_code, t]));

console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} - Sweet Springs civil re-baseline`);
console.log(`current tasks: ${before.length}\n`);

// 1. Deletes
console.log("DELETE");
for (const wbs of DELETE) {
  const t = byWbs.get(wbs);
  if (!t) { log("skip", `${wbs} not found`); continue; }
  log("delete", `${wbs}  ${t.task_name}`);
  if (APPLY) {
    const { error } = await db.from("schedule_tasks").delete().eq("id", t.id);
    if (error) { console.error(`  FAILED ${wbs}: ${error.message}`); process.exit(1); }
  }
  projected = projected.filter((p) => p.wbs_code !== wbs);
}

// 2. Renumbers
console.log("\nRENUMBER");
for (const { from, to } of RENUMBER) {
  const t = byWbs.get(from);
  if (!t) { log("skip", `${from} not found`); continue; }
  log("renum", `${from} -> ${to}   ${t.task_name}`);
  if (APPLY) {
    const { error } = await db.from("schedule_tasks")
      .update({ wbs_code: to }).eq("id", t.id);
    if (error) { console.error(`  FAILED ${from}: ${error.message}`); process.exit(1); }
  }
  const p = projected.find((x) => x.wbs_code === from);
  if (p) p.wbs_code = to;
}

// 3. Updates
console.log("\nUPDATE (existing civil tasks)");
for (const [wbs, u] of Object.entries(UPDATE)) {
  const t = byWbs.get(wbs);
  if (!t) { log("skip", `${wbs} not found`); continue; }
  const patch = {};
  if (u.start && u.start !== t.start_date) patch.start_date = u.start;
  if (u.end && u.end !== t.end_date) patch.end_date = u.end;
  if (u.assigned !== undefined && u.assigned !== t.assigned_to) patch.assigned_to = u.assigned;
  if (u.pred !== undefined && u.pred !== t.predecessors) patch.predecessors = u.pred;
  if (u.atRisk !== undefined && u.atRisk !== t.is_at_risk) patch.is_at_risk = u.atRisk;
  if (u.desc) patch.description = u.desc;
  if (!Object.keys(patch).length) { log("nochange", wbs); continue; }

  const bits = [];
  if (patch.start_date || patch.end_date)
    bits.push(`${t.start_date ?? "-"}→${t.end_date ?? "-"}  becomes  ${patch.start_date ?? t.start_date ?? "-"}→${patch.end_date ?? t.end_date ?? "-"}`);
  if (patch.assigned_to) bits.push(`assign=${patch.assigned_to}`);
  if (patch.predecessors !== undefined) bits.push(`pred=${patch.predecessors ?? "none"}`);
  log(u.derived ? "derived" : "update", `${wbs.padEnd(9)} ${String(t.task_name).slice(0, 38).padEnd(38)} ${bits.join("  ")}`);

  if (APPLY) {
    const { error } = await db.from("schedule_tasks").update(patch).eq("id", t.id);
    if (error) { console.error(`  FAILED ${wbs}: ${error.message}`); process.exit(1); }
  }
  Object.assign(projected.find((p) => p.wbs_code === wbs) ?? {}, patch);
}

// 4. Inserts. Checked against the projected state, not the original read, so
// the renumber above has already freed 5.1.3 for the new Mass Grading row.
console.log("\nINSERT (new tasks)");
for (const n of INSERT) {
  if (projByWbs().has(n.wbs)) { log("exists", `${n.wbs} already present, skipping`); continue; }
  log("insert", `${n.wbs.padEnd(9)} ${n.name.padEnd(42)} ${n.start}→${n.end ?? "TBD"}`);
  const row = {
    project_id: PROJECT_ID,
    wbs_code: n.wbs,
    task_name: n.name,
    description: n.desc ?? null,
    phase: "Construction",
    assigned_to: n.assigned,
    status: "Not Started",
    start_date: n.start,
    end_date: n.end,
    predecessors: n.pred,
    is_at_risk: n.atRisk ?? false,
    is_internal: false,
    level_code: depthOf(n.wbs),
    parent_wbs_code: n.wbs.split(".").slice(0, -1).join("."),
  };
  if (APPLY) {
    const { data: ins, error } = await db.from("schedule_tasks").insert(row).select("id").single();
    if (error) { console.error(`  FAILED ${n.wbs}: ${error.message}`); process.exit(1); }
    row.id = ins.id;
  }
  projected.push({ ...row, pct_complete: null, status_source: null });
}

// 5. Structural repairs across the whole project: level_code becomes true WBS
// depth (it held ordinal position, which pushed deep rows ~270px right), and
// sort_order is rebuilt from WBS order so the new rows slot in correctly.
const ordered = projected.slice().sort((a, b) => cmpWbs(a.wbs_code, b.wbs_code));

console.log("\nSTRUCTURAL (whole project)");
let lvlFixed = 0, sortFixed = 0;
for (let i = 0; i < ordered.length; i++) {
  const t = ordered[i];
  const patch = {};
  const trueDepth = depthOf(t.wbs_code);
  if (t.level_code !== trueDepth) { patch.level_code = trueDepth; lvlFixed++; }
  if (t.sort_order !== i) { patch.sort_order = i; sortFixed++; }
  const parent = t.wbs_code.split(".").slice(0, -1).join(".");
  if ((t.parent_wbs_code ?? "") !== parent) patch.parent_wbs_code = parent || null;
  if (!Object.keys(patch).length) continue;
  if (APPLY) {
    const { error } = await db.from("schedule_tasks").update(patch).eq("id", t.id);
    if (error) { console.error(`  FAILED ${t.wbs_code}: ${error.message}`); process.exit(1); }
  }
}
log("level", `${lvlFixed} rows corrected to true WBS depth`);
log("sort", `${sortFixed} rows resequenced by WBS order`);

// 6. Summary spans recomputed from descendants.
console.log("\nSUMMARY SPANS");
for (const wbs of SUMMARY) {
  const parent = ordered.find((t) => t.wbs_code === wbs);
  if (!parent) { log("skip", `${wbs} not found`); continue; }
  const kids = ordered.filter(
    (t) => t.wbs_code !== wbs && t.wbs_code.startsWith(wbs + ".") && (t.start_date || t.end_date),
  );
  if (!kids.length) { log("skip", `${wbs} has no dated children`); continue; }
  const starts = kids.map((k) => k.start_date).filter(Boolean).sort();
  const ends = kids.map((k) => k.end_date).filter(Boolean).sort();
  const start = starts[0] ?? null;
  const end = ends[ends.length - 1] ?? null;
  log("span", `${wbs.padEnd(9)} ${String(parent.task_name).slice(0, 26).padEnd(26)} ${parent.start_date ?? "-"}→${parent.end_date ?? "-"}  becomes  ${start}→${end}`);
  if (APPLY) {
    const { error } = await db.from("schedule_tasks")
      .update({ start_date: start, end_date: end }).eq("id", parent.id);
    if (error) { console.error(`  FAILED ${wbs}: ${error.message}`); process.exit(1); }
  }
}

// 7. Confirm nothing carrying field-report progress lost its number.
const PROGRESS_WBS = ["5.1.1.1", "5.1.1.2", "5.1.1.5", "1.2.2"];
console.log("\nPROGRESS PRESERVED");
const { data: check } = await db
  .from("schedule_tasks")
  .select("wbs_code, task_name, pct_complete, status, status_source, last_dpr_at")
  .eq("project_id", PROJECT_ID)
  .in("wbs_code", PROGRESS_WBS);
for (const t of check ?? [])
  log("ok", `${t.wbs_code.padEnd(9)} ${String(t.task_name).slice(0, 40).padEnd(40)} ${t.pct_complete}%  src=${t.status_source}  ${String(t.last_dpr_at ?? "").slice(0, 10)}`);

console.log(
  APPLY
    ? "\nApplied.\n"
    : "\nDry run only - nothing written. Re-run with --apply to commit.\n",
);
