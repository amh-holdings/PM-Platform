// Reduce the Sweet Springs schedule to civil scope only.
//
// Phil's call on 2026-08-17: get civil working end to end first, then build the
// rest of the schedule back in. The financial wiring that currently references
// non-civil tasks is being rebuilt, so the dangling links it leaves behind are
// accepted rather than worked around.
//
// Civil is WBS 5.1.x. Everything else goes, including the WBS "5" Construction
// root, which leaves "5.1 Civil Construction" as the top of the tree.
//
// What deleting a schedule task does to its neighbours:
//   inspections.schedule_task_id      on delete set null  - pins survive but
//                                     lose their WBS link and stop feeding
//                                     progress. Reported below before the cut.
//   dpr_task_updates.schedule_task_id on delete cascade   - rows are destroyed.
//   dpr_delays.impacted_schedule_...  on delete set null
//   billing_lines / cost_codes        text arrays, no FK  - silently dangle.
//
// A full snapshot is written before anything is removed, so this is reversible.
//
//   node scripts/civil-only-2026-08.mjs
//   node scripts/civil-only-2026-08.mjs --apply

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
const CIVIL_ROOT = "5.1";

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

const isCivil = (wbs) =>
  wbs === CIVIL_ROOT || String(wbs).startsWith(CIVIL_ROOT + ".");

const cmpWbs = (a, b) => {
  const A = String(a).split(".").map(Number);
  const B = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? -1, y = B[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
};

// ---------------------------------------------------------------- read

const { data: tasks, error } = await db
  .from("schedule_tasks")
  .select("*")
  .eq("project_id", PROJECT_ID);
if (error) { console.error(error); process.exit(1); }

const keep = tasks.filter((t) => isCivil(t.wbs_code));
const drop = tasks.filter((t) => !isCivil(t.wbs_code));
const dropIds = new Set(drop.map((t) => t.id));

console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} - reduce Sweet Springs to civil only`);
console.log(`  keep ${keep.length} civil tasks`);
console.log(`  drop ${drop.length} non-civil tasks\n`);

// ---------------------------------------------------------------- fallout

// Field report pins attached to a task that is about to disappear. These
// survive the delete but are set adrift, so they are named individually here -
// each one is an approved record with photos behind it.
const { data: pins } = await db
  .from("inspections")
  .select("id, title, status, schedule_task_id, dpr_id")
  .eq("project_id", PROJECT_ID)
  .not("schedule_task_id", "is", null);
const orphaned = (pins ?? []).filter((p) => dropIds.has(p.schedule_task_id));

console.log("FIELD REPORT PINS");
if (!orphaned.length) {
  console.log("  none affected - every pin is on a civil task\n");
} else {
  console.log(`  ${orphaned.length} pin(s) will lose their WBS link:`);
  for (const p of orphaned) {
    const t = tasks.find((x) => x.id === p.schedule_task_id);
    console.log(`    [${p.status}] ${String(p.title).slice(0, 46).padEnd(46)} was on ${t?.wbs_code} ${String(t?.task_name).slice(0, 24)}`);
  }
  console.log("  These keep their photos and approvals but stop feeding progress.\n");
}

const { data: updates } = await db
  .from("dpr_task_updates")
  .select("id, schedule_task_id");
const cascaded = (updates ?? []).filter((u) => dropIds.has(u.schedule_task_id));
console.log(`DPR TASK UPDATES\n  ${cascaded.length} row(s) cascade-deleted\n`);

const { data: delays } = await db
  .from("dpr_delays")
  .select("id, impacted_schedule_task_id")
  .not("impacted_schedule_task_id", "is", null);
const delayHits = (delays ?? []).filter((d) => dropIds.has(d.impacted_schedule_task_id));
console.log(`DPR DELAYS\n  ${delayHits.length} row(s) lose their impacted-task link\n`);

// Billing and cost links are plain text arrays, so nothing errors - they just
// stop resolving. Counted so the number is on the record before the cut.
const { data: bl } = await db
  .from("billing_lines")
  .select("item_number, description, scheduled_value, linked_task_wbs_codes")
  .eq("project_id", PROJECT_ID);
const keepCodes = new Set(keep.map((t) => t.wbs_code));
let danglingRefs = 0;
const affectedLines = [];
for (const b of bl ?? []) {
  const refs = b.linked_task_wbs_codes ?? [];
  const bad = refs.filter((r) => !keepCodes.has(r));
  if (bad.length) { danglingRefs += bad.length; affectedLines.push({ ...b, bad }); }
}
console.log("BILLING LINES (accepted breakage - financials are being rewired)");
console.log(`  ${affectedLines.length} line(s), ${danglingRefs} reference(s) will dangle`);
for (const b of affectedLines.slice(0, 6))
  console.log(`    ${String(b.item_number).padEnd(8)} ${String(b.description).slice(0, 34).padEnd(34)} -> ${b.bad.join(", ")}`);
if (affectedLines.length > 6) console.log(`    ... and ${affectedLines.length - 6} more`);

const { data: cc } = await db
  .from("cost_codes")
  .select("code, linked_task_wbs_codes")
  .eq("project_id", PROJECT_ID);
const ccHits = (cc ?? []).filter((c) =>
  (c.linked_task_wbs_codes ?? []).some((r) => !keepCodes.has(r)),
);
console.log(`\nCOST CODES\n  ${ccHits.length} code(s) will dangle\n`);

// ---------------------------------------------------------------- write

if (!APPLY) {
  console.log("Dry run only - nothing written. Re-run with --apply to commit.\n");
  process.exit(0);
}

mkdirSync("db/snapshots", { recursive: true });
const snapFile = "db/snapshots/schedule_tasks_sweet-springs_pre-civil-only.json";
writeFileSync(snapFile, JSON.stringify(tasks, null, 2));
console.log(`snapshot written: ${snapFile} (${tasks.length} rows)`);

// Delete in chunks - a 264-item `in` list is worth breaking up.
const ids = [...dropIds];
for (let i = 0; i < ids.length; i += 50) {
  const chunk = ids.slice(i, i + 50);
  const { error: delErr } = await db.from("schedule_tasks").delete().in("id", chunk);
  if (delErr) { console.error(`delete failed: ${delErr.message}`); process.exit(1); }
}
console.log(`deleted ${ids.length} non-civil tasks`);

// 5.1 becomes the root, so its parent pointer to the removed "5" is cleared.
// level_code is rebased to the new tree depth and sort_order rebuilt.
const ordered = keep.slice().sort((a, b) => cmpWbs(a.wbs_code, b.wbs_code));
for (let i = 0; i < ordered.length; i++) {
  const t = ordered[i];
  const depth = t.wbs_code.split(".").length - 1; // 5.1 -> 1
  const parent = t.wbs_code.split(".").slice(0, -1).join(".");
  const patch = { sort_order: i, level_code: depth };
  patch.parent_wbs_code = t.wbs_code === CIVIL_ROOT ? null : parent;
  const { error: upErr } = await db.from("schedule_tasks").update(patch).eq("id", t.id);
  if (upErr) { console.error(`update failed ${t.wbs_code}: ${upErr.message}`); process.exit(1); }
}
console.log(`rebased ${ordered.length} civil tasks (root, depth, order)`);

const { count } = await db
  .from("schedule_tasks")
  .select("*", { count: "exact", head: true })
  .eq("project_id", PROJECT_ID);
console.log(`\nSweet Springs now has ${count} schedule tasks.\n`);
