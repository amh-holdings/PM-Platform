// Pile deliveries for Sweet Springs: racking piles (4.3.1.2) and CAB piles
// (4.4.1.2), both on 2026-10-23.
//
// Source is Phil, 2026-10-01: the CAB piles come in on the same truck window as
// the racking piles, which land 10/23. Soft like the Power Factors date - a
// statement of plan, not a vendor ship confirmation.
//
// Note the conflict this resolves: PO-023 (Elevated Steel) carries an expected
// delivery of 2026-10-29 and an SNET to match, six days later. That SNET was
// also stretching the delivery across a 10-day span, so the task was computing
// to 2026-11-11 - nineteen days past the date the material actually arrives. A
// delivery is a point event, so both become milestones and the stale SNET comes
// off.
//
// CAB piles had no PO at all and was deriving its date from an imported 36-day
// lead time. It was the first domino on the chain into Substantial Completion,
// which is why this one date matters more than its size suggests.
//
// Usage:
//   node scripts/load-pile-deliveries.mjs           # dry run
//   node scripts/load-pile-deliveries.mjs --apply

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
const DATE = "2026-10-23";
const TARGETS = [
  { wbs: "4.3.1.2", label: "Racking piles (Elevated Steel, PO-023)" },
  { wbs: "4.4.1.2", label: "CAB piles (no PO on record)" },
];
const APPLY = process.argv.includes("--apply");

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
  .select("wbs_code, task_name, start_date, end_date, duration_days, date_constraint_type, date_constraint_date, predecessors")
  .eq("project_id", PROJECT_ID)
  .in("wbs_code", TARGETS.map((t) => t.wbs));
if (error) throw new Error(error.message);

for (const target of TARGETS) {
  const t = tasks.find((x) => x.wbs_code === target.wbs);
  if (!t) { console.log(`${target.wbs} MISSING`); continue; }
  console.log(`${target.wbs}  ${target.label}`);
  console.log(`  was:     ${t.start_date} -> ${t.end_date}, ${t.duration_days}d${t.date_constraint_type ? `, ${t.date_constraint_type} ${t.date_constraint_date}` : ""}`);
  console.log(`  becomes: ${DATE} milestone${t.date_constraint_type ? ", constraint cleared" : ""}`);
}

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply.`);
  process.exit(0);
}

let wrote = 0;
for (const target of TARGETS) {
  const { error: e } = await sb
    .from("schedule_tasks")
    .update({
      start_date: DATE,
      end_date: DATE,
      duration_days: 0,
      is_milestone: true,
      date_constraint_type: null,
      date_constraint_date: null,
    })
    .eq("project_id", PROJECT_ID)
    .eq("wbs_code", target.wbs);
  if (e) { console.error(`  ${target.wbs}: ${e.message}`); continue; }
  wrote++;
}
console.log(`\nWrote ${wrote} pile deliveries at ${DATE}.`);
