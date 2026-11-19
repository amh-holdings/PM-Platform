// Sussex AFP 3: the 90% design line was booked against Structural, 2026-11-19.
//
// Zarina: "The 90% civil is already included in AFP 3 for october billing, it
// should not be reflected here in november as it was completed in october.
// Please adjust, fix why the forecasted is not matching."
//
// WHAT HAPPENED. AFP 3 (Oct 1-30, approved) carries one 90% design line at
// $30,509.68, noted "From IBT Pay App #03 dated 10/30/2026, invoice 202-03".
// It was entered against 1.01.5 Structural - 90% Design. The work finished in
// October was CIVIL: schedule task 1.2.1.3 (90% Design) is Complete, Oct 16 to
// Oct 28, and the Rev E plan set is dated Oct 22 and Oct 29. Structural 90% is
// task 1.2.2.2, Not Started, planned Dec 1 to Jan 6.
//
// The two lines are a cent apart - 1.01.3 is $30,509.69 and 1.01.5 is
// $30,509.68 - so picking the wrong one changed no total and nothing caught it.
//
// WHY NOVEMBER. projection.ts forecasts an unbilled line in the month its
// milestone task is planned to finish, then clamps it with notPast():
//   const notPast = (m: string) => (m < todayIso ? todayIso : m);
// 1.01.3 is unbilled and its task ended 2026-10-28, which is in the past, so
// the forecast pulls it to the current month. That is the November row. It is
// not a forecasting bug; the forecast is correctly reporting that Civil 90% is
// finished and still unbilled.
//
// THE FIX is one row: move the October entry from 1.01.5 to 1.01.3. Civil 90%
// then reads billed in October and leaves the forecast, and Structural 90%
// goes back to unbilled, which is right because it has not started.
//
// The invoiced $30,509.68 is left alone. It is what IBT actually billed, and
// rewriting it to 1.01.3's $30,509.69 would make the app disagree with invoice
// 202-03 over a cent. That cent stays open on 1.01.3.
//
//   npx tsx scripts/billing/fix-sussex-afp3-civil-90-2026-11-19.mts
//   npx tsx scripts/billing/fix-sussex-afp3-civil-90-2026-11-19.mts --apply
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const ENTRY = "187c25f0-bfed-40e0-8107-ad73e1adbb7c";
const FROM = "eb9445cf-5ab2-414d-a2bb-552ed212fa3f"; // 1.01.5 Structural - 90% Design
const TO = "512045f9-cd6d-4acf-a7ed-cc0f0196acba"; // 1.01.3 Civil - 90% Design

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
try {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i)] = t.slice(i + 1);
  }
} catch {
  // Cloud session: the environment's own variables are the source.
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
  auth: { persistSession: false },
});

const { data: entry, error } = await sb
  .from("billing_entries")
  .select("id, billing_line_id, period_month, actual_amount, status, notes")
  .eq("id", ENTRY)
  .maybeSingle();
if (error) throw error;
if (!entry) throw new Error("Entry not found - it may already have been moved.");
if (entry.billing_line_id !== FROM) {
  console.log("Already moved; the entry is not on 1.01.5. Nothing to do.");
  process.exit(0);
}

const { data: lines } = await sb
  .from("billing_lines")
  .select("id, item_number, description, scheduled_value")
  .in("id", [FROM, TO]);
const nameOf = (id: string) => {
  const l = (lines ?? []).find((x) => x.id === id);
  return l ? `${l.item_number} ${l.description} ($${Number(l.scheduled_value).toLocaleString()})` : id;
};

console.log("Entry      ", entry.id);
console.log("Period     ", entry.period_month, "   amount $" + Number(entry.actual_amount).toLocaleString());
console.log("Status     ", entry.status);
console.log("Move from  ", nameOf(FROM));
console.log("Move to    ", nameOf(TO));
console.log("Note       ", entry.notes);

if (!APPLY) {
  console.log("\nDry run. Nothing written. Pass --apply to move it.");
  process.exit(0);
}

const { error: upErr } = await sb
  .from("billing_entries")
  .update({ billing_line_id: TO })
  .eq("id", ENTRY)
  .eq("billing_line_id", FROM); // refuse to move it twice
if (upErr) throw upErr;
console.log("\nMoved to 1.01.3 Civil - 90% Design.");
