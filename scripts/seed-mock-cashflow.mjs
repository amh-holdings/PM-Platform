// Seeds a mock project to validate cash-flow handling of owner / sub /
// vendor payment terms. Idempotent: deletes the mock project (cascade)
// then re-inserts everything.
//
// Hand-calc reference is in the script header below — compare the
// dashboard widgets against these numbers.
//
// Usage:
//   node scripts/seed-mock-cashflow.mjs            (seed)
//   node scripts/seed-mock-cashflow.mjs --delete   (just delete)
//
// Mock project UUID: aaaaaaaa-bbbb-cccc-dddd-000000000001
//
// HAND-CALC REFERENCE - Vendor PO + Civil sub. $65k contract, 5 AFPs:
//   AFP 1  bill Mar  5,000  -> Apr cash  4,750 (net 5% ret)  - vendor deposit
//   AFP 2  bill May 20,000  -> Jun cash 19,000                - vendor delivery + margin
//   AFP 3  bill Jul 13,333  -> Aug cash 12,667                - civil Jul work
//   AFP 4  bill Aug 13,333  -> Sep cash 12,667                - civil Aug work
//   AFP 5  bill Sep 13,334  -> Oct cash 12,667                - civil Sep work
//
//   Month   CashIn    CashOut   Net      Cum    Notes
//   Apr     4,750      4,000    750       750   vendor deposit paid
//   Jun    19,000     16,000  3,000     3,750   vendor delivery
//   Aug    12,667      9,000  3,667     7,417   civil Jul work paid Net 30
//   Sep    12,667      9,000  3,667    11,083   civil Aug work paid
//   Oct    12,667      9,000  3,667    14,750   civil Sep work paid
//   Final   3,250      3,000    250    15,000   retainage release (deferred)
//   ----------------------------------------------------------------------
//   Margin: 65,000 - 20,000 vendor - 30,000 civil = 15,000. Always positive.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const TEST_PROJECT_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000001";

// ---------- env ----------
const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) throw new Error("Missing Supabase env in .env.local");

