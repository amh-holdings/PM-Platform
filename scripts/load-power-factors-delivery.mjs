// Power Factors delivery date for Sweet Springs (4.4.6.2).
//
// Source is NOT a vendor ship schedule - it is Phil's verification with the
// vendor on 2026-10-01: "supposed to be delivered by the last week in October".
// That week is Mon 10/26 to Fri 10/30, so the commitment is taken at the end of
// it rather than the start. The P-016 PO header says 2026-11-03, two working
// days later, so the two agree within noise.
//
// Flagged soft on purpose. Every other delivery on this job now carries a
// vendor document behind it; this one carries a conversation, and it is the
// single item gating electrical start.
//
// Usage:
//   node scripts/load-power-factors-delivery.mjs          # dry run
//   node scripts/load-power-factors-delivery.mjs --apply

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
const WBS = "4.4.6.2";
const DATE = "2026-10-30";
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

const { data: t, error } = await sb
  .from("schedule_tasks")
  .select("wbs_code, task_name, start_date, end_date, duration_days, date_constraint_type, date_constraint_date, predecessors")
  .eq("project_id", PROJECT_ID)
  .eq("wbs_code", WBS)
  .single();
if (error) throw new Error(error.message);

console.log(`${WBS} ${t.task_name} (Power Factors)`);
console.log(`  was:     ${t.start_date} -> ${t.end_date}, ${t.duration_days}d, ${t.date_constraint_type ?? "no"} ${t.date_constraint_date ?? ""}`);
console.log(`  becomes: ${DATE} milestone, SNET cleared`);
console.log(`  note:    verbal commitment, last week of October. PO P-016 header says 2026-11-03.`);

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply.`);
  process.exit(0);
}

// The SNET came from the PO header and is now later than the committed date, so
// leaving it would hold the delivery at 11/03 and quietly ignore the vendor.
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
  .eq("wbs_code", WBS);
if (e) throw new Error(e.message);
console.log(`\nWrote ${WBS} = ${DATE}.`);
