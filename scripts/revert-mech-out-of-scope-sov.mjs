// Revert the two owner SOV lines the mechanical import changed outside its scope.
//
// import-mechanical-schedule.mjs relinked 8.01 and 8.02 (mechanical, in scope)
// but also touched 9.00 and 12.00, which belong to the Completion scope Phil has
// not started. Restoring both to their pre-import values from
// scripts/_backups/billing_lines_mech-import.json.
//
// 8.03 was NEVER modified - the import only reported on it. Included below as a
// read-only assertion so the revert proves that rather than claiming it.
//
//   node scripts/revert-mech-out-of-scope-sov.mjs --dry-run
//   node scripts/revert-mech-out-of-scope-sov.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const DRY = process.argv.includes("--dry-run");

const backup = JSON.parse(readFileSync("scripts/_backups/billing_lines_mech-import.json", "utf8"));
const was = Object.fromEntries(backup.map((l) => [l.item_number, l.linked_task_wbs_codes]));
const REVERT = ["9.00", "12.00"];
const ASSERT_UNTOUCHED = ["8.03"];

const { data: live } = await sb.from("billing_lines").select("id,item_number,description,scheduled_value,linked_task_wbs_codes").eq("project_id", PID);
const byItem = Object.fromEntries(live.map((l) => [l.item_number, l]));

console.log(`mode: ${DRY ? "DRY RUN" : "APPLY"}\n`);
for (const item of ASSERT_UNTOUCHED) {
  const same = JSON.stringify(byItem[item].linked_task_wbs_codes) === JSON.stringify(was[item]);
  console.log(`  ${item}  ${same ? "UNCHANGED by the import, as reported" : "!! DIFFERS FROM BACKUP !!"}  ${JSON.stringify(byItem[item].linked_task_wbs_codes)}`);
}
for (const item of REVERT) {
  const l = byItem[item];
  console.log(`\n  ${item}  ${String(l.description).replace(/\n/g, " ").slice(0, 58)}  $${Number(l.scheduled_value).toLocaleString()}`);
  console.log(`      now:      ${JSON.stringify(l.linked_task_wbs_codes)}`);
  console.log(`      restore:  ${JSON.stringify(was[item])}`);
}

if (DRY) { console.log("\n[dry-run] Nothing written.\n"); process.exit(0); }
for (const item of REVERT) {
  const { error } = await sb.from("billing_lines").update({ linked_task_wbs_codes: was[item] }).eq("id", byItem[item].id);
  if (error) { console.error(`FATAL reverting ${item}: ${error.message}`); process.exit(1); }
}
console.log(`\nReverted ${REVERT.length} lines to their pre-import values. 8.01 and 8.02 left as imported.\n`);
