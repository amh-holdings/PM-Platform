// Run the verification engine over a saved bill from the terminal.
//
// Calls runVerificationCore - the exact same function the app's "Re-run checks"
// button calls - with a service-role client, and prints what it wrote.
//
//   npx tsx scripts/sub-billing/verify-app.ts <sub name fragment> [app number]

import { createClient } from "@supabase/supabase-js";
import fs from "fs";

import { runVerificationCore } from "../../src/lib/sub-billing-run";
import type { SubBillingClient } from "../../src/lib/sub-billing.types";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
) as unknown as SubBillingClient;

const nameFragment = process.argv[2] ?? "Pyramid";
const appNumber = process.argv[3] ? Number(process.argv[3]) : null;
const money = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main() {
  const { data: subs } = await sb
    .from("subcontractors")
    .select("id, company_name")
    .ilike("company_name", `%${nameFragment}%`);
  if (!subs?.length) throw new Error(`No subcontractor matching "${nameFragment}"`);
  const sub = subs[0];

  let q = sb.from("sub_pay_apps").select("id, app_number, period_end").eq("subcontractor_id", sub.id);
  if (appNumber != null) q = q.eq("app_number", appNumber);
  const { data: apps } = await q.order("app_number", { ascending: false }).limit(1);
  if (!apps?.length) throw new Error("No pay application found");
  const app = apps[0];

  console.log(`${sub.company_name}, application ${app.app_number} (through ${app.period_end})\n`);
  const res = await runVerificationCore(sb, app.id);
  if (!res.ok) throw new Error(res.error);
  console.log(`${res.checks} checks written: ${res.failures} failed, ${res.warnings} warned`);
  console.log(`${res.linesVerified} lines verified\n`);

  const { data: checks } = await sb
    .from("sub_pay_app_checks").select("*").eq("sub_pay_app_id", app.id);
  for (const c of (checks ?? []).filter((c) => c.status !== "pass")) {
    console.log(` [${c.status.toUpperCase().padEnd(4)}] ${c.label}\n         ${c.message}`);
  }

  const { data: lines } = await sb
    .from("sub_pay_app_lines").select("*").eq("sub_pay_app_id", app.id).order("sort_order");
  console.log("\nITEM  BILLED%  VERIF%   BILLED $      VARIANCE $   VERDICT");
  console.log("-".repeat(74));
  let flagged = 0;
  for (const l of lines ?? []) {
    if (!Number(l.this_period)) continue;
    const bp = ((Number(l.pct_billed ?? 0)) * 100).toFixed(0) + "%";
    const vp = l.verified_pct != null ? (Number(l.verified_pct) * 100).toFixed(0) + "%" : "  -";
    const va = l.variance_amount != null ? money(Number(l.variance_amount)) : "-";
    console.log(
      `${l.item_number.padEnd(6)}${bp.padStart(6)}${vp.padStart(9)}` +
      `${money(Number(l.this_period)).padStart(13)}${va.padStart(15)}   ${String(l.flag_level).toUpperCase()}`,
    );
    if (l.flag_level === "flag" || l.flag_level === "review") flagged += Number(l.variance_amount ?? 0);
  }
  console.log("-".repeat(74));
  console.log(`Flagged as ahead of the field record: ${money(Math.round(flagged * 100) / 100)}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
