// Replace the civil schedule (5.1.x) with the 2026-08-19 revision, carrying the
// approved field-report pins across to the tasks that now describe their work.
//
// WHY THIS IS NOT AN ORDINARY IMPORT
// The new schedule REUSES WBS codes for DIFFERENT work:
//     5.1.1.5  was "Initial clearing for Perimeter ESC ONLY"  (6 pins, 90%)
//              now "Silt/Rock Fence Install"                  (1 day)
//     5.1.1.7  was "Construct ESC measures"                   (2 pins, 85%)
//              now "Construct Basin 2 ESC"
//     5.1.3    was "Mass Grading"        now "Phase 2" (a summary)
//     5.1.2.x  was basin clearing/timber now gone; 5.1.2 is Fencing Installation
//
// applyScheduleImport() diffs on wbs_code, so it would read these as renames,
// leave every pin attached, and silently land six pins of clearing history on a
// one-day silt fence task. Nothing in the app would warn: predecessors are
// cleaned on delete, but inspections.schedule_task_id is ON DELETE SET NULL
// (0023_inspection_wbs.sql:7) and billing_lines.linked_task_wbs_codes is a bare
// text[] that computeBillingSuggestions skips silently when a code is missing.
//
// So the remap below is keyed by MEANING, and the pin moves are keyed by what
// each daily report actually described.
//
//   node scripts/import-civil-schedule-2026-08-19.mjs --dry-run
//   node scripts/import-civil-schedule-2026-08-19.mjs

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

// ---- The new schedule, transcribed from "20260819 - SSS Civil Schedule" -----
// [wbs, name, status, durationDays, start, end, predecessors]
const NEW = [
  ["5.1",      "Civil Construction",                                "Not Started", 210, "2026-07-27", "2027-05-31", null],
  ["5.1.1",    "Phase 1",                                           "Not Started",  33, "2026-07-27", "2026-09-10", null],
  ["5.1.1.1",  "Partition off Limits of Disturbance",               "Complete",      2, "2026-07-27", "2026-07-28", null],
  ["5.1.1.2",  "Install Temporary Construction Entrance",           "Complete",      2, "2026-07-27", "2026-07-28", null],
  ["5.1.1.3",  "Initial Clearing for ESC ONLY",                     "In Progress",  20, "2026-07-29", "2026-08-25", "5.1.1.2"],
  ["5.1.1.4",  "Debris Removal and Offsite Haul",                   "In Progress",  20, "2026-07-29", "2026-08-25", "5.1.1.3SS"],
  ["5.1.1.5",  "Silt/Rock Fence Install",                           "Complete",      1, "2026-08-12", "2026-08-12", null],
  ["5.1.1.6",  "Construct Basin 1 ESC",                             "In Progress",   7, "2026-08-13", "2026-08-21", null],
  ["5.1.1.7",  "Construct Basin 2 ESC",                             "In Progress",   7, "2026-08-13", "2026-08-21", null],
  ["5.1.1.8",  "Construct Construction Entrance",                   "Not Started",   2, "2026-08-24", "2026-08-25", "5.1.1.7"],
  ["5.1.1.9",  "Rough Road",                                        "Not Started",   5, "2026-08-26", "2026-09-01", "5.1.1.8"],
  ["5.1.1.10", "Laydown Yard",                                      "Not Started",   5, "2026-09-02", "2026-09-09", "5.1.1.9"],
  ["5.1.1.11", "County Inspection",                                 "Not Started",   1, "2026-09-10", "2026-09-10", "5.1.1.3, 5.1.1.4, 5.1.1.6, 5.1.1.7, 5.1.1.9, 5.1.1.10"],
  ["5.1.2",    "Fencing Installation",                              "Not Started",   4, "2026-09-11", "2026-09-16", "5.1.1.11"],
  ["5.1.3",    "Phase 2",                                           "Not Started",  48, "2026-09-11", "2026-11-19", null],
  ["5.1.3.1",  "Full Site Clearing",                                "Not Started",  12, "2026-09-11", "2026-09-28", "5.1.1.11"],
  ["5.1.3.2",  "Site Grading",                                      "Not Started",  15, "2026-09-29", "2026-10-20", "5.1.3.1"],
  ["5.1.3.3",  "Build Basin 1",                                     "Not Started",   5, "2026-10-21", "2026-10-27", "5.1.3.2"],
  ["5.1.3.4",  "Build Basin 2",                                     "Not Started",   6, "2026-10-28", "2026-11-04", "5.1.3.3"],
  ["5.1.3.5",  "Basin 1 Final Grading / Stabilization and Seeding", "Not Started",   2, "2026-10-28", "2026-10-29", "5.1.3.3"],
  ["5.1.3.6",  "Basin 2 Final Grading / Stabilization and Seeding", "Not Started",   2, "2026-11-05", "2026-11-06", "5.1.3.4"],
  ["5.1.3.7",  "Convert Sediment Basins to Stormwater Ponds",       "Not Started",   6, "2026-11-09", "2026-11-17", "5.1.3.5, 5.1.3.6"],
  ["5.1.3.8",  "Permanent Seeding",                                 "Not Started",   2, "2026-11-18", "2026-11-19", "5.1.3.7"],
  ["5.1.4",    "Permit Closeout",                                   "Not Started",   1, "2027-05-31", "2027-05-31", null],
];

