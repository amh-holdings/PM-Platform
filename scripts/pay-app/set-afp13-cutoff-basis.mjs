/**
 * Put September's forecast on the 20th-cutoff basis.
 *
 * Migration 0067 taught the app that Sweet Springs' billing period closes on
 * the 20th. Two September rows were set before that and are measured to the
 * wrong date.
 *
 *   6.02 Civil, Roads   $105,409.26 -> $80,048.24
 *        The commodity tracker reads Civil Work at 41.90% on 2026-09-20 and
 *        48.04% by the 26th. The six days between them are October's work.
 *
 *   5.05 POI            September -> October
 *        The $23,982.50 typed against PO-017 is its "Net 30 upon delivery"
 *        milestone. GroundWork delivered on 2026-09-24, four days after the
 *        period closed, so it did not earn in September. It earns in
 *        October's period, which runs to 2026-10-20, so the row MOVES rather
 *        than being deleted - the money is real and the date is what was
 *        wrong. Its billing_entry_po_amounts breakdown travels with it,
 *        keyed on the entry.
 *
 * 8.03's CAB Solar deposit is left alone: PO-022 was signed 2026-09-10, inside
 * the period, so that one did earn.
 *
 * Asserts every current value before writing, so a second run is a no-op.
 * Dry run by default. Pass --apply to write.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const SEP = "2026-09-01", OCT = "2026-10-01";
const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0,i)] = t.slice(i+1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const usd = (n) => "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const { data: lines } = await sb.from("billing_lines").select("id, item_number").eq("project_id", PID).in("item_number", ["6.02", "5.05"]);
const idOf = (item) => { const l = lines.find((x) => x.item_number === item); if (!l) throw new Error(`${item} not found`); return l.id; };
const one = async (lineId, period, expect) => {
  const { data } = await sb.from("billing_entries")
    .select("id, planned_amount, actual_amount, status, pay_application_id, amount_is_manual")
    .eq("billing_line_id", lineId).eq("period_month", period);
  if (data.length !== 1) throw new Error(`expected 1 entry for ${period}, found ${data.length}`);
  const e = data[0];
  if (e.pay_application_id) throw new Error("that entry is already on a pay application. Undo it first.");
  if (e.status !== "forecast") throw new Error(`entry status is '${e.status}', not forecast.`);
  if (expect != null && !eq(e.planned_amount, expect)) throw new Error(`entry reads ${usd(e.planned_amount)}, expected ${usd(expect)}.`);
  return e;
};

const writes = [];

// --- 6.02 to the cutoff figure ---
{
  const e = await one(idOf("6.02"), SEP, null);
  if (eq(e.planned_amount, 80048.24)) console.log("  6.02 already on the cutoff figure - skipping");
  else {
    if (!eq(e.planned_amount, 105409.26)) throw new Error(`6.02 reads ${usd(e.planned_amount)}, expected $105,409.26.`);
    writes.push({ what: "6.02 September forecast", id: e.id, from: usd(105409.26), to: usd(80048.24),
      patch: { planned_amount: 80048.24, actual_amount: 80048.24 } });
  }
}

// --- 5.05 forward to October ---
{
  const { data: already } = await sb.from("billing_entries").select("id").eq("billing_line_id", idOf("5.05")).eq("period_month", OCT);
  if ((already ?? []).length) console.log("  5.05 already carries an October row - skipping the move");
  else {
    const e = await one(idOf("5.05"), SEP, 23982.5);
    if (!e.amount_is_manual) throw new Error("5.05's September row is not a typed amount. Check it by hand before moving it.");
    writes.push({ what: "5.05 POI, typed from PO-017", id: e.id, from: `${SEP}  ${usd(23982.5)}`, to: `${OCT}  ${usd(23982.5)}`,
      patch: { period_month: OCT } });
  }
}

console.log(`\n${writes.length} write(s):\n`);
for (const w of writes) console.log(`  ${w.what.padEnd(32)} ${w.from}  ->  ${w.to}`);
if (!APPLY) { console.log("\nDRY RUN - re-run with --apply to write."); process.exit(0); }
for (const w of writes) {
  const { error } = await sb.from("billing_entries").update(w.patch).eq("id", w.id);
  if (error) throw new Error(`${w.what}: ${error.message}`);
  console.log(`  applied: ${w.what}`);
}
console.log("\ndone. 8.03's CAB Solar deposit left alone - PO-022 was signed inside the period.");
