// Sussex follow-ups to the Exhibit E load, agreed with Phil on 2026-10-08.
//
//   1. The nine LNTP lines (1.01.1-1.01.9) carry no retainage - Exhibit E
//      Note 3. Needs migration 0071; skipped with a message if it is not
//      applied yet, so the other two still land.
//   2. The nine LNTP lines totalled $290,388.11 against Item 1.01's
//      $290,388.20. The $0.09 goes on the last line, 1.01.9 Electrical IFP,
//      $29,642.85 -> $29,642.94, the same way Exhibit E puts its own rounding
//      on its last line (Note 6). SOV now totals the $5,972,586 contract.
//   3. ntp_date 2026-06-11 -> 2026-06-05, the LNTP date Exhibit E states.
//
// Refuses to run once a pay application exists. Safe to re-run. Dry run by
// default; pass --apply to write.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";
const CONTRACT = 5972586;

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
const r2 = (n: number) => Math.round(n * 100) / 100;

const { count: payApps } = await sb
  .from("pay_applications")
  .select("*", { count: "exact", head: true })
  .eq("project_id", PID);
if ((payApps ?? 0) > 0) throw new Error(`${payApps} pay application(s) exist - not changing SOV values under them`);

const { data: lines, error } = await sb.from("billing_lines").select("*").eq("project_id", PID);
if (error) throw error;
const lntp = (lines ?? []).filter((l) => String(l.item_number).startsWith("1.01."));
if (lntp.length !== 9) throw new Error(`expected 9 LNTP lines, found ${lntp.length}`);
const hasFlag = "retainage_exempt" in (lines ?? [])[0];

const last = lntp.find((l) => l.item_number === "1.01.9")!;
const otherTotal = r2((lines ?? []).filter((l) => l.id !== last.id).reduce((s, l) => s + Number(l.scheduled_value), 0));
const lastTarget = r2(CONTRACT - otherTotal);
if (Math.abs(lastTarget - Number(last.scheduled_value)) > 0.1) {
  throw new Error(`1.01.9 would move ${Number(last.scheduled_value)} -> ${lastTarget}, more than the expected $0.09`);
}

console.log(`1.01.9 ${last.description}: $${Number(last.scheduled_value)} -> $${lastTarget}`);
console.log(`ntp_date -> 2026-06-05`);
console.log(
  hasFlag
    ? `retainage_exempt -> true on ${lntp.map((l) => l.item_number).join(", ")}`
    : "retainage_exempt: migration 0071 not applied - skipped. Re-run after applying it.",
);

if (!APPLY) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}

{
  const { error } = await sb.from("billing_lines").update({ scheduled_value: lastTarget }).eq("id", last.id);
  if (error) throw error;
}
{
  const { error } = await sb.from("projects").update({ ntp_date: "2026-06-05" }).eq("id", PID);
  if (error) throw error;
}
if (hasFlag) {
  const { error } = await sb
    .from("billing_lines")
    .update({ retainage_exempt: true })
    .in("id", lntp.map((l) => l.id));
  if (error) throw error;
}

const { data: after } = await sb.from("billing_lines").select("scheduled_value").eq("project_id", PID);
console.log(`\nWrote. SOV total $${r2((after ?? []).reduce((s, l) => s + Number(l.scheduled_value), 0)).toLocaleString()}`);