// ---- Old code -> new code, matched on what the task MEANS. null = delete. ----
const REMAP = {
  "5.1":       "5.1",       // Civil Construction (summary)
  "5.1.1":     "5.1.1",     // Phase 1 (summary)
  "5.1.1.1":   "5.1.1.1",   // Partition off Limits of Disturbance
  "5.1.1.2":   "5.1.1.2",   // stabilized -> Temporary Construction Entrance
  "5.1.1.5":   "5.1.1.3",   // Initial clearing for Perimeter ESC -> Initial Clearing for ESC ONLY
  "5.1.2.10":  "5.1.1.4",   // Timber processing -> Debris Removal and Offsite Haul
  "5.1.1.7":   "5.1.1.5",   // Construct ESC measures -> Silt/Rock Fence Install
  "5.1.1.8":   "5.1.1.6",   // Construct Basin 1 ESC
  "5.1.1.9":   "5.1.1.7",   // Construct Basin 2 ESC
  "5.1.1.12":  "5.1.1.8",   // RCP culvert at entrance -> Construct Construction Entrance
  "5.1.1.13":  "5.1.1.9",   // Construct access roadway -> Rough Road
  "5.1.1.15":  "5.1.1.10",  // Establish laydown yard -> Laydown Yard
  "5.1.1.11":  "5.1.1.11",  // County Inspection
  "5.1.1.6":   "5.1.2",     // Fencing Installation
  "5.1.2":     "5.1.3",     // Phase 2 (summary)
  "5.1.2.5":   "5.1.3.1",   // Full Site Clearing
  "5.1.3":     "5.1.3.2",   // Mass Grading -> Site Grading
  "5.1.2.2":   "5.1.3.3",   // Build Basin 1
  "5.1.2.4":   "5.1.3.4",   // Build Basin 2
  "5.1.2.7":   "5.1.3.5",   // Basin 1 Final Grading
  "5.1.2.8":   "5.1.3.6",   // Basin 2 Final Grading
  "5.1.2.9":   "5.1.3.7",   // Convert Sediment Basins
  "5.1.2.6":   "5.1.3.8",   // Permanent Seeding
  "5.1.4":     "5.1.4",     // Permit Closeout
  // Folded into other tasks in the new schedule:
  "5.1.2.11":  null,        // Debris and stump haul-off -> merged into 5.1.1.4
  "5.1.2.1":   null,        // Basin 1 Clearing and grubbing -> Construct Basin 1 ESC
  "5.1.2.3":   null,        // Basin 2 Clearing and grubbing -> Construct Basin 2 ESC
  "5.1.1.4":   null,        // Prepare parking / storage -> Laydown Yard
  "5.1.1.10":  null,        // Stabilization of exposed soils -> 5.1.3.5 / 5.1.3.6
  "5.1.1.14":  null,        // Temporary parking area -> Laydown Yard
};

