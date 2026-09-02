/**
 * Backfill AFP 10 and AFP 11 on Sweet Springs from the executed documents.
 *
 * Source of truth: the signed AIA G702/G703 packages
 *   "AFP 10 Sweet Spring 7026.08.03.pdf"  - period to 30-Jun-26, due $112,985.86
 *   "AFP 11 Sweet Springs - Final 2026.08.03.pdf" - period to 31-Jul-26, due $136,316.47
 * plus change orders CO#5 (piles, $102,351.52) and CO#6 (bond premium, $31,224.00).
 *
 * These two applications were invoiced outside the platform because billing was
 * not ready. The G703 continuation sheets are the authority for every figure
 * here; where the app's per-line rounding differs from the printed sheet by a
 * cent, the printed sheet wins and the delta is reported.
 *
 * Idempotent. Run with --apply to write; default is a dry run.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const RET_PCT = 5; // every executed G702 on this job reads "5 % of Completed Work"

const log = [];
const note = (s) => { log.push(s); console.log(s); };
const r2 = (n) => Math.round(n * 100) / 100;

async function run(label, fn) {
  if (!APPLY) { note(`  [dry] ${label}`); return null; }
  const res = await fn();
  if (res?.error) throw new Error(`${label}: ${res.error.message}`);
  note(`  [ok ] ${label}`);
  return res?.data ?? null;
}

// ---------------------------------------------------------------- step A
// Corrections that must land before AFP 10, because previous-billings on the
// G703 is computed from billing_entries, not from the prior app's snapshot.
note("\n=== A. Corrections ===");

// A1. Retainage rate. projects.retainage_pct_default is 10, but AFP 1-11 all
//     billed 5%. Left at 10 the next application doubles the withholding.
const { data: proj } = await sb
  .from("projects").select("retainage_pct_default, contract_value").eq("id", PID).single();
note(`A1 retainage_pct_default ${proj.retainage_pct_default} -> ${RET_PCT}`);
await run("projects.retainage_pct_default = 5", () =>
  sb.from("projects").update({ retainage_pct_default: RET_PCT }).eq("id", PID));

// A2. Contract value. DB carries the pre-CO#5 sum. CO#5 (+102,351.52) and
//     CO#6 (+31,224.00) bring it to the AFP 11 "CONTRACT SUM TO DATE".
const NEW_CONTRACT = 3787185.91;
note(`A2 contract_value ${proj.contract_value} -> ${NEW_CONTRACT}`);
await run("projects.contract_value = 3,787,185.91", () =>
  sb.from("projects").update({ contract_value: NEW_CONTRACT }).eq("id", PID));

// A3. CO-04 is 67,458.31 on the executed CO#5 form (original 2,507,500.00 +
//     1,146,110.39 through CO#4 = 3,653,610.39). The DB carries 67,458.34,
//     which is why the SOV summed 3 cents over the contract.
note("A3 CO-04 co_value 67,458.34 -> 67,458.31 (and billing line 14.00)");
await run("change_orders CO-04 = 67,458.31", () =>
  sb.from("change_orders").update({ co_value: 67458.31 }).eq("project_id", PID).eq("co_number", "CO-04"));
await run("billing_lines 14.00 scheduled_value = 67,458.31", () =>
  sb.from("billing_lines").update({ scheduled_value: 67458.31 }).eq("project_id", PID).eq("item_number", "14.00"));

// Helper: billing_lines by item number.
async function lineMap() {
  const { data } = await sb.from("billing_lines")
    .select("id,item_number,description,scheduled_value,sort_order").eq("project_id", PID);
  return new Map(data.map((l) => [l.item_number, l]));
}
let LINES = await lineMap();

// A4. AFP 9's billing_entries were never reconciled to its own snapshot.
//     The snapshot (pay_application_lines) reads 5.05 = 66,038.15 and
//     14.00 = 67,458.34, and the AFP 10 G703 "from previous application"
//     column agrees (66,038.15 / 67,458.31, total 1,234,680.49). But
//     billing_entries carries a loose 5.05 row at 79,160.25 for 2026-05 with
//     no pay_application_id, and no 14.00 row at all. Previous-billings on
//     AFP 10 reads billing_entries, so left alone it would report
//     1,247,802.59 instead of 1,234,680.49 and every later G703 inherits it.
const AFP9_ID = "e857d494-0e8d-44a5-b49a-eb7aebf3bed0";
note("\nA4 reconcile AFP 9 billing_entries to its G703");
const { data: e505 } = await sb.from("billing_entries")
  .select("id,actual_amount,period_month,status,pay_application_id")
  .eq("billing_line_id", LINES.get("5.05").id).eq("period_month", "2026-05-01").maybeSingle();
if (e505) {
  note(`   5.05 2026-05 actual ${e505.actual_amount} -> 66038.15, stamp AFP 9, status paid`);
  await run("billing_entries 5.05 May = 66,038.15 on AFP 9", () =>
    sb.from("billing_entries").update({
      actual_amount: 66038.15, retainage_amount: 3301.91,
      pay_application_id: AFP9_ID, status: "paid", afp_number: "AFP 9",
      notes: "Reconciled to executed AFP 9 G703 (was 79,160.25, unsupported by any signed application).",
    }).eq("id", e505.id));
}
const { data: e14 } = await sb.from("billing_entries").select("id")
  .eq("billing_line_id", LINES.get("14.00").id).eq("period_month", "2026-05-01").maybeSingle();
if (!e14) {
  note("   14.00 2026-05 entry missing -> insert 67,458.31 on AFP 9");
  await run("billing_entries 14.00 May = 67,458.31 on AFP 9", () =>
    sb.from("billing_entries").insert({
      billing_line_id: LINES.get("14.00").id, period_month: "2026-05-01",
      planned_amount: 0, actual_amount: 67458.31, retainage_amount: 3372.92,
      pay_application_id: AFP9_ID, status: "paid", afp_number: "AFP 9",
      notes: "Backfilled from executed AFP 9 G703 (CO#4 SCADA cost increase and storage, 100%).",
    }));
}
// AFP 9 snapshot + rollup to the executed figures (paid 126,821.62 per the
// unconditional waiver in the AFP 11 package; the 2c is AHC's rounding line).
await run("pay_application_lines AFP 9 / 14.00 = 67,458.31", () =>
  sb.from("pay_application_lines").update({
    scheduled_value: 67458.31, work_completed_this_period: 67458.31,
    total_completed_and_stored: 67458.31, balance_to_finish: 0, retainage_amount: 3372.92,
  }).eq("pay_application_id", AFP9_ID).eq("item_number", "14.00"));
await run("pay_applications AFP 9 rollup + paid", () =>
  sb.from("pay_applications").update({
    total_completed: 133496.46, total_retainage: 6674.83,
    previous_billings: 1101184.03, amount_due: 126821.62, status: "paid",
    notes: "Billed outside the platform. Payment received $126,821.62 (unconditional waiver 8/1/2026).",
  }).eq("id", AFP9_ID));

// ---------------------------------------------------------------- step B
// CO#5 and CO#6 and their SOV lines. The G703 on AFP 11 carries both as
// items 15.00 and 16.00 at the bottom of the sheet.
note("\n=== B. CO-05 / CO-06 and SOV lines 15.00 / 16.00 ===");
const COS = [
  { co_number: "CO-05", description: "Piles Foundation Scope Change - pile length increase 3.0/3.08m to 3.30/3.39m per Jan 2025 layout revision, plus conversion to US-domestic steel sourcing for the full 492-pile scope (Section 301 tariff event).",
    co_value: 102351.52, status: "approved", approved_at: "2026-07-01",
    item: "15.00", item_desc: "Piles", item_type: "Change Order Five", sort_order: 52 },
  { co_number: "CO-06", description: "Bond Premium - HUB International endorsement #58231127 increasing P&P Bond 800177234 coverage from $2,507,000 to $3,755,961.91. Direct pass-through third-party cost.",
    co_value: 31224.00, status: "approved", approved_at: "2026-07-30",
    item: "16.00", item_desc: "Bond Premium", item_type: "Change Order Six", sort_order: 53 },
];
for (const co of COS) {
  const { data: existing } = await sb.from("change_orders").select("id")
    .eq("project_id", PID).eq("co_number", co.co_number).maybeSingle();
  let coId = existing?.id ?? null;
  if (!coId) {
    note(`B ${co.co_number}  $${co.co_value.toLocaleString()}  -> insert`);
    const d = await run(`change_orders ${co.co_number}`, () =>
      sb.from("change_orders").insert({
        project_id: PID, co_number: co.co_number, description: co.description,
        co_value: co.co_value, status: co.status, approved_at: co.approved_at,
        schedule_impact_days: 0,
      }).select("id").single());
    coId = d?.id ?? null;
  } else { note(`B ${co.co_number} already present`); }

  const { data: bl } = await sb.from("billing_lines").select("id")
    .eq("project_id", PID).eq("item_number", co.item).maybeSingle();
  if (!bl) {
    note(`B billing line ${co.item} "${co.item_desc}" $${co.co_value.toLocaleString()} -> insert`);
    await run(`billing_lines ${co.item}`, () =>
      sb.from("billing_lines").insert({
        project_id: PID, item_number: co.item, description: co.item_desc,
        type: co.item_type, scheduled_value: co.co_value, sort_order: co.sort_order,
        change_order_id: coId,
      }));
  } else { note(`B billing line ${co.item} already present`); }
}
LINES = await lineMap();

// A5. Retainage on 2.00 / 3.00 / 5.06 was withheld on the executed sheets but
//     imported as zero. The AFP 11 G703 column I totals $28,547.77 held; the
//     platform reports $19,796.01 without these three.
note("\nA5 backfill withheld retainage on pre-platform AFPs");
const RET_FIX = [
  { item: "2.00", month: "2024-08-01", ret: 4250.88 },  // EPC Contract, AFP 2A/2B
  { item: "3.00", month: "2025-01-01", ret: 2125.44 },  // IFP/IFC Engineering, AFP 5R
  { item: "3.00", month: "2025-03-01", ret: 2125.44 },  // IFP/IFC Engineering, AFP 6
  { item: "5.06", month: "2025-03-01", ret: 250.0 },    // Transformer, AFP 6
];
for (const f of RET_FIX) {
  note(`   ${f.item} ${f.month} retainage -> ${f.ret}`);
  await run(`billing_entries ${f.item} ${f.month} retainage`, () =>
    sb.from("billing_entries").update({ retainage_amount: f.ret })
      .eq("billing_line_id", LINES.get(f.item).id).eq("period_month", f.month));
}

// ---------------------------------------------------------------- step C
// The two applications. Line amounts are the G703 "THIS PERIOD" column; the
// roll-up totals are the executed G702 / invoice, which carry AHC's own
// rounding-adjustment line where per-line rounding differs by a cent.
note("\n=== C. AFP 10 and AFP 11 ===");
const APPS = [
  {
    app_number: "AFP 10",
    period_start: "2026-06-01", period_end: "2026-06-30",
    status: "paid",
    notes: "Billed outside the platform (invoice SS2026 010, 7/2/2026). Payment $112,985.86 received - unconditional waiver 8/1/2026. Backfilled from the executed G702/G703.",
    entries: [
      { item: "5.05", amount: 16580.97, ret: 829.05 },     // POI Procurement -> 82,619.12 / 49.08%
      { item: "15.00", amount: 102351.52, ret: 5117.58 },  // CO#5 Piles, 100%
    ],
    doc: { total_completed: 118932.49, total_retainage: 5946.62, previous_billings: 1234680.49, amount_due: 112985.86 },
  },
  {
    app_number: "AFP 11",
    period_start: "2026-07-01", period_end: "2026-07-31",
    status: "submitted",
    notes: "Billed outside the platform (invoice SS2026 011, 8/1/2026). $136,316.47 invoiced, conditional waiver issued, payment not yet received. Backfilled from the executed G702/G703.",
    entries: [
      { item: "6.01", amount: 112267.03, ret: 5613.36 },   // Site Work Mobilization 35%
      { item: "16.00", amount: 31224.0, ret: 1561.2 },     // CO#6 Bond Premium, 100%
    ],
    doc: { total_completed: 143491.03, total_retainage: 7174.56, previous_billings: 1353612.98, amount_due: 136316.47 },
  },
];

for (const A of APPS) {
  note(`\n-- ${A.app_number}  ${A.period_start}..${A.period_end}  due $${A.doc.amount_due.toLocaleString()}`);
  const { data: found } = await sb.from("pay_applications").select("id")
    .eq("project_id", PID).eq("app_number", A.app_number).maybeSingle();
  let appId = found?.id ?? null;
  if (appId) { note(`   already exists (${appId})`); }
  else {
    const d = await run(`pay_applications ${A.app_number}`, () =>
      sb.from("pay_applications").insert({
        project_id: PID, app_number: A.app_number,
        period_start: A.period_start, period_end: A.period_end,
        status: "draft", notes: A.notes,
      }).select("id").single());
    appId = d?.id ?? null;
  }
  A._appId = appId;

  // C1. billing_entries for this period's work.
  for (const e of A.entries) {
    const line = LINES.get(e.item);
    if (!line) { note(`   !! billing line ${e.item} not present yet (dry run)`); continue; }
    const { data: ex } = await sb.from("billing_entries").select("id")
      .eq("billing_line_id", line.id).eq("period_month", A.period_start).maybeSingle();
    const payload = {
      planned_amount: 0, actual_amount: e.amount, retainage_amount: e.ret,
      pay_application_id: appId, status: A.status, afp_number: A.app_number,
      notes: `Backfilled from the executed ${A.app_number} G703.`,
    };
    note(`   entry ${e.item} ${A.period_start}  $${e.amount.toLocaleString()}  ret $${e.ret}`);
    if (ex) {
      await run(`billing_entries ${e.item}`, () =>
        sb.from("billing_entries").update(payload).eq("id", ex.id));
    } else {
      await run(`billing_entries ${e.item}`, () =>
        sb.from("billing_entries").insert({ billing_line_id: line.id, period_month: A.period_start, ...payload }));
    }
  }
}

// ---------------------------------------------------------------- step D
// pay_application_lines snapshots, built with the SAME algorithm the app uses
// in createPayApplication() so a later recompute agrees with what is stored.
// Previous = every entry with billing evidence in a month before this period,
// or stamped onto an earlier application.
note("\n=== D. G703 snapshots ===");
const BILLED = new Set(["on_pay_app", "submitted", "approved", "paid"]);
const hasEvidence = (e) => !!e.pay_application_id || !!e.afp_number || BILLED.has(e.status ?? "");

for (const A of APPS) {
  if (!A._appId) { note(`   ${A.app_number}: no id (dry run) - snapshot skipped`); continue; }
  const { data: lines } = await sb.from("billing_lines")
    .select("id,item_number,description,scheduled_value,sort_order").eq("project_id", PID)
    .order("sort_order", { ascending: true, nullsFirst: false }).order("item_number");
  const { data: entries } = await sb.from("billing_entries")
    .select("id,billing_line_id,period_month,actual_amount,planned_amount,pay_application_id,status,afp_number")
    .in("billing_line_id", lines.map((l) => l.id));

  const prevByLine = new Map(), thisByLine = new Map();
  for (const e of entries) {
    const amt = Number(e.actual_amount ?? 0) > 0 ? Number(e.actual_amount) : Number(e.planned_amount ?? 0);
    if (amt <= 0) continue;
    if (e.pay_application_id === A._appId) {
      thisByLine.set(e.billing_line_id, (thisByLine.get(e.billing_line_id) ?? 0) + amt);
    } else if ((!!e.pay_application_id || e.period_month < A.period_start) && hasEvidence(e)) {
      // Only applications that precede this one count as previous.
      if (e.period_month < A.period_start) prevByLine.set(e.billing_line_id, (prevByLine.get(e.billing_line_id) ?? 0) + amt);
    }
  }
  const retByItem = new Map(A.entries.map((e) => [e.item, e.ret]));
  const inserts = lines.map((l, i) => {
    const prev = r2(prevByLine.get(l.id) ?? 0);
    const cur = r2(thisByLine.get(l.id) ?? 0);
    const sched = Number(l.scheduled_value ?? 0);
    const completed = r2(prev + cur);
    return {
      pay_application_id: A._appId, billing_line_id: l.id,
      item_number: l.item_number, description: l.description, scheduled_value: sched,
      work_completed_previous: prev, work_completed_this_period: cur, materials_stored: 0,
      total_completed_and_stored: completed,
      pct_complete: sched > 0 ? r2(Math.min(100, (completed / sched) * 100)) : 0,
      balance_to_finish: r2(sched - completed),
      retainage_amount: retByItem.get(l.item_number) ?? 0,
      sort_order: l.sort_order ?? i,
    };
  });
  const prevTotal = r2(inserts.reduce((s, l) => s + l.work_completed_previous, 0));
  const curTotal = r2(inserts.reduce((s, l) => s + l.work_completed_this_period, 0));
  note(`   ${A.app_number}: previous ${prevTotal.toLocaleString()} (doc ${A.doc.previous_billings.toLocaleString()})  this period ${curTotal.toLocaleString()} (doc ${A.doc.total_completed.toLocaleString()})`);
  if (prevTotal !== A.doc.previous_billings) note(`   !! previous billings off by ${r2(prevTotal - A.doc.previous_billings)}`);
  if (curTotal !== A.doc.total_completed) note(`   !! this period off by ${r2(curTotal - A.doc.total_completed)}`);

  await run(`pay_application_lines ${A.app_number} (replace ${inserts.length})`, async () => {
    const del = await sb.from("pay_application_lines").delete().eq("pay_application_id", A._appId);
    if (del.error) return del;
    return sb.from("pay_application_lines").insert(inserts);
  });
  await run(`pay_applications ${A.app_number} rollup + status ${A.status}`, () =>
    sb.from("pay_applications").update({ ...A.doc, status: A.status, notes: A.notes }).eq("id", A._appId));
}

note(APPLY ? "\nAPPLIED." : "\nDRY RUN - re-run with --apply to write.");
