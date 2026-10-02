/**
 * Put CAB Solar's deposit on the SOV line its purchase order belongs to.
 *
 * PO-022 buys the CAB cable-management EQUIPMENT - hangers and piles, the
 * 4.4.1 and 4.4.2 tasks on the schedule. Equipment is procurement, and on this
 * SOV that is the 5.0x range; 8.03 is "Wire Management INSTALLED" and earns
 * nothing until the hardware is on the racking. The Add to AFP entry typed on
 * 2026-09-29 landed on 8.03, and re-pointing the PO to 5.05 afterwards did not
 * move it: changing a purchase order's SOV line leaves the billing entries it
 * has already produced where they are.
 *
 * The amount comes down to the milestone's own figure while it moves. PO-022's
 * Deposit is recorded at $3,975.25 and was paid on 2026-08-28; $4,112.25 is 50%
 * of the PO, which is what the milestone's pct_of_total says but not what its
 * amount says. The terms on the PO are what the owner can check.
 *
 * The period does not move. The deposit was paid on the 28th of August, after
 * August's period closed on the 20th, so it falls in September's.
 *
 * STILL WRONG AFTER THIS, and left alone deliberately: PO-022's two milestones
 * sum to $8,960.49 against a PO of $8,224.49, $736.00 over. That is procurement
 * data, not billing, and wants its own look.
 *
 * Dry run by default. Pass --apply to write.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const FROM = "8.03", TO = "5.05", PERIOD = "2026-09-01";
const WAS = 4112.25, NOW = 3975.25;
const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0,i)] = t.slice(i+1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const usd = (n) => "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const { data: lines } = await sb.from("billing_lines").select("id, item_number, linked_procurement_order_ids").eq("project_id", PID).in("item_number", [FROM, TO]);
const src = lines.find((l) => l.item_number === FROM);
const dst = lines.find((l) => l.item_number === TO);
if (!src || !dst) throw new Error("lines not found");

const { data: rows } = await sb.from("billing_entries")
  .select("id, planned_amount, actual_amount, period_month, status, pay_application_id, amount_is_manual, source_procurement_order_id")
  .eq("billing_line_id", src.id).eq("period_month", PERIOD);

if (rows.length === 0) {
  const { data: moved } = await sb.from("billing_entries").select("id, planned_amount").eq("billing_line_id", dst.id).eq("period_month", PERIOD).eq("amount_is_manual", true);
  if ((moved ?? []).length) { console.log(`Already on ${TO} at ${usd(moved[0].planned_amount)}. Nothing to do.`); process.exit(0); }
  throw new Error(`no ${PERIOD} entry on ${FROM} and none on ${TO} either. Check by hand.`);
}
if (rows.length !== 1) throw new Error(`expected 1 entry on ${FROM} for ${PERIOD}, found ${rows.length}`);
const e = rows[0];
if (e.pay_application_id) throw new Error("that entry is already on a pay application. Undo it first.");
if (e.status !== "forecast") throw new Error(`entry status is '${e.status}', not forecast.`);
if (!e.amount_is_manual) throw new Error("that entry is not a typed amount. Check it by hand.");
if (!eq(e.planned_amount, WAS)) throw new Error(`entry reads ${usd(e.planned_amount)}, expected ${usd(WAS)}.`);

// The PO must actually belong to the destination, or this moves money onto a
// line with no purchase order behind it.
if (!(dst.linked_procurement_order_ids ?? []).includes(e.source_procurement_order_id)) {
  throw new Error(`${TO} does not link the PO this entry came from. Fix the PO's SOV line first.`);
}

const { data: parts } = await sb.from("billing_entry_po_amounts").select("id, amount").eq("billing_entry_id", e.id);

console.log(`\n  entry ${e.id.slice(0, 8)}  ${PERIOD}`);
console.log(`    line    ${FROM}  ->  ${TO}`);
console.log(`    amount  ${usd(WAS)}  ->  ${usd(NOW)}   (the milestone's own figure)`);
for (const p of parts ?? []) console.log(`    breakdown row ${p.id.slice(0, 8)}  ${usd(p.amount)}  ->  ${usd(NOW)}`);

if (!APPLY) { console.log("\nDRY RUN - re-run with --apply to write."); process.exit(0); }

const u1 = await sb.from("billing_entries")
  .update({ billing_line_id: dst.id, planned_amount: NOW, actual_amount: NOW })
  .eq("id", e.id);
if (u1.error) throw new Error(u1.error.message);
for (const p of parts ?? []) {
  const u2 = await sb.from("billing_entry_po_amounts").update({ amount: NOW }).eq("id", p.id);
  if (u2.error) throw new Error(u2.error.message);
}
console.log("\napplied. PO-022's $736.00 milestone overage is untouched.");
