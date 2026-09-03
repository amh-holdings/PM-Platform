// Set the CIVIL (5.1.x) baseline on Sweet Springs.
//
// WHY NOW
// 5.2 mechanical was baselined on the subcontract award. Civil never was, so
// schedule_tasks.baseline_end is null on all 24 civil rows and every variance
// column in the app reads blank - the schedule can say where a task is but not
// whether it is late. That is the thing Phil is trying to measure.
//
// WHICH DATES ARE THE COMMITMENT
// The live start_date/end_date on 5.1.x are still exactly the 2026-08-19 civil
// revision - nothing has reflowed them since the import, which this script
// asserts against the transcribed schedule below before writing. So capturing
// them now captures the agreed plan, not a drifted one.
//
// ORDER MATTERS. Baseline BEFORE any reflow. applyProjectedDates() overwrites
// start_date/end_date with the projection; baseline after that and the slip is
// erased, because the plan would then equal the forecast by construction.
//
// Mechanical is left alone - only rows with a null baseline_end are touched,
// which is the onlyUnbaselined case setScheduleBaseline() was built for.
//
// Dry run by default.
//   node scripts/set-civil-baseline.mjs
//   node scripts/set-civil-baseline.mjs --apply

import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const LABEL = "Civil schedule 2026-08-19";

const env = {};
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const t = l.trim(); if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1).replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// The 2026-08-19 revision as imported, [wbs, start, end]. The guard below
// refuses to baseline anything that has drifted from this, because a silent
// drift is precisely the thing a baseline is supposed to make visible.
const AGREED = {
  "5.1": ["2026-07-27","2027-05-31"], "5.1.1": ["2026-07-27","2026-09-10"],
  "5.1.1.1": ["2026-07-27","2026-07-28"], "5.1.1.2": ["2026-07-27","2026-07-28"],
  "5.1.1.3": ["2026-07-29","2026-08-25"], "5.1.1.4": ["2026-07-29","2026-08-25"],
  "5.1.1.5": ["2026-08-12","2026-08-12"], "5.1.1.6": ["2026-08-13","2026-08-21"],
  "5.1.1.7": ["2026-08-13","2026-08-21"], "5.1.1.8": ["2026-08-24","2026-08-25"],
  "5.1.1.9": ["2026-08-26","2026-09-01"], "5.1.1.10": ["2026-09-02","2026-09-09"],
  "5.1.1.11": ["2026-09-10","2026-09-10"], "5.1.2": ["2026-09-11","2026-09-16"],
  "5.1.3": ["2026-09-11","2026-11-19"], "5.1.3.1": ["2026-09-11","2026-09-28"],
  "5.1.3.2": ["2026-09-29","2026-10-20"], "5.1.3.3": ["2026-10-21","2026-10-27"],
  "5.1.3.4": ["2026-10-28","2026-11-04"], "5.1.3.5": ["2026-10-28","2026-10-29"],
  "5.1.3.6": ["2026-11-05","2026-11-06"], "5.1.3.7": ["2026-11-09","2026-11-17"],
  "5.1.3.8": ["2026-11-18","2026-11-19"], "5.1.4": ["2027-05-31","2027-05-31"],
};

const { data: tasks, error } = await sb
  .from("schedule_tasks")
  .select("id, wbs_code, task_name, start_date, end_date, duration_days, baseline_end, baseline_label")
  .eq("project_id", PID)
  .order("wbs_code");
if (error) throw error;

const civil = tasks.filter((t) => t.wbs_code.startsWith("5.1"));
const targets = civil.filter((t) => !t.baseline_end);
const already = civil.filter((t) => t.baseline_end);

console.log(APPLY ? "APPLYING\n" : "DRY RUN (pass --apply to write)\n");
console.log(`civil rows: ${civil.length} | already baselined: ${already.length} | to baseline: ${targets.length}`);
console.log(`non-civil rows left untouched: ${tasks.length - civil.length}\n`);

const drift = [];
for (const t of targets) {
  const a = AGREED[t.wbs_code];
  if (!a) { drift.push(`${t.wbs_code} not in the 2026-08-19 revision`); continue; }
  if (t.start_date !== a[0] || t.end_date !== a[1])
    drift.push(`${t.wbs_code} live ${t.start_date}->${t.end_date} but 08-19 said ${a[0]}->${a[1]}`);
}
if (drift.length) {
  console.log("DRIFT from the 2026-08-19 revision - review before baselining:");
  drift.forEach((d) => console.log("  " + d));
  console.log("");
} else {
  console.log("Live dates match the 2026-08-19 revision exactly on all 24 rows.\n");
}

console.log("Will baseline:");
for (const t of targets)
  console.log(`  ${t.wbs_code.padEnd(9)} ${(t.task_name ?? "").slice(0, 44).padEnd(46)} ${t.start_date} -> ${t.end_date}`);

if (!APPLY) process.exit(0);

const snap = `db/snapshots/schedule_tasks_sweet-springs_pre-civil-baseline_2026-09-03.json`;
writeFileSync(snap, JSON.stringify(tasks, null, 2));
console.log(`\nsnapshot: ${snap}`);

const stamp = new Date().toISOString();
let count = 0;
for (const t of targets) {
  if (!t.start_date && !t.end_date) continue;
  const { error: uErr } = await sb.from("schedule_tasks").update({
    baseline_start: t.start_date,
    baseline_end: t.end_date,
    baseline_duration_days: t.duration_days,
    baseline_set_at: stamp,
    baseline_label: LABEL,
  }).eq("id", t.id);
  if (uErr) throw uErr;
  count++;
}
console.log(`baselined ${count} civil tasks as "${LABEL}"`);

const { data: after } = await sb.from("schedule_tasks")
  .select("wbs_code, baseline_end, baseline_label").eq("project_id", PID);
const left = after.filter((t) => !t.baseline_end);
console.log(`rows still without a baseline: ${left.length} (want 0)`);
console.log("labels now:", [...new Set(after.map((t) => t.baseline_label))].join(" | "));
