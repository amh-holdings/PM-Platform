// Correct the mechanical pile sequence to how the work is actually done.
//
// Phil, 2026-10-01: "We will not have array layout, unloading and staging
// happen like that. They will unload and stage when piles are on site, and most
// likely the day before the pile delivery they will layout and marking - but
// layout and marking cannot happen until grading is completed."
//
// What the schedule had:
//
//   Array Layout <- Site Grading, racking pile delivery, CAB pile delivery
//   Pile Unloading <- Array Layout, CAB pile delivery
//   Pile Driving <- Pile Staging
//
// Two things wrong with that. Unloading waited on layout, so the crew could not
// touch a pile that was sitting on site until the array was marked. And layout
// waited on the pile delivery, which is backwards - marking the array needs
// finished grade, not piles.
//
// What it becomes:
//
//   Array Layout <- Site Grading                    (grade is the only gate)
//   Pile Unloading <- racking + CAB pile deliveries (piles on site)
//   Pile Staging <- Pile Unloading                  (unchanged)
//   Pile Driving <- Pile Staging, Array Layout      (staged AND marked)
//
// The "day before delivery" part is a timing expectation, not a dependency, so
// it is deliberately not modelled. If grading finishes in time it falls out of
// the logic on its own; if it does not, no link can make it true.
//
// Usage:
//   node scripts/fix-mechanical-pile-sequence.mjs           # dry run
//   node scripts/fix-mechanical-pile-sequence.mjs --apply

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
const APPLY = process.argv.includes("--apply");

const CHANGES = [
  {
    wbs: "5.2.1",
    to: "5.1.3.2",
    why: "Layout is gated by finished grade alone. Dropping 4.3 and 4.3.1 - marking the array does not wait on piles arriving.",
  },
  {
    wbs: "5.2.2",
    to: "4.3.1.2, 4.4.1.2",
    why: "Unload when the piles are on site. Dropping 5.2.1 - the crew does not wait on marking to take delivery.",
  },
  {
    wbs: "5.2.4",
    to: "5.2.3, 5.2.1",
    why: "Driving needs piles staged AND the array marked. The layout link moves here, which is where it actually binds.",
  },
];

const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: tasks, error } = await sb
  .from("schedule_tasks")
  .select("wbs_code, task_name, predecessors")
  .eq("project_id", PROJECT_ID)
  .in("wbs_code", CHANGES.map((c) => c.wbs));
if (error) throw new Error(error.message);

for (const c of CHANGES) {
  const t = tasks.find((x) => x.wbs_code === c.wbs);
  console.log(`${c.wbs}  ${t?.task_name}`);
  console.log(`  was:  ${t?.predecessors ?? "(none)"}`);
  console.log(`  now:  ${c.to}`);
  console.log(`  why:  ${c.why}\n`);
}

if (!APPLY) {
  console.log(`Dry run. Re-run with --apply to write ${CHANGES.length} changes.`);
  process.exit(0);
}

let wrote = 0;
for (const c of CHANGES) {
  const { error: e } = await sb
    .from("schedule_tasks")
    .update({ predecessors: c.to })
    .eq("project_id", PROJECT_ID)
    .eq("wbs_code", c.wbs);
  if (e) { console.error(`  ${c.wbs}: ${e.message}`); continue; }
  wrote++;
}
console.log(`Wrote ${wrote} changes.`);
