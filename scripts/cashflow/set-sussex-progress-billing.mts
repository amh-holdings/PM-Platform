// Sussex install lines bill as completed, 2026-10-12.
//
// Phil: "with Dimension we only bill what is completed which is what our subs
// would bill us as well." Site work, electrical and mechanical install
// (6.xx-8.xx) are marked billing_method = 'progress' so the projection spreads
// them over their tasks. LNTP, NTP, permits, procurement and the 9-11
// completion milestones stay milestone lines.
//
// Needs migration 0076. Dry run by default; pass --apply to write.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";

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

const { data: lines, error } = await sb.from("billing_lines").select("*").eq("project_id", PID);
if (error) throw error;
if (lines?.length && !("billing_method" in lines[0])) {
  throw new Error("billing_lines.billing_method missing - apply migration 0076 first.");
}
const progress = (lines ?? []).filter((l) => /^[678]\./.test(String(l.item_number)));
for (const l of progress) {
  console.log(`  ${String(l.item_number).padEnd(6)} ${String(l.description).slice(0, 44).padEnd(44)} $${Number(l.scheduled_value).toLocaleString()}  ${l.billing_method} -> progress`);
}
if (!APPLY) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}
const { error: ue } = await sb
  .from("billing_lines")
  .update({ billing_method: "progress" } as never)
  .in("id", progress.map((l) => l.id));
if (ue) throw ue;
console.log(`\n${progress.length} lines set to progress.`);
