// Back-test the verification engine against a bill we have already paid.
//
// Pyramid application 1 was approved as billed on 2026-08-13, before any of
// this existed. Running it back through the engine answers the only question
// that matters: would the tool have caught anything, and would it have thrown
// noise at work that was actually fine.
//
// Uses the real SOV and the real field record from Supabase. Read-only.
//
//   npx tsx scripts/sub-billing/backtest-pyramid-app1.ts

import { createClient } from "@supabase/supabase-js";
import fs from "fs";

import {
  projectNextBill,
  runBillChecks,
  verifyLine,
  type BillHeader,
  type BillLine,
  type Evidence,
  type SovLine,
  type SubContext,
} from "../../src/lib/sub-billing";

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
const PERIOD_END = "2026-08-13";

// The SOV and column E, straight off the pay app PDF.
const RAW: [string, string, number, number, number][] = [
  ["1.01", "Mobilization to site (equipment, trailers, temporary facilities)", 26922.68, 21538.14, 1076.91],
  ["1.02", "Site survey verification and layout", 13461.34, 3365.34, 168.27],
  ["1.03", "Erosion and sediment control installation (initial)", 20192.01, 4038.4, 201.92],
  ["1.04", "Tree clearing and grubbing", 151922.68, 75961.34, 3798.07],
  ["2.01", "Mass grading and site preparation", 87498.71, 8749.87, 437.49],
  ["2.02", "Cut and fill operations", 60576.03, 0, 0],
  ["2.03", "Subgrade preparation for array areas", 47114.69, 0, 0],
  ["2.04", "Drainage structures and stormwater management", 40384.02, 0, 0],
  ["3.01", "Access road construction (subbase and base course)", 80768.04, 8076.8, 403.84],
  ["3.02", "Internal site roads", 60576.03, 0, 0],
  ["3.03", "Road surfacing and finish grading", 40384.02, 0, 0],
  ["5.01", "SWPPP implementation and ongoing maintenance", 20192.01, 2019.2, 100.96],
  ["5.02", "Silt fence and erosion control devices", 13461.34, 10096.0, 504.8],
  ["7.01", "Topsoil placement and final grading", 33653.35, 0, 0],
  ["7.02", "Hydroseeding and revegetation", 40384.02, 0, 0],
  ["7.03", "Final landscaping and site restoration", 13461.34, 0, 0],
  ["8.01", "Demobilization and site cleanup", 13461.34, 0, 0],
  ["8.02", "Punchlist completion and final walkthrough", 20192.01, 0, 0],
  ["8.03", "Closeout documentation and as-builts", 13461.34, 0, 0],
];

// The draft mapping, for review. Nothing here is confirmed - this is exactly
// the table Phil and Mark need to sign off on, expressed as code so the
// back-test shows what the engine would say if they accept it as drafted.
// The CONFIRMED mapping. Phil signed off on the four open rules on 2026-08-20;
// the rest follows the first back-test, which showed daily production is the
// live record for civil quantities and the schedule tasks are stale.
const MAPPING: Record<string, Partial<SovLine> & { commodities?: string[] }> = {
  "1.01": { verification_method: "on_site" },
  "1.02": { verification_method: "schedule", linked_task_wbs_codes: ["5.1.1.1"] },
  "1.03": { verification_method: "schedule", linked_task_wbs_codes: ["5.1.1.3", "5.1.1.5"] },
  "1.04": { verification_method: "commodity", commodities: ["Site Prep"] },
  "2.01": { verification_method: "commodity", commodities: ["Civil Work"] },
  "2.02": { verification_method: "commodity", commodities: ["Civil Work"] },
  "2.03": { verification_method: "schedule", linked_task_wbs_codes: ["5.1.3.1"] },
  "2.04": { verification_method: "schedule", linked_task_wbs_codes: ["5.1.3.3", "5.1.3.4", "5.1.3.7"] },
  "3.01": { verification_method: "commodity", commodities: ["Road Install"] },
  "3.02": { verification_method: "commodity", commodities: ["Road Install"] },
  "3.03": { verification_method: "commodity", commodities: ["Road Install"] },
  // SWPPP earns against the whole erosion-control program, duration-weighted,
  // not against permanent seeding alone. Confirmed by Phil 2026-08-20.
  "5.01": { verification_method: "schedule", linked_task_wbs_codes: ["5.1.1.1", "5.1.1.2", "5.1.1.3", "5.1.1.5", "5.1.1.6", "5.1.1.7", "5.1.1.8", "5.1.3.5", "5.1.3.6", "5.1.3.7", "5.1.3.8"] },
  "5.02": { verification_method: "schedule", linked_task_wbs_codes: ["5.1.1.5"] },
  "7.01": { verification_method: "schedule", linked_task_wbs_codes: ["5.1.3.5", "5.1.3.6"] },
  "7.02": { verification_method: "schedule", linked_task_wbs_codes: ["5.1.3.8"] },
  "7.03": { verification_method: "manual" },
  "8.01": { verification_method: "manual" },
  "8.02": { verification_method: "manual" },
  "8.03": { verification_method: "manual" },
};

