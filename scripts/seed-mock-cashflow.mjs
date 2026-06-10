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
  // Tear down in dependency order. pay_application_lines references
  // billing_lines with NO ACTION, so we have to drop pay_applications
  // (which cascades to their lines) before deleting the project (which
  // cascades to billing_lines).
  await sb.from("pay_applications").delete().eq("project_id", TEST_PROJECT_ID);
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

  // AFP 1-2: vendor supply (paid). AFP 3-5: civil monthly (forecast - work
  // hasn't started yet as of 2026-06-10).
  // Status values from migration 0009: forecast / suggested / reviewed /
  // on_pay_app / submitted / approved / paid.
  const billingEntries = [
    { line: vendorLine.id, period: "2026-03-01", cashIn: "2026-04-01", planned:  5000, actual:  5000, ret:  250, afp: "AFP 1", status: "paid",     paidAt: "2026-04-01", submittedAt: "2026-03-31", reviewedAt: "2026-04-05" },
    { line: vendorLine.id, period: "2026-05-01", cashIn: "2026-06-01", planned: 20000, actual: 20000, ret: 1000, afp: "AFP 2", status: "paid",     paidAt: "2026-06-01", submittedAt: "2026-05-31", reviewedAt: "2026-06-05" },
    { line: civilLine.id,  period: "2026-07-01", cashIn: "2026-08-01", planned: 13333, actual:     0, ret:  667, afp: "AFP 3", status: "forecast", paidAt: null, submittedAt: null, reviewedAt: null },
    { line: civilLine.id,  period: "2026-08-01", cashIn: "2026-09-01", planned: 13333, actual:     0, ret:  667, afp: "AFP 4", status: "forecast", paidAt: null, submittedAt: null, reviewedAt: null },
    { line: civilLine.id,  period: "2026-09-01", cashIn: "2026-10-01", planned: 13334, actual:     0, ret:  666, afp: "AFP 5", status: "forecast", paidAt: null, submittedAt: null, reviewedAt: null },
  ];
  const entryIds = [];
  for (const e of billingEntries) {
    const { data: row, error } = await sb.from("billing_entries").insert({
      billing_line_id: e.line,
      period_month: e.period,
      cash_in_month: e.cashIn,
      planned_amount: e.planned,
      actual_amount: e.actual,
      retainage_amount: e.ret,
      afp_number: e.afp,
      status: e.status,
      paid_at: e.paidAt,
      submitted_at: e.submittedAt,
      reviewed_at: e.reviewedAt,
    }).select("id").single();
    if (error) throw error;
    entryIds.push({ id: row.id, ...e });
  }
  console.log(`  + billing_entries (${billingEntries.length})`);

  // ----- Pay applications wrapping AFP 1 + AFP 2 -----
  // Each pay_application snapshots the G702 cover totals for an AFP cycle.
  // pay_application_lines are the G703 detail rows frozen at submission time.
  const payApps = [
    {
      app_number: "AFP 1",
      period_start: "2026-03-01",
      period_end: "2026-03-31",
      status: "paid",
      total_completed: 5000,   // gross billed this period
      total_retainage: 250,
      previous_billings: 0,    // first AFP
      amount_due: 4750,
      submitted_at: "2026-03-31T17:00:00Z",
      approved_at: "2026-04-03T12:00:00Z",
      approved_by_owner: "Test Owner LLC",
      paid_at: "2026-04-01T00:00:00Z",
      entries: entryIds.filter((e) => e.afp === "AFP 1"),
      lines: [
        { lineId: vendorLine.id, item: "1.0", desc: "Vendor supply scope", scheduled: 25000, prev: 0, thisPeriod: 5000, total: 5000, pct: 20, balance: 20000, ret: 250 },
      ],
    },
    {
      app_number: "AFP 2",
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      status: "paid",
      total_completed: 25000,  // cumulative gross billed (AFP 1 + AFP 2)
      total_retainage: 1250,   // cumulative retainage
      previous_billings: 5000, // AFP 1 was the prior bill
      amount_due: 19000,       // this period less retainage = 20000 - 1000
      submitted_at: "2026-05-31T17:00:00Z",
      approved_at: "2026-06-03T12:00:00Z",
      approved_by_owner: "Test Owner LLC",
      paid_at: "2026-06-01T00:00:00Z",
      entries: entryIds.filter((e) => e.afp === "AFP 2"),
      lines: [
        { lineId: vendorLine.id, item: "1.0", desc: "Vendor supply scope", scheduled: 25000, prev: 5000, thisPeriod: 20000, total: 25000, pct: 100, balance: 0, ret: 1250 },
      ],
    },
  ];
  for (const pa of payApps) {
    const { data: paRow, error: paErr } = await sb
      .from("pay_applications")
      .insert({
        project_id: TEST_PROJECT_ID,
        app_number: pa.app_number,
        period_start: pa.period_start,
        period_end: pa.period_end,
        status: pa.status,
        total_completed: pa.total_completed,
        total_retainage: pa.total_retainage,
        previous_billings: pa.previous_billings,
        amount_due: pa.amount_due,
        submitted_at: pa.submitted_at,
        approved_at: pa.approved_at,
        approved_by_owner: pa.approved_by_owner,
        paid_at: pa.paid_at,
      })
      .select("id")
      .single();
    if (paErr) throw paErr;

    // Snapshot G703 lines.
    for (let i = 0; i < pa.lines.length; i++) {
      const ln = pa.lines[i];
      const { error: lnErr } = await sb.from("pay_application_lines").insert({
        pay_application_id: paRow.id,
        billing_line_id: ln.lineId,
        item_number: ln.item,
        description: ln.desc,
        scheduled_value: ln.scheduled,
        work_completed_previous: ln.prev,
        work_completed_this_period: ln.thisPeriod,
        materials_stored: 0,
        total_completed_and_stored: ln.total,
        pct_complete: ln.pct,
        balance_to_finish: ln.balance,
        retainage_amount: ln.ret,
        sort_order: i + 1,
      });
      if (lnErr) throw lnErr;
    }

    // Link the billing_entries to this pay_application.
    for (const e of pa.entries) {
      const { error: linkErr } = await sb
        .from("billing_entries")
        .update({ pay_application_id: paRow.id })
        .eq("id", e.id);
      if (linkErr) throw linkErr;
    }
  }
  console.log(`  + pay_applications (${payApps.length}, with G703 lines + entry links)`);

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

  // ----- Schedule tasks for civil work (Jul/Aug/Sep) -----
  // Three monthly tasks, each = 1/3 of the civil scope. With civil billing_line
  // linked to all three WBS codes, the schedule-based suggestion math becomes:
  //   avg pct_complete across linked tasks * scheduled_value - already_billed
  // Bump a task's pct_complete (via DPR in real life, or manually in /schedule)
  // and the suggestion auto-refreshes.
  const civilTasks = [
    { wbs: "CIV-1.1", name: "Civil earthwork - July", start: "2026-07-01", end: "2026-07-31", duration: 22, sort: 1 },
    { wbs: "CIV-1.2", name: "Civil earthwork - August", start: "2026-08-01", end: "2026-08-31", duration: 21, sort: 2 },
    { wbs: "CIV-1.3", name: "Civil earthwork - September", start: "2026-09-01", end: "2026-09-30", duration: 22, sort: 3 },
  ];
  for (const t of civilTasks) {
    const { error } = await sb.from("schedule_tasks").insert({
      project_id: TEST_PROJECT_ID,
      wbs_code: t.wbs,
      task_name: t.name,
      phase: "Civil",
      status: "Planned",
      duration_days: t.duration,
      start_date: t.start,
      end_date: t.end,
      pct_complete: 0,
      sort_order: t.sort,
      level_code: 2,
    });
    if (error) throw error;
  }
  console.log(`  + schedule_tasks civil (${civilTasks.length})`);

  // Link civil billing_line to those tasks so auto-suggest can target it.
  const { error: linkErr } = await sb
    .from("billing_lines")
    .update({ linked_task_wbs_codes: civilTasks.map((t) => t.wbs) })
    .eq("id", civilLine.id);
  if (linkErr) throw linkErr;
  console.log(`  + civil billing_line linked to ${civilTasks.length} WBS codes`);

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
