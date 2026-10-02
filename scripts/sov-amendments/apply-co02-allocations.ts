/**
 * Record CO-02's spread against the contract lines it raised.
 *
 * CO-02 "Construction Delay Cost" is the one change order on Sweet Springs that
 * the owner's SOV does NOT carry as its own line. Its $709,976.60 was spread
 * across nine work lines, and the executed G703 shows those raised values with
 * no CO-02 row at all. Every other change order on this job bills as its own
 * line (13.00, 14.00, 15.00, 16.00) and must never be allocated - doing so would
 * fold a line the owner bills separately into another one.
 *
 * The information needed is already on the change order: its nine cost lines are
 * named "6.01 Mobilization", "6.02 Civil, Roads and Landscaping if applicable"
 * and so on. This calls the same suggestAllocations() the change order page
 * calls, so a row written here is indistinguishable from one accepted in the UI.
 * A second implementation of the match would be a second source of truth for
 * what a contract line is worth.
 *
 * Refuses unless every buildup line matches on its item number and the shares
 * total the line exactly. A partial allocation would understate the lines it
 * missed while reading as complete.
 *
 * Dry run by default. Pass --apply to write.
 *
 * Run: npx tsx scripts/sov-amendments/apply-co02-allocations.ts [--apply]
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { suggestAllocations } from "@/lib/sov-amendment-suggest";

const APPLY = process.argv.includes("--apply");
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const CO_ITEM = "17.00";

const raw = readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const usd = (n: number) =>
  "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const { data: lines, error: linesErr } = await sb
    .from("billing_lines")
    .select("id, item_number, description, scheduled_value, change_order_id")
    .eq("project_id", PID);
  if (linesErr) throw new Error(linesErr.message);

  const amendmentLine = (lines ?? []).find((l) => l.item_number === CO_ITEM);
  if (!amendmentLine) throw new Error(`${CO_ITEM} not found`);
  if (!amendmentLine.change_order_id) throw new Error(`${CO_ITEM} is not a change order line`);

  // Amendments point at CONTRACT lines. A change order line is never a target.
  const contractLines = (lines ?? [])
    .filter((l) => l.change_order_id == null)
    .map((l) => ({ id: l.id, itemNumber: l.item_number, description: l.description }));

  const { data: costLines, error: costErr } = await sb
    .from("change_order_cost_lines")
    .select("id, description, extended_cost")
    .eq("change_order_id", amendmentLine.change_order_id)
    .order("sort_order");
  if (costErr) throw new Error(costErr.message);

  const lineValue = Number(amendmentLine.scheduled_value ?? 0);
  const suggestion = suggestAllocations(
    (costLines ?? []).map((c) => ({
      id: c.id,
      description: c.description,
      extendedCost: Number(c.extended_cost ?? 0),
    })),
    contractLines,
    lineValue,
  );

  console.log(`CO-02 SOV line ${CO_ITEM}: ${usd(lineValue)}\n`);
  for (const s of suggestion.matched) {
    console.log(`  ${String(s.baseItemNumber).padEnd(7)} ${String(s.baseDescription).slice(0, 42).padEnd(42)} ${usd(s.amount).padStart(14)}  [${s.basis}]`);
  }
  console.log(`\n  matched total: ${usd(suggestion.matchedTotal)}   remainder: ${usd(suggestion.remainder)}   scaled: ${suggestion.scaled}`);

  if (suggestion.unmatched.length) {
    for (const u of suggestion.unmatched) console.log(`  UNMATCHED: ${u.from.map((f) => f.description).join(", ")}`);
    throw new Error(`${suggestion.unmatched.length} buildup line(s) matched nothing. Refusing a partial allocation.`);
  }
  if (Math.abs(suggestion.remainder) > 0.005) {
    throw new Error(`Allocations leave ${usd(suggestion.remainder)} unallocated. CO-02 is spread in full or not at all.`);
  }
  if (suggestion.matched.some((s) => s.basis !== "item-number")) {
    throw new Error("A share matched on description rather than item number. Confirm it in the UI instead.");
  }

  const { data: existing } = await sb
    .from("billing_line_amendments")
    .select("base_line_id, amount")
    .eq("amendment_line_id", amendmentLine.id);
  if ((existing ?? []).length) {
    console.log(`\n${existing!.length} allocation(s) already recorded for ${CO_ITEM}.`);
    if ((existing ?? []).length === suggestion.matched.length) {
      console.log("Nothing to do.");
      process.exit(0);
    }
  }

  if (!APPLY) {
    console.log("\nDRY RUN - re-run with --apply to write.");
    process.exit(0);
  }

  const { error } = await sb.from("billing_line_amendments").upsert(
    suggestion.matched.map((s) => ({
      project_id: PID,
      amendment_line_id: amendmentLine.id,
      base_line_id: s.baseLineId!,
      amount: s.amount,
    })),
    { onConflict: "amendment_line_id,base_line_id" },
  );
  if (error) throw new Error(error.message);
  console.log(`\napplied: ${suggestion.matched.length} allocation(s) written.`);
}

main();
