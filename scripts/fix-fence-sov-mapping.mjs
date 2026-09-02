/**
 * Move the permanent fence task to the SOV line the executed contract puts it on.
 *
 * `5.1.2 Fencing Installation` (4 d, starts 2026-09-11) was mapped to billing
 * line 6.02 "Civil, Roads and Landscaping if applicable". The contract has
 * 6.03 = "Fencing/SWPPP", so the permanent fence belongs there. This is the
 * same roll-up-vs-contract reversal already recorded on the commodities in
 * 0037_afp_hardening.sql: the client's sheets map fencing to 6.02, the executed
 * contract does not, and the contract governs money.
 *
 * Found 2026-08-25 while answering Dimension's rejection of AFP 12. Their note
 * "CT indicates Fence at 0%" is correct - no permanent fence has been billed.
 * As mapped, 6.03 held eight ESC/SWPPP tasks and zero fence.
 *
 * Only `billing_lines.linked_task_wbs_codes` changes. `pay_application_lines`
 * are per-application snapshots, so AFP 1-12 as issued are untouched; this
 * changes what future derivations see.
 *
 * Careful with the WBS array: 12.00 carries '5.1.2.7' and '5.1.2.8', which are
 * children of 5.1.2 and must not be caught by a prefix match. Exact only.
 *
 * Dry run by default. Pass --apply to write.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const APPLY = process.argv.includes("--apply");
const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0,i)] = t.slice(i+1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const FENCE = "5.1.2", FROM = "6.02", TO = "6.03";

const { data: all, error: readErr } = await sb.from("billing_lines")
  .select("id,item_number,description,linked_task_wbs_codes")
  .eq("project_id", PID);
if (readErr) throw new Error(readErr.message);

// Sanity: exactly one line should currently claim 5.1.2 (exact element match).
const holders = all.filter((l) => (l.linked_task_wbs_codes ?? []).includes(FENCE));
console.log(`lines currently mapped to ${FENCE}: ${holders.map((h) => h.item_number).join(", ") || "(none)"}`);

// Already-done check comes FIRST so a second run is a no-op, not an abort.
if (holders.length === 1 && holders[0].item_number === TO) {
  console.log(`${TO} already holds ${FENCE}. Nothing to do.`);
  process.exit(0);
}
if (holders.length !== 1 || holders[0].item_number !== FROM)
  throw new Error(`expected exactly ${FROM} to hold ${FENCE}; found ${holders.map((h)=>h.item_number).join(",") || "none"}. Aborting.`);

const src = all.find((l) => l.item_number === FROM);
const dst = all.find((l) => l.item_number === TO);
if (!dst) throw new Error(`${TO} not found`);

const srcNext = (src.linked_task_wbs_codes ?? []).filter((w) => w !== FENCE);
// Keep the array in WBS order - every other line on this project is stored
// that way, and a trailing code reads like an afterthought in the DB.
const wbsKey = (w) => w.split(".").map((n) => Number(n).toString().padStart(4, "0")).join(".");
const dstNext = [...(dst.linked_task_wbs_codes ?? []), FENCE].sort((a, b) => wbsKey(a).localeCompare(wbsKey(b)));

for (const [l, before, after] of [[src, src.linked_task_wbs_codes ?? [], srcNext], [dst, dst.linked_task_wbs_codes ?? [], dstNext]]) {
  console.log(`\n${l.item_number}  ${l.description}`);
  console.log(`  before (${before.length}): ${before.join(" ")}`);
  console.log(`  after  (${after.length}): ${after.join(" ")}`);
}

// Children of 5.1.2 must be undisturbed.
const kids = all.filter((l) => (l.linked_task_wbs_codes ?? []).some((w) => w.startsWith(FENCE + ".")));
console.log(`\nuntouched children of ${FENCE}: ${kids.map((k) => `${k.item_number}[${(k.linked_task_wbs_codes??[]).filter(w=>w.startsWith(FENCE+".")).join(",")}]`).join(" ") || "(none)"}`);

if (!APPLY) { console.log("\nDRY RUN - re-run with --apply to write."); process.exit(0); }

const u1 = await sb.from("billing_lines").update({ linked_task_wbs_codes: srcNext }).eq("id", src.id);
if (u1.error) throw new Error(`${FROM}: ${u1.error.message}`);
const u2 = await sb.from("billing_lines").update({ linked_task_wbs_codes: dstNext }).eq("id", dst.id);
if (u2.error) throw new Error(`${TO}: ${u2.error.message}`);

const { data: verify } = await sb.from("billing_lines")
  .select("item_number,linked_task_wbs_codes").eq("project_id", PID).in("item_number", [FROM, TO]);
console.log("\napplied. now:");
for (const v of verify.sort((a,b)=>a.item_number.localeCompare(b.item_number)))
  console.log(`  ${v.item_number}: ${(v.linked_task_wbs_codes ?? []).join(" ")}`);