const money = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD" });
const r2 = (v: number) => Math.round(v * 100) / 100;

async function main() {
  const { data: sub } = await sb
    .from("subcontractors")
    .select("id, company_name, contract_value, retainage_pct, payment_terms, payment_terms_days, coi_status, w9_status")
    .eq("project_id", PROJECT_ID)
    .ilike("company_name", "%Pyramid%")
    .single();

  const { data: tasks } = await sb
    .from("schedule_tasks")
    .select("wbs_code, task_name, status, pct_complete, start_date, end_date, duration_days")
    .eq("project_id", PROJECT_ID);

  const { data: commodities } = await sb
    .from("commodities")
    .select("id, label, uom, total_quantity")
    .eq("project_id", PROJECT_ID)
    .eq("active", true);

  const { data: production } = await sb
    .from("daily_production")
    .select("commodity_id, quantity, production_date")
    .eq("project_id", PROJECT_ID)
    .lte("production_date", PERIOD_END);

  const { data: firstDpr } = await sb
    .from("dprs")
    .select("report_date")
    .eq("project_id", PROJECT_ID)
    .eq("subcontractor_id", (sub as { id?: string } & typeof sub)?.id ?? "")
    .order("report_date", { ascending: true })
    .limit(1);

  const installed = new Map<string, number>();
  for (const p of production ?? []) {
    if (!p.commodity_id) continue;
    installed.set(p.commodity_id, (installed.get(p.commodity_id) ?? 0) + Number(p.quantity ?? 0));
  }

  const evidence: Evidence = {
    tasks: new Map((tasks ?? []).map((t) => [t.wbs_code, { ...t, wbs_code: t.wbs_code }])),
    commodities: new Map(
      (commodities ?? []).map((c) => [
        c.id,
        { label: c.label ?? "", installed: installed.get(c.id) ?? 0, total: Number(c.total_quantity ?? 0), uom: c.uom ?? null },
      ]),
    ),
    subOnSiteDate: firstDpr?.[0]?.report_date ?? null,
    todayIso: PERIOD_END,
  };

  const idByLabel = new Map((commodities ?? []).map((c) => [String(c.label ?? ""), c.id]));
  const sovLines: SovLine[] = RAW.map(([item, description, scheduled], i) => {
    const m = MAPPING[item] ?? {};
    const { commodities: labels, ...rest } = m;
    return {
      id: String(i),
      item_number: item,
      description,
      scheduled_value: scheduled,
      verification_method: "unmapped",
      linked_task_wbs_codes: [],
      linked_commodity_ids: (labels ?? []).map((l) => idByLabel.get(l)).filter(Boolean) as string[],
      ...rest,
    };
  }) as SovLine[];

  const rate = 0.05;
  const lines: BillLine[] = RAW.map(([item, description, scheduled, billed, retainage]) => ({
    item_number: item,
    description,
    scheduled_value: scheduled,
    from_previous: 0,
    this_period: billed,
    materials_stored: 0,
    total_completed: billed,
    pct_billed: scheduled > 0 ? billed / scheduled : 0,
    balance_to_finish: r2(scheduled - billed),
    retainage_amount: retainage,
  }));

  // Header exactly as printed on the G702.
  const header: BillHeader = {
    app_number: 1,
    period_start: null,
    period_end: PERIOD_END,
    retainage_pct: 5,
    payment_terms_days: 30,
    invoice_total: 133845.09,
    billed_previous: 0,
    billed_this_period: 133845.09,
    billed_to_date: 133845.09,
    retainage_this_period: 6692.25,
    retainage_to_date: 6692.25,
    amount_due: 127152.84,
    lien_waiver_received: true,
    lien_waiver_amount: 127152.84,
    lien_waiver_through_date: PERIOD_END,
  };

  console.log("=".repeat(78));
  console.log("BACK-TEST: Pyramid Excavation application 1, approved as billed 2026-08-13");
  console.log("=".repeat(78));

  const checks = runBillChecks({
    header,
    lines,
    sovLines,
    sub: sub as unknown as SubContext,
    prior: null,
  });

  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  const passes = checks.filter((c) => c.status === "pass");

  console.log(`\nPASS 1 - arithmetic and continuity: ${passes.length} passed, ${warns.length} warned, ${fails.length} failed\n`);
  for (const c of [...fails, ...warns]) {
    console.log(` [${c.status.toUpperCase().padEnd(4)}] ${c.label}`);
    console.log(`         ${c.message}`);
  }
  console.log("\n  passed:");
  for (const c of passes) console.log(`   - ${c.label}`);

  console.log(`\n${"-".repeat(78)}`);
  console.log("PASS 2 - field substantiation, evidence as of 2026-08-13");
  console.log(`${"-".repeat(78)}\n`);

  const header2 = "ITEM  BILLED%  VERIF%   BILLED $      VARIANCE $   VERDICT";
  console.log(header2);
  console.log("-".repeat(78));

  let flaggedDollars = 0;
  let unverifiedDollars = 0;
  const details: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (Number(line.this_period) === 0) continue;
    const v = verifyLine(sovLines[i], line, evidence);
    const billedPct = ((line.pct_billed ?? 0) * 100).toFixed(0) + "%";
    const verifPct = v.verifiedPct != null ? (v.verifiedPct * 100).toFixed(0) + "%" : "  -";
    const variance = v.varianceAmount != null ? money(v.varianceAmount) : "-";
    console.log(
      `${line.item_number.padEnd(6)}${billedPct.padStart(6)}${verifPct.padStart(9)}` +
        `${money(Number(line.this_period)).padStart(13)}${variance.padStart(15)}   ${v.flag.toUpperCase()}`,
    );
    if (v.flag === "flag" || v.flag === "review") flaggedDollars += v.varianceAmount ?? 0;
    if (v.flag === "unverifiable") unverifiedDollars += Number(line.this_period);
    details.push(`  ${line.item_number} ${line.description}\n      ${v.detail}`);
  }

  console.log("\nDetail:");
  for (const d of details) console.log(d);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`Bill total:                 ${money(133845.09)}`);
  console.log(`Flagged as ahead of field:  ${money(r2(flaggedDollars))}  (${((flaggedDollars / 133845.09) * 100).toFixed(0)}% of the bill)`);
  console.log(`Billed with no evidence:    ${money(r2(unverifiedDollars))}  (${((unverifiedDollars / 133845.09) * 100).toFixed(0)}% of the bill)`);
  console.log("=".repeat(78));

  // ---- Forward look: what application 2 should come in at ----------------
  // Same engine, evidence rolled to today, less what app 1 already paid for.
  const { data: prodNow } = await sb
    .from("daily_production")
    .select("commodity_id, quantity")
    .eq("project_id", PROJECT_ID);
  const installedNow = new Map<string, number>();
  for (const p of prodNow ?? []) {
    if (!p.commodity_id) continue;
    installedNow.set(p.commodity_id, (installedNow.get(p.commodity_id) ?? 0) + Number(p.quantity ?? 0));
  }
  const today = new Date().toISOString().slice(0, 10);
  const evidenceNow: Evidence = {
    tasks: evidence.tasks,
    commodities: new Map(
      (commodities ?? []).map((c) => [
        c.id,
        { label: c.label ?? "", installed: installedNow.get(c.id) ?? 0, total: Number(c.total_quantity ?? 0), uom: c.uom ?? null },
      ]),
    ),
    subOnSiteDate: firstDpr?.[0]?.report_date ?? null,
    todayIso: today,
  };

  const billedByItem = new Map(RAW.map(([item, , , billed]) => [item, billed]));
  const proj = projectNextBill({
    sovLines,
    billedToDateByItem: billedByItem,
    evidenceAtPeriodEnd: evidenceNow,
    retainagePct: 5,
  });

  console.log(`\n${"-".repeat(78)}`);
  console.log(`PROJECTED APPLICATION 2 - evidence as of ${today}`);
  console.log(`${"-".repeat(78)}\n`);
  console.log("ITEM   EARNED%   ALREADY BILLED    EXPECT TO BILL   BASIS");
  console.log("-".repeat(78));
  for (const l of proj.lines) {
    if (l.projectedThisPeriod <= 0) continue;
    console.log(
      `${l.itemNumber.padEnd(7)}${(((l.projectedPctAtPeriodEnd ?? 0) * 100).toFixed(0) + "%").padStart(6)}` +
        `${money(l.billedToDate).padStart(17)}${money(l.projectedThisPeriod).padStart(18)}   ${l.basis.slice(0, 30)}`,
    );
  }
  console.log("-".repeat(78));
  console.log(`Projected gross:              ${money(proj.grossTotal).padStart(14)}`);
  console.log(`Less 5% retainage:            ${money(proj.retainage).padStart(14)}`);
  console.log(`Expected amount due:          ${money(proj.netDue).padStart(14)}`);
  const noEvidence = proj.lines.filter((l) => l.projectedPctAtPeriodEnd == null);
  console.log(`Lines with no evidence source: ${noEvidence.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
