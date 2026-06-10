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
// HAND-CALC REFERENCE - Funded AFP schedule (bill 1 cycle before each cash-out):
//   AFP 0  bill Mar 30,000  -> Apr cash 28,500 (net 5% ret) - covers Apr deposit
//   AFP 1  bill Apr 15,000  -> May cash 14,250                - covers May sub
//   AFP 2  bill May 30,000  -> Jun cash 28,500                - covers Jun sub+vendor
//   AFP 3  bill Jun 15,000  -> Jul cash 14,250                - covers Jul sub
//   AFP 4  bill Jul 10,000  -> Aug cash  9,500                - covers Aug sub+vendor
//
//   Month   CashIn    CashOut    Net      Cum
//   Mar         0          0      0         0
//   Apr    28,500      4,000  24,500    24,500
//   May    14,250      9,000   5,250    29,750
//   Jun    28,500     27,500   1,000    30,750
//   Jul    14,250      9,000   5,250    36,000
//   Aug     9,500      6,500   3,000    39,000
//   Final   5,000      4,000   1,000    40,000  (retainage release - deferred)
//   ----------------------------------------------------------------------
//   Margin: 100,000 revenue - 60,000 cost = 40,000. Never goes negative.

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
    contract_value: 100000,
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
  const { data: line, error: blErr } = await sb
    .from("billing_lines")
    .insert({
      project_id: TEST_PROJECT_ID,
      item_number: "1.0",
      description: "Base contract work",
      scheduled_value: 100000,
      sort_order: 1,
      type: "Base contract",
    })
    .select("id")
    .single();
  if (blErr) throw blErr;
  console.log("  + billing_lines (1)");

  // Funded schedule: each AFP bills 1 cycle BEFORE the cash-out it covers,
  // so owner cash (Net 30) lands the same month as the disbursement.
  // Today is 2026-06-10: AFP 0 + AFP 1 are paid (past), AFP 2 in flight, rest planned.
  const billingEntries = [
    { period: "2026-03-01", cashIn: "2026-04-01", planned: 30000, actual: 30000, ret: 1500, afp: "AFP 0", status: "paid",    paidAt: "2026-04-01" },
    { period: "2026-04-01", cashIn: "2026-05-01", planned: 15000, actual: 15000, ret:  750, afp: "AFP 1", status: "paid",    paidAt: "2026-05-01" },
    { period: "2026-05-01", cashIn: "2026-06-01", planned: 30000, actual: 30000, ret: 1500, afp: "AFP 2", status: "paid",    paidAt: "2026-06-01" },
    { period: "2026-06-01", cashIn: "2026-07-01", planned: 15000, actual:     0, ret:  750, afp: "AFP 3", status: "planned", paidAt: null },
    { period: "2026-07-01", cashIn: "2026-08-01", planned: 10000, actual:     0, ret:  500, afp: "AFP 4", status: "planned", paidAt: null },
  ];
  for (const e of billingEntries) {
    const { error } = await sb.from("billing_entries").insert({
      billing_line_id: line.id,
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

  // 3. subcontractor + cost_code + cost_forecasts (Net 30, 10% retainage)
  const { data: sub, error: sErr } = await sb
    .from("subcontractors")
    .insert({
      project_id: TEST_PROJECT_ID,
      company_name: "Test Sub Electric",
      trade: "Electrical",
      contract_value: 40000,
      payment_terms: "Net 30",
      payment_terms_days: 30,
      retainage_pct: 10,
      coi_status: "current",
      w9_status: "on_file",
      active: true,
      contact_name: "Mock Contact",
      contact_email: "mock@testsub.com",
    })
    .select("id")
    .single();
  if (sErr) throw sErr;
  console.log("  + subcontractor");

  const { data: subCode, error: scErr } = await sb
    .from("cost_codes")
    .insert({
      project_id: TEST_PROJECT_ID,
      code: "EL-01",
      name: "Electrical install",
      description: "Sub-installed electrical scope",
      estimated_cost: 40000,
      subcontractor_id: sub.id,
      sort_order: 1,
    })
    .select("id")
    .single();
  if (scErr) throw scErr;
  console.log("  + cost_code (sub)");

  const subForecasts = [
    { period: "2026-04-01", planned: 10000, actual: 10000 },
    { period: "2026-05-01", planned: 15000, actual: 15000 },
    { period: "2026-06-01", planned: 10000, actual: 0 },
    { period: "2026-07-01", planned:  5000, actual: 0 },
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
  console.log(`  + cost_forecasts sub (${subForecasts.length})`);

  // 4. procurement_order + payments (3 milestones)
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
      payment_terms_summary: "20% deposit / 70% delivery / 10% commissioning",
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
      sort_order: 2,
    })
    .select("id")
    .single();
  if (vcErr) throw vcErr;
  console.log("  + cost_code (vendor)");

  const milestones = [
    { name: "Deposit",       pct: 20, amount:  4000, date: "2026-04-15", trigger: "PO release",    paidAt: "2026-04-15", paidAmt:  4000, sort: 1 },
    { name: "Delivery",      pct: 70, amount: 14000, date: "2026-06-15", trigger: "Delivery",      paidAt: null,         paidAmt: null,  sort: 2 },
    { name: "Commissioning", pct: 10, amount:  2000, date: "2026-08-15", trigger: "Commissioning", paidAt: null,         paidAmt: null,  sort: 3 },
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