// ---- Where each approved pin belongs under the new structure ----------------
// Keyed by (report_date, current task_new_pct). newPct is the pin's percent OF
// THE TARGET TASK, set deliberately - never carried across a redefinition.
const PIN_PLAN = [
  { date: "2026-08-04", pct: 15, to: "5.1.1.3", newPct: 10,  note: "'Testing' - placeholder entry, superseded" },
  { date: "2026-08-05", pct: 20, to: "5.1.1.4", newPct: 20,  note: "Pulpwood, logs, chips" },
  { date: "2026-08-06", pct: 35, to: "5.1.1.4", newPct: 35,  note: "Logs/pulpwood/chips; stumps; silt fence starting" },
  { date: "2026-08-07", pct: 40, to: "5.1.1.4", newPct: 45,  note: "3 logs, 2 pulpwood, 1 chips" },
  { date: "2026-08-10", pct: 45, to: "5.1.1.4", newPct: 55,  note: "7 loads" },
  { date: "2026-08-11", pct: 50, to: "5.1.1.4", newPct: 65,  note: "6 loads; grubbing against the line" },
  { date: "2026-08-12", pct: 80, to: "5.1.1.5", newPct: 100, note: "Silt fence FINISHED - schedule says Complete" },
  { date: "2026-08-13", pct: 85, to: "5.1.1.3", newPct: 85,  note: "Grubbing stumps, worked up wood" },
  { date: "2026-08-14", pct: 10, to: "5.1.1.6", newPct: 15,  note: "Grubbing basin 1" },
  { date: "2026-08-14", pct: 85, to: "5.1.1.6", newPct: 20,  note: "Diversion ditch - no ditch task, nearest is Basin 1 ESC" },
  { date: "2026-08-17", pct: 90, to: "5.1.1.4", newPct: 90,  note: "3 pulpwood, 1 chips" },
  { date: "2026-08-18", pct: 90, to: "5.1.1.6", newPct: 90,  note: "Grubbing basins - Basin 1" },
  { date: "2026-08-18", pct: 75, to: "5.1.1.7", newPct: 75,  note: "Grubbing basins - Basin 2" },
];

// Tasks the schedule itself calls Complete but which carry no pin.
const MANUAL = [
  { code: "5.1.1.1", pct: 100, status: "Complete", why: "Schedule marks Complete; Phil confirmed 2026-08-19" },
  { code: "5.1.1.2", pct: 100, status: "Complete", why: "Schedule marks Complete (07/27-07/28)" },
];

// Tasks whose progress is a judgement about the new task's scope, not a pin.
const PROGRESS_OVERRIDE = {
  "5.1.1.3": 90,  // clearing ran 07/29-08/25, window closed
};

// ---- SOV mapping. Fencing Installation -> 6.02 per Phil 2026-08-19. ---------
const SOV = {
  "6.02": ["5.1.1.2","5.1.1.3","5.1.1.4","5.1.1.8","5.1.1.9","5.1.1.10","5.1.1.11","5.1.2","5.1.3.1","5.1.3.2","5.1.3.3","5.1.3.4","5.1.4"],
  "6.03": ["5.1.1.1","5.1.1.5","5.1.1.6","5.1.1.7","5.1.3.5","5.1.3.6","5.1.3.7","5.1.3.8"],
};

// ===========================================================================
const newByCode = Object.fromEntries(NEW.map((r) => [r[0], r]));
const parentOf = (c) => (c.includes(".") ? c.slice(0, c.lastIndexOf(".")) : null);
const newCodes = new Set(NEW.map((r) => r[0]));
const summaryNew = new Set(NEW.map((r) => parentOf(r[0])).filter((p) => p && newCodes.has(p)));

