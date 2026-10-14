// Sussex construction codes carry 10% sub retainage, 2026-10-14.
//
// Phil: "We will require a 10% retainage from our subs. We will try for a
// Net 45 but stay with Net 30 right now." Terms stay Net 30 (0072, set by
// map-sussex-to-schedule). This sets the retainage placeholder (0077) on every
// 300-xxxx code; a real sub linked later overrides it.
//
// Needs migration 0077. Dry run by default; pass --apply to write.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";
const RETAINAGE_PCT = 10;

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

const { data: codes, error } = await sb.from("cost_codes").select("*").eq("project_id", PID).like("code", "300-%");
if (error) throw error;
if (codes?.length && !("retainage_pct" in codes[0])) {
  throw new Error("cost_codes.retainage_pct missing - apply migration 0077 first.");
}
for (const c of codes ?? []) {
  console.log(`  ${c.code} ${String(c.description ?? "").padEnd(28)} $${Number(c.estimated_cost).toLocaleString().padStart(11)}  ${c.retainage_pct ?? "-"} -> ${RETAINAGE_PCT}%`);
}
if (!APPLY) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}
const { error: ue } = await sb
  .from("cost_codes")
  .update({ retainage_pct: RETAINAGE_PCT } as never)
  .in("id", (codes ?? []).map((c) => c.id));
if (ue) throw ue;
console.log(`\n${codes?.length} codes set to ${RETAINAGE_PCT}% retainage.`);
