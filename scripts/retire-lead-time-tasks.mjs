// Retire the procurement Lead Time rows now that every delivery stands on
// something stronger, and move the Maddox transformer onto need-by logic.
//
// Why the lead times go. They were scaffolding from the authoring sheet: a
// duration standing in for "when will this arrive" because nobody had a real
// answer. There are real answers now - four actual delivery dates, six dates
// pinned from the GridPower ship schedule or Phil's confirmation, and two PO
// dates. A static imported duration with no predecessor is not an early warning
// system; the vendor ship schedule is, and it lives outside this tool.
//
// Maddox (4.4.3.2) was the one delivery with nothing behind it. Phil, 2026-10-01:
// the transformer is bought and sitting in a warehouse, so it is the same case
// as the modules - we tell them when we need it rather than waiting to be told
// when it ships. That is start-to-finish logic against the task that consumes
// it, which is what the authoring sheet had before the procurement flip.
//
// The flip has to be undone on both ends or the two links close a loop:
//   Transformer Set loses "4.4.3.2" from its predecessors
//   Maddox Delivery gains "5.5.4SF"
//
// Note Maddox is NOT owner-supplied. It is AHC's material, already purchased.
// Same scheduling treatment as the Dimension items, different commercially.
//
// Usage:
//   node scripts/retire-lead-time-tasks.mjs           # dry run
//   node scripts/retire-lead-time-tasks.mjs --apply

import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
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
  .select("*")
  .eq("project_id", PROJECT_ID);
if (error) throw new Error(error.message);

const leads = tasks.filter((t) => /^4\./.test(t.wbs_code) && /Lead Time/i.test(t.task_name));
const leadCodes = new Set(leads.map((t) => t.wbs_code));

// Maddox onto need-by, both ends.
const MADDOX = { delivery: "4.4.3.2", consumer: "5.5.4" };
const consumer = tasks.find((t) => t.wbs_code === MADDOX.consumer);
const consumerNext = String(consumer?.predecessors ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((p) => !p.startsWith(MADDOX.delivery))
  .join(", ");

// Any surviving task that names a lead time as a predecessor loses that token.
const rewrites = [];
for (const t of tasks) {
  if (leadCodes.has(t.wbs_code)) continue;
  const have = String(t.predecessors ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const kept = have.filter((p) => {
    const code = p.match(/^(\d+(?:\.\d+)*)/)?.[1];
    return code && !leadCodes.has(code);
  });
  if (kept.length === have.length) continue;
  rewrites.push({ wbs: t.wbs_code, name: t.task_name, was: t.predecessors, now: kept.length ? kept.join(", ") : null });
}

const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
console.log(`DELETING ${leads.length} Lead Time rows:`);
for (const t of leads.sort((a, b) => a.wbs_code.localeCompare(b.wbs_code, undefined, { numeric: true })))
  console.log(`  ${pad(t.wbs_code, 11)}${pad(t.status ?? "-", 14)}${t.duration_days}d`);

console.log(`\nMADDOX onto need-by logic:`);
console.log(`  ${MADDOX.consumer} Transformer Set   "${consumer?.predecessors}" -> "${consumerNext}"`);
console.log(`  ${MADDOX.delivery} Maddox Delivery   "${tasks.find((t) => t.wbs_code === MADDOX.delivery)?.predecessors ?? "(none)"}" -> "${MADDOX.consumer}SF"`);

console.log(`\nPREDECESSOR REWRITES on surviving tasks (${rewrites.length}):`);
for (const r of rewrites) console.log(`  ${pad(r.wbs, 11)}${pad(r.name, 26)}"${r.was}" -> "${r.now ?? "(none)"}"`);

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply.`);
  process.exit(0);
}

// Snapshot the rows being removed, so this is reversible.
const backup = `db/reference/retired-lead-time-tasks-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(backup, JSON.stringify(leads, null, 1));
console.log(`\nBacked up ${leads.length} rows to ${backup}`);

// Rewrites first - a predecessor pointing at a deleted task would otherwise be
// a dangling reference between the two statements.
for (const r of rewrites) {
  const { error: e } = await sb.from("schedule_tasks").update({ predecessors: r.now })
    .eq("project_id", PROJECT_ID).eq("wbs_code", r.wbs);
  if (e) console.error(`  ${r.wbs}: ${e.message}`);
}
{
  const { error: e } = await sb.from("schedule_tasks").update({ predecessors: consumerNext || null })
    .eq("project_id", PROJECT_ID).eq("wbs_code", MADDOX.consumer);
  if (e) console.error(`  ${MADDOX.consumer}: ${e.message}`);
}
{
  const { error: e } = await sb.from("schedule_tasks")
    .update({ predecessors: `${MADDOX.consumer}SF`, duration_days: 0, is_milestone: true, date_constraint_type: null, date_constraint_date: null })
    .eq("project_id", PROJECT_ID).eq("wbs_code", MADDOX.delivery);
  if (e) console.error(`  ${MADDOX.delivery}: ${e.message}`);
}
const { error: delErr } = await sb.from("schedule_tasks").delete()
  .eq("project_id", PROJECT_ID).in("wbs_code", Array.from(leadCodes));
if (delErr) throw new Error(`deleting: ${delErr.message}`);
console.log(`Deleted ${leadCodes.size} Lead Time rows.`);