const { data: tasks } = await sb.from("schedule_tasks").select("*").eq("project_id", PID);
const byCode = Object.fromEntries(tasks.map((t) => [t.wbs_code, t]));
const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
const { data: dprs } = await sb.from("dprs").select("id, report_date").eq("project_id", PID);
const dateOf = Object.fromEntries(dprs.map((d) => [d.id, d.report_date]));
const { data: pins } = await sb.from("inspections").select("id, title, schedule_task_id, task_new_pct, task_new_status, quantity, dpr_id, origin, status, decided_at").eq("project_id", PID);

// --- validate -------------------------------------------------------------
const problems = [];
for (const t of tasks) if (!(t.wbs_code in REMAP)) problems.push(`existing task ${t.wbs_code} "${t.task_name}" has no REMAP entry`);
for (const [o, n] of Object.entries(REMAP)) { if (n && !newCodes.has(n)) problems.push(`REMAP ${o} -> ${n} but ${n} is not in the new schedule`); }
for (const [item, codes] of Object.entries(SOV)) for (const c of codes) {
  if (!newCodes.has(c)) problems.push(`SOV ${item} references ${c}, not in the new schedule`);
  if (summaryNew.has(c)) problems.push(`SOV ${item} references ${c}, which is a SUMMARY row`);
}
for (const p of PIN_PLAN) { if (!newCodes.has(p.to)) problems.push(`PIN_PLAN ${p.date} -> ${p.to} not in new schedule`); if (p.newPct == null) problems.push(`PIN_PLAN ${p.date} has no newPct`); }
if (problems.length) { console.error("Refusing to run:\n" + problems.map((p) => "  " + p).join("\n")); process.exit(1); }

// --- resolve pin moves ----------------------------------------------------
const moves = [];
for (const p of PIN_PLAN) {
  const match = pins.filter((i) => dateOf[i.dpr_id] === p.date && Number(i.task_new_pct) === p.pct);
  if (match.length !== 1) { console.error(`FATAL: ${p.date} @ ${p.pct}% matched ${match.length} pins`); process.exit(1); }
  moves.push({ pin: match[0], plan: p });
}

console.log(`Project ${PID}    mode: ${DRY ? "DRY RUN" : "APPLY"}\n`);
console.log("=".repeat(100));
console.log("A. SCHEDULE STRUCTURE");
console.log("=".repeat(100));
const renames = [], deletes = [], adds = [];
for (const t of tasks) {
  const to = REMAP[t.wbs_code];
  if (to === null) deletes.push(t);
  else if (to !== t.wbs_code || newByCode[to][1] !== t.task_name) renames.push({ t, to });
}
for (const r of NEW) if (!Object.values(REMAP).includes(r[0])) adds.push(r);

console.log(`\n  RE-CODED / RENAMED (${renames.length}) - task id and its pins survive:`);
for (const { t, to } of renames) console.log(`    ${t.wbs_code.padEnd(9)} ${String(t.task_name).slice(0,40).padEnd(41)} ->  ${to.padEnd(9)} ${newByCode[to][1]}`);
console.log(`\n  DELETED (${deletes.length}) - folded into other tasks:`);
for (const t of deletes) {
  const held = pins.filter((i) => i.schedule_task_id === t.id).length;
  console.log(`    ${t.wbs_code.padEnd(9)} ${String(t.task_name).slice(0,44).padEnd(45)} ${held ? `carries ${held} pin(s) - moved first` : ""}`);
}
console.log(`\n  ADDED (${adds.length}):`);
for (const r of adds) console.log(`    ${r[0].padEnd(9)} ${r[1]}`);

