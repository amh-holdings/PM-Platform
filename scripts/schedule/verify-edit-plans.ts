// Dry-run the editing plans against the live Sweet Springs schedule.
//
// Nothing is written. This exists because every unit test in run-tests.ts uses
// a fixture I invented, and the civil schedule has a shape I did not: no "5"
// root, eleven SS links added in the August review, and three unlinked tasks.
//
//   npx tsx scripts/schedule/verify-edit-plans.ts

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import {
  buildImportRows,
  diffImport,
  guessColumns,
  nextTopLevelCode,
  parseGrid,
  planIndent,
  planMove,
  planOutdent,
  scheduleOrder,
  shiftDates,
  type EditTask,
} from "@/lib/schedule-edit";

const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

async function main() {
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data, error } = await db
  .from("schedule_tasks")
  .select("id, wbs_code, task_name, predecessors, sort_order, level_code, duration_days, start_date, end_date, phase, assigned_to, status")
  .eq("project_id", PROJECT_ID)
  .order("sort_order", { ascending: true, nullsFirst: false });

if (error) { console.error(error.message); process.exit(1); }
const tasks = (data ?? []) as EditTask[];
console.log(`Sweet Springs: ${tasks.length} tasks, top code ${scheduleOrder(tasks)[0]?.wbs_code}\n`);

const line = (s: string) => console.log(s);

// --- new-task code suggestion ---------------------------------------------
line(`Next top-level branch would be: ${nextTopLevelCode(tasks)}`);

// --- indent every task, one at a time --------------------------------------
let indentOk = 0, indentRefused = 0, worstRewrites = 0;
const refusals = new Set<string>();
for (const t of tasks) {
  const p = planIndent(tasks, [t.wbs_code]);
  if (p.ok) {
    indentOk++;
    worstRewrites = Math.max(worstRewrites, p.predecessorRewrites.length);
  } else {
    indentRefused++;
    refusals.add(p.error!.replace(/"[^"]*"/, '"..."'));
  }
}
line(`\nIndent: ${indentOk} tasks can indent, ${indentRefused} refused`);
for (const r of Array.from(refusals)) line(`  refusal: ${r}`);
line(`  most predecessor rewrites a single indent causes: ${worstRewrites}`);

// --- outdent ---------------------------------------------------------------
let outOk = 0, outRefused = 0;
const outRefusals = new Set<string>();
for (const t of tasks) {
  const p = planOutdent(tasks, [t.wbs_code]);
  if (p.ok) outOk++;
  else { outRefused++; outRefusals.add(p.error!.replace(/"[^"]*"/, '"..."')); }
}
line(`\nOutdent: ${outOk} can outdent, ${outRefused} refused`);
for (const r of Array.from(outRefusals)) line(`  refusal: ${r}`);

// --- moves -----------------------------------------------------------------
let upOk = 0, downOk = 0, moveRefused = 0;
for (const t of tasks) {
  if (planMove(tasks, [t.wbs_code], "up").sortUpdates.length) upOk++;
  if (planMove(tasks, [t.wbs_code], "down").sortUpdates.length) downOk++;
  const u = planMove(tasks, [t.wbs_code], "up");
  if (!u.ok) moveRefused++;
}
line(`\nMove: ${upOk} can move up, ${downOk} can move down, ${moveRefused} refused upward`);

// --- worked example: indent the task the civil review flagged --------------
const sample = tasks.find((t) => t.wbs_code === "5.1.1.5") ?? tasks[3];
const demo = planIndent(tasks, [sample.wbs_code]);
line(`\nWorked example - indent ${sample.wbs_code} "${sample.task_name}":`);
if (demo.ok) {
  for (const r of demo.renames) line(`  ${r.from} -> ${r.to}`);
  for (const w of demo.predecessorRewrites)
    line(`  repoint ${w.wbs_code}: ${w.predecessors}`);
  for (const w of demo.warnings) line(`  warn: ${w}`);
} else line(`  refused: ${demo.error}`);

// --- shifting the whole schedule two weeks ---------------------------------
const shifted = tasks.map((t) => shiftDates(t, 10, 5)).filter(Boolean);
line(`\nShift +10 working days: ${shifted.length} of ${tasks.length} tasks have dates to move`);

// --- re-importing the schedule as its own paste ----------------------------
// The strongest check available without touching anything: export what is in
// the database, feed it back through the importer, and confirm the diff is
// empty. Anything that shows up is the importer misreading its own output.
const tsv = [
  "WBS\tTask Name\tDuration\tStart\tFinish\tPredecessors",
  ...scheduleOrder(tasks).map((t) =>
    [
      t.wbs_code,
      t.task_name,
      t.duration_days ?? "",
      t.start_date ?? "",
      t.end_date ?? "",
      t.predecessors ?? "",
    ].join("\t"),
  ),
].join("\n");

const grid = parseGrid(tsv);
const mapping = guessColumns(grid.headers, grid.rows);
const { rows, notes } = buildImportRows(grid, mapping, { knownWbs: tasks.map((t) => t.wbs_code) });
const diff = diffImport(tasks, rows, mapping);
line(`\nRound-trip import of the live schedule:`);
line(`  ${diff.adds.length} adds, ${diff.changes.length} changes, ${diff.unchangedCount} unchanged, ${diff.deletes.length} deletes`);
for (const n of notes) line(`  note: ${n}`);
for (const b of diff.blocking) line(`  BLOCKING: ${b}`);
for (const c of diff.changes.slice(0, 10))
  line(`  drift ${c.existing.wbs_code}: ${c.fields.map((f) => `${f.field} ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`).join(", ")}`);
const rowsWithIssues = rows.filter((r) => r.issues.length);
line(`  ${rowsWithIssues.length} rows with unreadable values`);
for (const r of rowsWithIssues.slice(0, 10)) line(`    row ${r.rowNumber} ${r.wbs_code}: ${r.issues.join("; ")}`);

const verdict = diff.adds.length === 0 && diff.changes.length === 0 && diff.blocking.length === 0;
line(`\n${verdict ? "PASS" : "FAIL"} - the schedule round-trips through the importer unchanged`);
process.exit(verdict ? 0 : 1);
}

main();