const sb = createClient(SB_URL, SB_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const deleteOnly = process.argv.includes("--delete");

// ---------- main ----------
async function main() {
  console.log(`Resetting mock project ${TEST_PROJECT_ID} ...`);
  const { error: delErr } = await sb
    .from("projects")
    .delete()
    .eq("id", TEST_PROJECT_ID);
  if (delErr) throw delErr;

  if (deleteOnly) {
    console.log("Deleted. Done.");
    return;
  }

  // 1. project
  const { error: pErr } = await sb.from("projects").insert({
    id: TEST_PROJECT_ID,
    name: "Test Project - Cash Flow",
    client: "Test Owner LLC",
    status: "active",
    contract_value: 65000,
    ntp_date: "2026-04-01",
    cod_date: "2026-08-31",
    zip_code: "32801",
    owner_payment_terms_days: 30,
    retainage_pct_default: 5,
    retainage_release_event: "substantial_completion",
  });
  if (pErr) throw pErr;
  console.log("  + project");

  // 2. owner billing_lines + billing_entries (Net 30)
  // Two lines: Vendor supply scope (already running) + Civil scope (starts Jul).
  const { data: vendorLine, error: blErr } = await sb
    .from("billing_lines")
    .insert({
      project_id: TEST_PROJECT_ID,
      item_number: "1.0",
      description: "Vendor supply scope",
      scheduled_value: 25000,
      sort_order: 1,
      type: "Base contract",
    })
    .select("id")
    .single();
  if (blErr) throw blErr;
  const { data: civilLine, error: blErr2 } = await sb
    .from("billing_lines")
    .insert({
      project_id: TEST_PROJECT_ID,
      item_number: "2.0",
      description: "Civil scope",
      scheduled_value: 40000,
      sort_order: 2,
      type: "Base contract",
    })
    .select("id")
    .single();
  if (blErr2) throw blErr2;
  console.log("  + billing_lines (2)");

  // AFP 1-2: vendor supply. AFP 3-5: civil monthly (bill in work month since
  // sub Net 30 = owner Net 30, so timing matches).
  const billingEntries = [
    { line: vendorLine.id, period: "2026-03-01", cashIn: "2026-04-01", planned:  5000, actual:  5000, ret:  250, afp: "AFP 1", status: "paid",    paidAt: "2026-04-01" },
    { line: vendorLine.id, period: "2026-05-01", cashIn: "2026-06-01", planned: 20000, actual: 20000, ret: 1000, afp: "AFP 2", status: "paid",    paidAt: "2026-06-01" },
    { line: civilLine.id,  period: "2026-07-01", cashIn: "2026-08-01", planned: 13333, actual:     0, ret:  667, afp: "AFP 3", status: "planned", paidAt: null },
    { line: civilLine.id,  period: "2026-08-01", cashIn: "2026-09-01", planned: 13333, actual:     0, ret:  667, afp: "AFP 4", status: "planned", paidAt: null },
    { line: civilLine.id,  period: "2026-09-01", cashIn: "2026-10-01", planned: 13334, actual:     0, ret:  666, afp: "AFP 5", status: "planned", paidAt: null },
  ];
  for (const e of billingEntries) {
    const { error } = await sb.from("billing_entries").insert({
      billing_line_id: e.line,
      period_month: e.period,
      cash_in_month: e.cashIn,
      planned_amount: e.planned,
      actual_amount: e.actual,
      retainage_amount: e.ret,
      afp_number: e.afp,
      status: e.status,
      paid_at: e.paidAt,
    });
    if (error) throw error;
  }
  console.log(`  + billing_entries (${billingEntries.length})`);

  // 3. subcontractor + cost_code + cost_forecasts (Civil, Net 30, 10% retainage)
  const { data: sub, error: sErr } = await sb
    .from("subcontractors")
    .insert({
      project_id: TEST_PROJECT_ID,
      company_name: "Civil",
      trade: "Civil / earthwork",
      contract_value: 30000,
      payment_terms: "Net 30",
      payment_terms_days: 30,
      retainage_pct: 10,
      coi_status: "current",
      w9_status: "on_file",
      active: true,
      contact_name: "Mock Contact",
      contact_email: "mock@civilsub.com",
    })
    .select("id")
    .single();
  if (sErr) throw sErr;
  console.log("  + subcontractor (Civil)");

  const { data: subCode, error: scErr } = await sb
    .from("cost_codes")
    .insert({
      project_id: TEST_PROJECT_ID,
      code: "CIV-01",
      name: "Civil earthwork",
      description: "Civil sub scope - Jul/Aug/Sep monthly",
      estimated_cost: 30000,
      subcontractor_id: sub.id,
      sort_order: 2,
    })
    .select("id")
    .single();
  if (scErr) throw scErr;
  console.log("  + cost_code (civil)");

  // Sub completes 1/3 of work each month Jul/Aug/Sep, invoices end-of-month,
  // AHC pays Net 30 -> cash out Aug/Sep/Oct (net of 10% retainage).
  const subForecasts = [
    { period: "2026-07-01", planned: 10000, actual: 0 },
    { period: "2026-08-01", planned: 10000, actual: 0 },
    { period: "2026-09-01", planned: 10000, actual: 0 },
  ];
  for (const f of subForecasts) {
    const { error } = await sb.from("cost_forecasts").insert({
      cost_code_id: subCode.id,
      period_month: f.period,
      planned_amount: f.planned,
      actual_amount: f.actual,
    });
    if (error) throw error;
  }
  console.log(`  + cost_forecasts civil (${subForecasts.length})`);

  // 4. procurement_order + payments (2 milestones)
  const { data: po, error: poErr } = await sb
    .from("procurement_orders")
    .insert({
      project_id: TEST_PROJECT_ID,
      vendor_name: "Test Vendor Modules",
      po_number: "PO-001",
      description: "PV modules supply",
      total_value: 20000,
      ordered_date: "2026-04-01",
      expected_delivery_date: "2026-06-15",
      status: "active",
      payment_terms_summary: "20% deposit / 80% delivery",
    })
    .select("id")
    .single();
  if (poErr) throw poErr;
  console.log("  + procurement_order");

  const { data: vendorCode, error: vcErr } = await sb
    .from("cost_codes")
    .insert({
      project_id: TEST_PROJECT_ID,
      code: "VND-01",
      name: "PV modules (PO-001)",
      description: "Vendor module supply",
      estimated_cost: 20000,
      procurement_order_id: po.id,
      sort_order: 1,
    })
    .select("id")
    .single();
  if (vcErr) throw vcErr;
  console.log("  + cost_code (vendor)");

  const milestones = [
    { name: "Deposit",  pct: 20, amount:  4000, date: "2026-04-15", trigger: "PO release", paidAt: "2026-04-15", paidAmt:  4000, sort: 1 },
    { name: "Delivery", pct: 80, amount: 16000, date: "2026-06-15", trigger: "Delivery",   paidAt: null,         paidAmt: null,  sort: 2 },
  ];
  for (const m of milestones) {
    const { error } = await sb.from("procurement_payments").insert({
      procurement_order_id: po.id,
      milestone_name: m.name,
      pct_of_total: m.pct,
      amount: m.amount,
      expected_date: m.date,
      trigger_event: m.trigger,
      paid_at: m.paidAt,
      paid_amount: m.paidAmt,
      sort_order: m.sort,
    });
    if (error) throw error;
  }
  console.log(`  + procurement_payments (${milestones.length})`);

  console.log(`\nDone. View at /projects/${TEST_PROJECT_ID}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