console.log("\n" + "=".repeat(100));
console.log("B. FIELD-REPORT PINS");
console.log("=".repeat(100));
for (const m of moves) {
  const from = m.pin.schedule_task_id ? byId[m.pin.schedule_task_id] : null;
  const fromLbl = from ? `${from.wbs_code} ${String(from.task_name).slice(0,30)}` : "(unlinked)";
  console.log(`  ${m.plan.date}  ${fromLbl.padEnd(44)} -> ${m.plan.to.padEnd(9)} ${newByCode[m.plan.to][1].slice(0,32).padEnd(33)} ${String(m.plan.newPct).padStart(3)}%`);
  console.log(`              ${m.plan.note}`);
}

// governing percent per new task = latest approved sub pin by report date
const projected = new Map(moves.map((m) => [m.pin.id, m.plan]));
const finalPct = {};
for (const code of newCodes) {
  const on = moves.filter((m) => m.plan.to === code && m.pin.origin === "sub" && m.pin.status === "approved");
  if (!on.length) continue;
  on.sort((a, b) => (b.plan.date).localeCompare(a.plan.date) || (b.pin.decided_at ?? "").localeCompare(a.pin.decided_at ?? ""));
  finalPct[code] = { pct: on[0].plan.newPct, src: "dpr", why: `latest approved pin ${on[0].plan.date}` };
}
for (const [code, pct] of Object.entries(PROGRESS_OVERRIDE)) finalPct[code] = { pct, src: "dpr", why: "scope judgement over the new task definition" };
for (const m of MANUAL) finalPct[m.code] = { pct: m.pct, src: "manual", why: m.why, status: m.status };

console.log("\n" + "=".repeat(100));
console.log("C. RESULTING PROGRESS");
console.log("=".repeat(100));
for (const code of NEW.map((r) => r[0])) {
  if (!finalPct[code]) continue;
  const f = finalPct[code];
  console.log(`  ${code.padEnd(9)} ${String(f.pct).padStart(4)}%  src=${f.src.padEnd(7)} ${newByCode[code][1].slice(0,38).padEnd(39)} ${f.why}`);
}

console.log("\n" + "=".repeat(100));
console.log("D. BILLING IMPACT");
console.log("=".repeat(100));
const { data: bl } = await sb.from("billing_lines").select("id,item_number,description,scheduled_value").eq("project_id", PID).in("item_number", Object.keys(SOV));
let grand = 0;
for (const [item, codes] of Object.entries(SOV)) {
  const line = bl.find((l) => l.item_number === item);
  const items = codes.map((c) => ({ c, p: finalPct[c]?.pct ?? 0, d: newByCode[c][3] }));
  const den = items.reduce((s, i) => s + i.d, 0);
  const num = items.reduce((s, i) => s + i.p * i.d, 0);
  const pct = den ? num / den : 0;
  const bill = pct / 100 * Number(line.scheduled_value);
  grand += bill;
  console.log(`\n  ${item}  ${line.description}   sched $${Number(line.scheduled_value).toLocaleString()}   (${den} weighted days)`);
  items.filter((i) => i.p > 0).forEach((i) => console.log(`      ${i.c.padEnd(9)} ${String(i.p).padStart(4)}% x ${String(i.d).padStart(3)}d = ${(i.p*i.d/den).toFixed(2).padStart(6)} pts   ${newByCode[i.c][1].slice(0,38)}`));
  console.log(`      weighted ${pct.toFixed(2)}%  ->  BILL $${Math.round(bill).toLocaleString()}`);
}
console.log(`\n  AFP 12 CIVIL TOTAL: $${Math.round(grand).toLocaleString()}   (was $95,064 on the old schedule)`);
console.log(`  less 10% retainage $${Math.round(grand*0.1).toLocaleString()}  =  $${Math.round(grand*0.9).toLocaleString()} due`);

if (DRY) { console.log("\n[dry-run] Nothing written."); process.exit(0); }

