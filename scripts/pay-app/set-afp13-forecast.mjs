/**
 * Put September's forecast on the two site-work lines where the plan and the
 * evidence disagree.
 *
 * Dimension's comments of 2026-09-28 settled both, and the app now computes
 * both - the rule of credit on 6.03, the commodity tracker on 6.02 - but the
 * forecast rows still carry figures typed before either rule existed.
 *
 *   6.03 Fencing/SWPPP  $61,150.73 -> $0.00
 *        The conceded rule is SWPPP 30 / fence 70. Fence (5.1.2) is 0% and
 *        runs Oct 8-13; SWPPP's own scope is 66% done, so the line earns
 *        0.30 x 0.66 = 19.80%, or $40,359.49, against $79,936.00 already
 *        billed. Nothing is billable in September, and the line runs
 *        $39,576.51 ahead of the rule until the fence goes in.
 *
 *   6.02 Civil, Roads    $86,739.64 -> $105,409.26
 *        Dimension asked for the invoice to match the commodity tracker. It
 *        reads Civil Work at 48.04% through 2026-09-26, which on a
 *        $413,045.92 line is $198,427.26 earned against $93,018.00 billed.
 *
 * 5.05 POI is deliberately untouched. Its row is a PO milestone and the
 * Bill This Period panel nets prior billings off the milestone total, so it
 * offers the $8,095.95 the milestones actually support rather than the row's
 * face value.
 *
 * THE 6.02 FIGURE HAS A SHELF LIFE. Civil Work is a live commodity and moves
 * every field report, so re-run scripts/pay-app/afp13-positions.ts at cutoff
 * and use what it says then.
 *
 * Asserts the current value before writing, so a second run is a no-op.
 * Dry run by default. Pass --apply to write.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const PERIOD = "2026-09-01";
const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0,i)] = t.slice(i+1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const usd = (n) => "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// item -> [expected now, set to]
const FIX = { "6.03": [61150.73, 0], "6.02": [86739.64, 105409.26] };

const { data: lines } = await sb.from("billing_lines").select("id, item_number").eq("project_id", PID).in("item_number", Object.keys(FIX));
const writes = [];
for (const [item, [was, now]] of Object.entries(FIX)) {
  const line = lines.find((l) => l.item_number === item);
  if (!line) throw new Error(`${item} not found`);
  const { data: rows } = await sb.from("billing_entries")
    .select("id, planned_amount, actual_amount, status, pay_application_id")
    .eq("billing_line_id", line.id).eq("period_month", PERIOD);
  if (rows.length !== 1) throw new Error(`${item}: expected 1 entry for ${PERIOD}, found ${rows.length}`);
  const e = rows[0];
  if (e.pay_application_id) throw new Error(`${item}: that entry is already on a pay application. Undo it before re-forecasting.`);
  if (e.status !== "forecast") throw new Error(`${item}: entry status is '${e.status}', not forecast. Aborting.`);
  if (eq(e.planned_amount, now)) { console.log(`  ${item} already ${usd(now)} - skipping`); continue; }
  if (!eq(e.planned_amount, was)) throw new Error(`${item}: entry reads ${usd(e.planned_amount)}, expected ${usd(was)}. Aborting.`);
  writes.push({ item, id: e.id, from: usd(was), to: usd(now), patch: { planned_amount: now, actual_amount: now } });
}

console.log(`\n${writes.length} write(s):\n`);
for (const w of writes) console.log(`  ${w.item.padEnd(6)} September forecast   ${w.from.padStart(14)}  ->  ${w.to.padStart(14)}`);
if (!APPLY) { console.log("\nDRY RUN - re-run with --apply to write."); process.exit(0); }
for (const w of writes) {
  const { error } = await sb.from("billing_entries").update(w.patch).eq("id", w.id);
  if (error) throw new Error(`${w.item}: ${error.message}`);
  console.log(`  applied: ${w.item}`);
}
console.log("\ndone. 5.05 POI untouched - the panel nets prior billings off its milestones.");
