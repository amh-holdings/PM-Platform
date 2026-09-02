/**
 * Follow-ups that migration 0037 enables but does not perform.
 *
 * The migration adds two columns; both arrive NULL and do nothing until they
 * are populated:
 *
 *   1. commodities.contract_sov_item  <- from COMMODITIES in src/lib/commodities.ts,
 *      which the migration names as the source of truth. Until populated, the
 *      column cannot gate billing and the client roll-up mapping (which
 *      contradicts the contract on fencing / road_install) is still the only
 *      mapping present.
 *
 *   2. pay_applications.retainage_pct <- AFP 9-12 were all created before the
 *      column existed, so they read NULL and fall back to
 *      projects.retainage_pct_default. That fallback is correct today only
 *      because the default is 5. Stamping the rate they actually billed makes
 *      them reprint faithfully if the default ever changes.
 *
 * Idempotent. Run with --apply to write; default is a dry run.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const APPLY = process.argv.includes("--apply");
const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";

// ---- 1. contract_sov_item, parsed out of the TS source of truth ----
const src = readFileSync("src/lib/commodities.ts", "utf8");
const specs = [];
for (const block of src.split(/\n\s*\{\s*\n/).slice(1)) {
  const key = block.match(/key:\s*"([^"]+)"/)?.[1];
  if (!key) continue;
  const m = block.match(/contractSovItem:\s*(null|"([^"]*)")/);
  if (!m) continue;
  specs.push({ key, contract_sov_item: m[1] === "null" ? null : m[2] });
}
console.log(`parsed ${specs.length} commodity specs from src/lib/commodities.ts`);

const { data: live } = await sb.from("commodities")
  .select("id,key,label,sov_item,contract_sov_item").eq("project_id", PID);
const rows = live.map((c) => {
  const spec = specs.find((s) => s.key === c.key);
  return {
    key: c.key, label: c.label,
    "roll-up sov": c.sov_item ?? "-",
    "contract sov": spec ? (spec.contract_sov_item ?? "NULL (do not bill)") : "?? no spec",
    differs: spec && spec.contract_sov_item !== c.sov_item ? "  <-- DIFFERS" : "",
  };
});
console.table(rows);
console.log(`${rows.filter((r) => r.differs).length} rows where the contract disagrees with the client roll-up\n`);

if (APPLY) {
  let n = 0;
  for (const c of live) {
    const spec = specs.find((s) => s.key === c.key);
    if (!spec) { console.log(`  !! no spec for "${c.key}" - left null`); continue; }
    if (c.contract_sov_item === spec.contract_sov_item) continue;
    const r = await sb.from("commodities").update({ contract_sov_item: spec.contract_sov_item }).eq("id", c.id);
    if (r.error) throw new Error(`${c.key}: ${r.error.message}`);
    n++;
  }
  console.log(`contract_sov_item set on ${n} commodities`);
}

// ---- 2. retainage_pct on the historical applications ----
const { data: apps } = await sb.from("pay_applications")
  .select("id,app_number,retainage_pct,total_completed,total_retainage").eq("project_id", PID).order("period_start");
console.log("\npay_applications.retainage_pct:");
console.table(apps.map((a) => {
  const implied = Number(a.total_completed) > 0
    ? Math.round((Number(a.total_retainage) / Number(a.total_completed)) * 10000) / 100 : null;
  return { app: a.app_number, stored: a.retainage_pct ?? "NULL", "implied by its own totals": implied != null ? `${implied}%` : "-" };
}));

if (APPLY) {
  const r = await sb.from("pay_applications").update({ retainage_pct: 5 })
    .eq("project_id", PID).is("retainage_pct", null);
  if (r.error) throw new Error(r.error.message);
  const { data: after } = await sb.from("pay_applications").select("app_number,retainage_pct").eq("project_id", PID).order("period_start");
  console.log("after:", after.map((a) => `${a.app_number}=${a.retainage_pct}%`).join("  "));
}

console.log(APPLY ? "\nAPPLIED." : "\nDRY RUN - re-run with --apply to write.");