// --- apply ----------------------------------------------------------------
mkdirSync("scripts/_backups", { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`scripts/_backups/schedule_tasks_${ts}.json`, JSON.stringify(tasks, null, 1));
writeFileSync(`scripts/_backups/inspections_${ts}.json`, JSON.stringify(pins, null, 1));
const { data: blAll } = await sb.from("billing_lines").select("id,item_number,linked_task_wbs_codes").eq("project_id", PID);
writeFileSync(`scripts/_backups/billing_lines_${ts}.json`, JSON.stringify(blAll, null, 1));
console.log(`\nBacked up schedule_tasks, inspections, billing_lines -> scripts/_backups/*_${ts}.json`);

// 1. Move pins FIRST, so deleting a task never orphans one.
for (const m of moves) {
  await sb.from("inspections").update({ task_new_pct: m.plan.newPct }).eq("id", m.pin.id);
}
// 2. Park EVERY task on a temp code - including the ones about to be deleted.
//    Parking only the survivors leaves a doomed task squatting on a code a
//    survivor needs: "5.1.1.4 Prepare parking / storage" still held 5.1.1.4 when
//    Timber processing tried to claim it, the unique (project_id, wbs_code)
//    constraint rejected the update, and with no error check the task was left
//    stranded on its temp code with a dangling SOV link.
for (const t of tasks) {
  const { error } = await sb
    .from("schedule_tasks")
    .update({ wbs_code: `TMP-${t.id.slice(0, 8)}` })
    .eq("id", t.id);
  if (error) { console.error(`FATAL parking ${t.wbs_code}: ${error.message}`); process.exit(1); }
}
// 3. Write the new identity onto each surviving task.
const idForNewCode = {};
for (const t of tasks) {
  const to = REMAP[t.wbs_code];
  if (to === null) continue;
  const r = newByCode[to];
  const patch = {
    wbs_code: to, task_name: r[1], status: r[2], duration_days: r[3],
    start_date: r[4], end_date: r[5], predecessors: r[6],
    parent_wbs_code: parentOf(to), level_code: to.split(".").length,
  };
  const f = finalPct[to];
  if (f) { patch.pct_complete = f.pct; patch.status_source = f.src; if (f.status) patch.status = f.status; }
  else { patch.pct_complete = null; patch.status_source = "manual"; }
  const { error } = await sb.from("schedule_tasks").update(patch).eq("id", t.id);
  if (error) { console.error(`FATAL re-coding ${t.wbs_code} -> ${to}: ${error.message}`); process.exit(1); }
  idForNewCode[to] = t.id;
}
// 4. Insert genuinely new rows.
for (const r of adds) {
  const f = finalPct[r[0]];
  const { data: ins2 } = await sb.from("schedule_tasks").insert({
    project_id: PID, wbs_code: r[0], task_name: r[1], status: f?.status ?? r[2],
    duration_days: r[3], start_date: r[4], end_date: r[5], predecessors: r[6],
    parent_wbs_code: parentOf(r[0]), level_code: r[0].split(".").length,
    pct_complete: f?.pct ?? null, status_source: f?.src ?? "manual",
  }).select("id").single();
  if (ins2) idForNewCode[r[0]] = ins2.id;
}
// 5. Re-point pins at their new task ids, now that codes are final.
for (const m of moves) {
  const tid = idForNewCode[m.plan.to];
  if (!tid) { console.error(`  ERR no task id for ${m.plan.to}`); continue; }
  await sb.from("inspections").update({
    schedule_task_id: tid,
    title: `${m.plan.to} ${newByCode[m.plan.to][1]}`,
    task_new_pct: m.plan.newPct,
  }).eq("id", m.pin.id);
}
// 6. Delete the folded-in tasks (no pins remain on them by now).
for (const t of deletes) await sb.from("schedule_tasks").delete().eq("id", t.id);
// 7. Re-link the SOV.
for (const [item, codes] of Object.entries(SOV)) {
  const line = bl.find((l) => l.item_number === item);
  await sb.from("billing_lines").update({ linked_task_wbs_codes: codes }).eq("id", line.id);
}
console.log(`\nApplied: ${renames.length} re-coded, ${adds.length} added, ${deletes.length} deleted, ${moves.length} pins moved, ${Object.keys(SOV).length} SOV lines relinked.`);
