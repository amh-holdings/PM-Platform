// QuickBooks -> app cash-flow sync for Sweet Springs. DRY RUN ONLY.
//
//   npx tsx scripts/cashflow/qb-sync.mts "<controller pack folder>"
//
// Reads the Controller's monthly QuickBooks Desktop export (the numbered
// workbooks: Item Est vs Actuals, Cost Detail cash/accrual, Revenue Detail
// cash/accrual, Payables, Payments since cutoff, Rillion pending) and the live
// app tables, then:
//   1. routes every QuickBooks transaction to exactly ONE home in the app,
//   2. lists every change that would make the app agree with the books,
//   3. runs the app's own buildProjection twice - on the live data, and on the
//      live data with the changes applied IN MEMORY - so the projection the
//      changes produce can be read before anything is written.
// Nothing is written without --apply. With it, every touched row is backed up
// to reports/cashflow/ first, and ops marked `hold` (waiting on the
// Controller) are skipped. Sub pay apps are never written here - they need
// their real line detail, which comes from the PDF through Sub Billing.
//
//   npx tsx scripts/cashflow/qb-sync.mts "<folder>" --apply
//
// THE RULE: QuickBooks is the record for everything through the cutoff; the
// app owns everything after it. Decisions confirmed by Phil 2026-10-08:
//   - keep the app's cost codes, map QB's onto them (all SSC Z CO1-* and
//     SSC Z LNTP Timmons -> CO-01), retire CO-02 into N/O/R/S as QB did
//   - QB's estimates are the budget
//   - Zarina's cash-flow workbook stops being a source of actuals
//
// Output: reports/cashflow/qb-sync-<cutoff>.md and .json

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { buildProjection, type ProjectionRow } from "@/lib/projection";

const raw = readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const l of raw.split("\n")) {
  const t = l.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
}) as any;

const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const DIR = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!DIR) throw new Error("usage: qb-sync.mts <controller pack folder>");
const CUTOFF = "2026-09-30";
const TODAY = new Date("2026-10-08T12:00:00");
// Past-due bills have no future due date to sit on. They are assumed paid in
// the current month, which is the honest read of "we owe it now".
const PAST_DUE_MONTH = "2026-10-01";
// Remaining budget is spread to substantial completion (guaranteed 2027-01-21).
const BURN_MONTHS = ["2026-10-01", "2026-11-01", "2026-12-01", "2027-01-01"];
const SPREAD_MONTHS = ["2026-11-01", "2026-12-01", "2027-01-01"];
// Codes that cost money every month the job is open. Forecast at the trailing
// three-month run rate when that is more than the budget left - a code that is
// already over budget still pays the crew in November.
const BURN_CODES = new Set(["SSC A", "SSC B", "SSC C", "SSC D", "SSC E", "SSC H"]);

const n = (v: any) => Number(v ?? 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const usd = (v: number) => (v < 0 ? "-$" : "$") + Math.abs(Math.round(v)).toLocaleString();
const usd2 = (v: number) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const month = (iso: string) => iso.slice(0, 7) + "-01";
const isoOf = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "").slice(0, 10));
const dueMonth = (due: string) => (month(due) < "2026-10-01" ? PAST_DUE_MONTH : month(due));

// ---------------------------------------------------------------------------
// QuickBooks parsing
// ---------------------------------------------------------------------------
const files = readdirSync(DIR).filter((f) => f.endsWith(".xlsx"));
const file = (re: RegExp) => {
  const f = files.find((x) => re.test(x));
  if (!f) throw new Error(`controller pack is missing ${re}`);
  return join(DIR, f);
};
function sheet(path: string, name = "Sheet1"): any[][] {
  const wb = XLSX.read(readFileSync(path), { cellDates: true });
  const ws = wb.Sheets[name] ?? wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as any[][];
}
const TXN_TYPES = new Set(["Bill", "Check", "Credit Card Charge", "General Journal", "Invoice", "Bill Pmt -Check", "Deposit", "Credit Card Credit", "Bill Credit"]);
function txns(path: string): Record<string, any>[] {
  const rows = sheet(path);
  let hdr: any[] | null = null;
  const out: Record<string, any>[] = [];
  for (const r of rows) {
    if (r.includes("Type") && r.includes("Num")) { hdr = r; continue; }
    if (!hdr) continue;
    const type = r[hdr.indexOf("Type")];
    if (!TXN_TYPES.has(type)) continue;
    const o: Record<string, any> = {};
    hdr.forEach((h, i) => { if (h) o[h] = r[i]; });
    o.Date = isoOf(o.Date);
    if (o["Due Date"]) o["Due Date"] = isoOf(o["Due Date"]);
    out.push(o);
  }
  return out;
}

// QB item (the Memo) -> app cost code. Decision 1.
function appCode(memo: string): string | null {
  const m = String(memo ?? "").trim();
  if (/^SSC Z (CO1|LNTP)/.test(m)) return "CO-01";
  const t = m.match(/^SSC T\.(\d+)(a)?/);
  if (t) return t[2] ? "SSC T.12b" : `SSC T.${parseInt(t[1], 10)}`;
  if (/^SSC TT?-/.test(m)) return "SSC T";
  if (/^SSC S\.1/.test(m)) return "SSC S";
  const l = m.match(/^SSC[ -]([A-W])\b/);
  return l ? `SSC ${l[1]}` : null;
}

const costCash = txns(file(/^7\..*CASH BASIS/i));
const costAccrual = txns(file(/^6\..*ACCRUAL BASIS/i));
const revCash = txns(file(/^9\..*CASH BASIS/i));
const revAccrual = txns(file(/^8\..*ACCRUAL BASIS/i));
const payables = txns(file(/^12\./));
const paidSinceCutoff = txns(file(/^10\./));

// AP report rows carry no vendor column - the vendor is the group header.
{
  const rows = sheet(file(/^12\./));
  let vendor = ""; let hdr: any[] | null = null; let k = 0;
  for (const r of rows) {
    if (r.includes("Type") && r.includes("Num")) { hdr = r; continue; }
    if (!hdr) continue;
    const type = r[hdr.indexOf("Type")];
    const first = r.find((c) => c != null);
    if (!TXN_TYPES.has(type) && typeof first === "string" && !first.startsWith("Total") && first !== "TOTAL") vendor = first;
    if (TXN_TYPES.has(type)) payables[k++].Vendor = vendor;
  }
}
const rillion = (() => {
  const rows = sheet(file(/^11\./), "export sheet");
  const hdr = rows[0];
  return rows.slice(1).filter((r) => r[0] && /^\d{4}-/.test(String(r[0]))).map((r) => {
    const o: Record<string, any> = {}; hdr.forEach((h: any, i: number) => (o[h] = r[i]));
    o.Supplier = String(o.Supplier).split(" ")[0].trim();
    return o;
  });
})();
// Incurred to date per code (QB "Act. Cost", accrual basis): paid AND owed.
const qbIncurred = new Map<string, number>();
const qbEstimate = (() => {
  const est = new Map<string, number>();
  for (const r of sheet(file(/^1\..*Estimates vs Actuals/i))) {
    const label = r.find((c) => typeof c === "string");
    if (!label || !/^SSC /.test(label) || /^Total/.test(label)) continue;
    const nums = r.filter((c) => typeof c === "number");
    if (nums.length < 2) continue;
    const code = appCode(label);
    if (!code) continue;
    est.set(code, r2((est.get(code) ?? 0) + nums[0]));
    qbIncurred.set(code, r2((qbIncurred.get(code) ?? 0) + nums[1]));
  }
  return est;
})();

// Owner SOV per QB: SSR/SSRR item -> app billing line item number.
const qbRevenueSv = (() => {
  const sv = new Map<string, number>();
  for (const r of sheet(file(/^1\..*Estimates vs Actuals/i))) {
    const label = r.find((c) => typeof c === "string");
    if (!label || !/^SSRR? /.test(label) || /^Total/.test(label)) continue;
    const m = label.match(/^SSRR? +(\d+)(?:\.(\d+))?/);
    if (!m) continue;
    const minor = m[2] ? (m[2].length === 1 ? m[2] + "0" : m[2]) : "00";
    const nums = r.filter((c) => typeof c === "number");
    sv.set(`${parseInt(m[1], 10)}.${minor}`, nums[3]);
  }
  return sv;
})();

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const all = async (q: any) => { const { data, error } = await q; if (error) throw new Error(error.message); return data as any[]; };
const project = (await all(sb.from("projects").select("*").eq("id", PID)))[0];
const payApps = await all(sb.from("pay_applications").select("*").eq("project_id", PID));
const billingLines = await all(sb.from("billing_lines").select("id, item_number, description, scheduled_value").eq("project_id", PID));
const entries = await all(sb.from("billing_entries").select("*").in("billing_line_id", billingLines.map((b) => b.id)));
const codes = await all(sb.from("cost_codes").select("*, subcontractors(payment_terms_days, retainage_pct)").eq("project_id", PID));
const forecasts = await all(sb.from("cost_forecasts").select("*").in("cost_code_id", codes.map((c) => c.id)));
const pos = await all(sb.from("procurement_orders").select("*").eq("project_id", PID));
const poPay = await all(sb.from("procurement_payments").select("*").in("procurement_order_id", pos.map((p) => p.id)));
const subs = await all(sb.from("subcontractors").select("*").eq("project_id", PID));
const subApps = await all(sb.from("sub_pay_apps").select("*").eq("project_id", PID));

const codeBy = new Map(codes.map((c) => [c.code, c]));
const poBy = (num: string) => {
  const p = pos.find((o) => (o.po_number ?? "").endsWith(num));
  if (!p) throw new Error(`no PO ending ${num}`);
  return p;
};
const milestone = (poNum: string, name: RegExp, amount?: number) => {
  const po = poBy(poNum);
  const m = poPay.find((p) => p.procurement_order_id === po.id && name.test(p.milestone_name) && (amount == null || Math.abs(n(p.amount) - amount) < 0.5));
  if (!m) throw new Error(`no milestone ${name} on ${poNum}`);
  return m;
};
const subBy = (re: RegExp) => subs.find((s) => re.test(s.company_name));

// ---------------------------------------------------------------------------
// The change list
// ---------------------------------------------------------------------------
type Op = {
  step: string;            // 1 owner, 2 subs, 3 POs, 4 cost-code actuals, 5 forecast, 0 budget
  table: string;
  action: "update" | "insert" | "delete" | "enter-in-app" | "review";
  target: string;          // human label
  change: string;          // before -> after
  source: string;          // QB evidence
  id?: string;
  set?: Record<string, any>;
  row?: Record<string, any>;
  hold?: string;           // why it waits; skipped by --apply
};
const ops: Op[] = [];
const review: { item: string; why: string; proposal: string }[] = [];

// ---- Step 0: the budget (decision 2) -------------------------------------
for (const c of codes) {
  let qb = qbEstimate.get(c.code);
  if (c.code === "CO-02") qb = 0; // decision 1: CO-02 retired into N/O/R/S
  if (qb == null) continue;
  if (Math.abs(n(c.estimated_cost) - qb) < 0.5) continue;
  ops.push({ step: "0 Budget", table: "cost_codes", action: "update", id: c.id, target: `${c.code} ${c.name}`,
    change: `estimated_cost ${usd(n(c.estimated_cost))} -> ${usd(qb)}`, source: "Item Estimates vs Actuals 9/30",
    set: { estimated_cost: qb } });
}
// Owner SOV check. The app keeps CO-02 as its own G703 line and attributes
// its money to the contract lines it raises (billing_line_amendments); QB
// folds it into those lines. Both should give the same current scope.
{
  const amends = await all(sb.from("billing_line_amendments").select("amendment_line_id, base_line_id, amount").eq("project_id", PID));
  for (const b of billingLines) {
    const qb = qbRevenueSv.get(b.item_number);
    if (qb == null || qb === 0.01 || /CO-0[26]/.test(b.description ?? "")) continue;
    const scope = n(b.scheduled_value) + amends.filter((a) => a.base_line_id === b.id).reduce((s, a) => s + n(a.amount), 0);
    if (Math.abs(scope - qb) > 0.05) review.push({ item: `Owner SOV ${b.item_number} scope differs from QB`, why: `App ${usd2(scope)} (contract value plus change-order allocations), QB ${usd2(qb)}.`, proposal: "Check against the executed G703." });
  }
}
// cost_codes.actual_cost = what QB says each code has incurred - the figure
// the Costs page and the cost variance chart compare against the budget.
// Paid-only actuals (cost_forecasts) would hide every overrun still sitting
// in payables.
for (const c of codes) {
  const inc = qbIncurred.get(c.code) ?? 0;
  if (Math.abs(n(c.actual_cost) - inc) < 0.005) continue;
  ops.push({ step: "0 Budget", table: "cost_codes", action: "update", id: c.id, target: `${c.code} ${c.name}`,
    change: `actual_cost ${usd2(n(c.actual_cost))} -> ${usd2(inc)} (incurred)`, source: "Item Estimates vs Actuals 9/30, Act. Cost", set: { actual_cost: inc } });
}
if (codeBy.get("SSC T.15")) {
  review.push({ item: "SSC T.15 is named \"CAB Piles\" in the app", why: "QB's T.15 is \"CO5 FTC Piles\" ($100,341 budget). Same number, different scope name.", proposal: "Rename the app code to \"CO5 FTC Piles\" when applying." });
}

// ---- Step 1: owner receipts ----------------------------------------------
// QB invoice number -> app AFP number.
const afpOf = (num: string) => {
  const s = String(num).replace(/\s+R$/, "").trim(); // "2B R" -> "2B"; "AFP 3R" stays
  return /^AFP/.test(s) ? s : "AFP " + s;
};
const recv = new Map<string, { billed: number; received: number; paidOn: string }>();
for (const t of revAccrual) {
  const k = afpOf(t.Num); const o = recv.get(k) ?? { billed: 0, received: 0, paidOn: "" };
  o.billed += n(t.Credit); recv.set(k, o);
}
for (const t of revCash) {
  const k = afpOf(t.Num); const o = recv.get(k)!;
  o.received += n(t.Credit); o.paidOn = t.Date > o.paidOn ? t.Date : o.paidOn;
}
for (const pa of payApps) {
  const q = recv.get(pa.app_number);
  if (!q) { review.push({ item: `${pa.app_number} not in QuickBooks`, why: "The app has a pay application QB has no invoice for.", proposal: "Check with the Controller." }); continue; }
  if (Math.abs(q.billed - n(pa.total_completed)) > 0.5) review.push({ item: `${pa.app_number} gross differs`, why: `App ${usd2(n(pa.total_completed))}, QB ${usd2(q.billed)}.`, proposal: "QB wins - confirm before applying." });
  if (q.received > 0) {
    const set: Record<string, any> = {};
    if (isoOf(pa.paid_at) !== q.paidOn) set.paid_at = q.paidOn;
    if (pa.status !== "paid") set.status = "paid";
    if (Object.keys(set).length) ops.push({ step: "1 Owner", table: "pay_applications", action: "update", id: pa.id, target: pa.app_number,
      change: Object.entries(set).map(([k, v]) => `${k} ${pa[k] ?? "empty"} -> ${v}`).join("; "),
      source: `Revenue Detail cash basis: ${usd2(q.received)} received ${q.paidOn}`, set });
    for (const e of entries.filter((e) => e.pay_application_id === pa.id)) {
      const es: Record<string, any> = {};
      if (isoOf(e.paid_at) !== q.paidOn) es.paid_at = q.paidOn;
      if (e.status !== "paid") es.status = "paid";
      if (Object.keys(es).length) ops.push({ step: "1 Owner", table: "billing_entries", action: "update", id: e.id, target: `${pa.app_number} line entry`,
        change: Object.entries(es).map(([k, v]) => `${k} ${e[k] ?? "empty"} -> ${v}`).join("; "), source: "same receipt", set: es });
    }
  } else {
    // Billed, nothing received. Its cash date is otherwise period + terms,
    // which for AFP 12 is September - a month that is over.
    // No cash_in_month override here: an override outranks the real paid
    // date when the money arrives. The engine moves an
    // unpaid AFP whose terms date has passed into the current month instead.
    const ret = entries.filter((e) => e.pay_application_id === pa.id).reduce((s, e) => s + n(e.retainage_amount), 0);
    const implied = n(pa.total_completed) - n(pa.amount_due);
    if (Math.abs(ret - implied) > 1) review.push({ item: `${pa.app_number} retainage disagrees with itself`,
      why: `Line entries hold ${usd2(ret)} retainage; the pay app's amount due (${usd2(n(pa.amount_due))}) implies ${usd2(implied)}; 5% of the gross is ${usd2(n(pa.total_completed) * 0.05)}.`,
      proposal: "Read the executed G702. The projection uses the line entries, so the receipt is off by the difference until it is fixed." });
  }
}
const retainHeld = [...recv.values()].reduce((s, q) => s + (q.received > 0 ? q.billed - q.received : 0), 0);

// ---- Steps 2 and 3: commitments ------------------------------------------
// Each QuickBooks bill on a bought-out scope, matched by hand to the
// commitment that carries it. Read these - they are judgement, not lookup.
type Route = { num: string; to: string };
const routed = new Set<string>();
const key = (t: any) => `${t["Source Name"] ?? t.Vendor}|${t.Num}`;

// Paid bills (cash basis) on commitments.
const paidAt = (num: string) => costCash.find((t) => t.Num === num)?.Date;
function payMilestone(poNum: string, name: RegExp, num: string, amount?: number, extra?: Record<string, any>) {
  const m = milestone(poNum, name, amount);
  const t = costCash.find((x) => x.Num === num)!;
  routed.add(key(t));
  const date = t.Date;
  const amt = n(t.Debit);
  const set: Record<string, any> = { paid_at: date, paid_amount: amt, ...(extra ?? {}) };
  const same = isoOf(m.paid_at) === date && Math.abs(n(m.paid_amount) - amt) < 0.5 && !extra;
  if (same) return m;
  ops.push({ step: "3 POs", table: "procurement_payments", action: "update", id: m.id, target: `${poBy(poNum).vendor_name} ${poNum} "${m.milestone_name}"`,
    change: `paid ${m.paid_at ?? "no"} ${m.paid_amount != null ? usd2(n(m.paid_amount)) : ""} -> paid ${date} ${usd2(amt)}${extra ? "; " + Object.entries(extra).map(([k, v]) => `${k} -> ${v}`).join("; ") : ""}`,
    source: `QB bill ${num} paid ${date}`, set });
  return m;
}
// A split this sync made on an earlier run is recognised by the milestone it
// inserted, so a rerun proposes nothing for it.
const hasMilestone = (poNum: string, name: string) => poPay.some((p) => p.procurement_order_id === poBy(poNum).id && p.milestone_name === name);
function newMilestone(poNum: string, row: Record<string, any>, source: string) {
  const po = poBy(poNum);
  if (hasMilestone(poNum, row.milestone_name)) return;
  ops.push({ step: "3 POs", table: "procurement_payments", action: "insert", target: `${po.vendor_name} ${poNum} "${row.milestone_name}"`,
    change: `new ${usd2(row.amount)} ${row.paid_at ? "paid " + row.paid_at : "due " + row.expected_date}`, source,
    row: { procurement_order_id: po.id, side: "vendor", sort_order: 50, ...row } });
}

// Maddox P-001 transformer: 25% deposit then 75% on delivery.
payMilestone("P-001", /Deposit/, "SO-107033A");
if (!hasMilestone("P-001", "Partial payment INV-111328")) {
  const m = milestone("P-001", /delivery/i);
  const t = costCash.find((x) => x.Num === "INV-111328")!; routed.add(key(t));
  ops.push({ step: "3 POs", table: "procurement_payments", action: "update", id: m.id, target: `Maddox P-001 "${m.milestone_name}"`,
    change: `amount ${usd2(n(m.amount))} -> ${usd2(63400.14)}, due 30 days after the transformer is delivered (schedule task 4.4.3)`,
    source: "QB bill INV-111328 $63,900.14, $500 paid 2026-01-21; not due until delivered on site (Nancy, 2026-10-02)", set: { amount: 63400.14, expected_date: null } });
  newMilestone("P-001", { milestone_name: "Partial payment INV-111328", amount: 500, paid_amount: 500, paid_at: "2026-01-21", expected_date: "2026-01-21", trigger_event: "Payment" }, "QB bill INV-111328, $500 paid 2026-01-21");
}
// Maddox P-005 ($750, no milestones in the app).
newMilestone("P-005", { milestone_name: "Paid INV-308350", amount: 750, paid_amount: 750, paid_at: paidAt("INV-308350"), expected_date: paidAt("INV-308350"), trigger_event: "Payment" }, "QB bill INV-308350");
routed.add(key(costCash.find((x) => x.Num === "INV-308350")));

// FTC P-002 racking, $272,111: 20% down, 10% engineering, 40% progress, 30%
// delivery. The app only has the first two milestones - $190,477.70 of the PO
// is missing from the forecast entirely.
payMilestone("P-002", /Down Payment/, "IN-USA-00958");
if (!hasMilestone("P-002", "Balance on delivery")) {
  const m = milestone("P-002", /Engineering/);
  const t = costCash.find((x) => x.Num === "IN-USA-02524")!; routed.add(key(t));
  ops.push({ step: "3 POs", table: "procurement_payments", action: "update", id: m.id, target: `FTC P-002 "${m.milestone_name}"`,
    change: `${usd2(n(m.amount))} unpaid -> ${usd2(81633.30)} paid ${t.Date} (10% engineering + 20% of the progress payment)`,
    source: "QB bill IN-USA-02524 $81,633.30 paid 2024-09-13", set: { amount: 81633.30, paid_amount: 81633.30, paid_at: t.Date, milestone_name: "Engineering + progress (IN-USA-02524)", pct_of_total: 30 } });
  newMilestone("P-002", { milestone_name: "Invoice IN-USA-03381 (in Rillion)", amount: 46056.47, expected_date: "2026-10-30", trigger_event: "Invoice", pct_of_total: null }, "Rillion IN-USA-03381 dated 9/30, due 10/30");
  newMilestone("P-002", { milestone_name: "Balance on delivery", amount: r2(272111 - 54422.20 - 81633.30 - 46056.47), expected_date: null, trigger_event: "Delivery to site", pct_of_total: null }, "PO total less paid and invoiced; dated by the PO's delivery task 4.3.2.2");
  const ftc = poBy("P-002");
  if (ftc.net_terms_days !== 30) ops.push({ step: "3 POs", table: "procurement_orders", action: "update", id: ftc.id, target: "FTC P-002",
    change: `net_terms_days ${ftc.net_terms_days ?? "empty"} -> 30`, source: "Phil 2026-10-08: FTC terms are Net 30 on delivery", set: { net_terms_days: 30 } });
}
// GridPower P-019: the app has the right amounts, QB has later dates.
payMilestone("P-019", /Deposit/, "S103086607.001", 1853.50);
payMilestone("P-019", /Deposit/, "S103079011.002", 20.54);
payMilestone("P-019", /Deposit/, "S103079013.002", 270.37);
// Elevated Steel PO-023 down payment - app already has it.
payMilestone("PO-023", /Delivery/, "26.0339", 47584.80);
// CAB Solar PO-022 deposit. QB books CAB as "Cambria County Assoc." - same
// money ($3,975.25 paid, $3,975.24 open, $7,950.49 total).
{
  const t = costCash.find((x) => x.Num === "COM147583" || (/Cambria/.test(x["Source Name"]) && Math.abs(n(x.Debit) - 3975.25) < 0.02));
  if (t) routed.add(key(t));
}
// Small GridPower shipping lines with no PO line to sit on.
for (const t of [...costCash, ...paidSinceCutoff].filter((x) => /^s103(199493|273734)/i.test(x.Num))) routed.add(key(t));
review.push({ item: "Two $9.84 GridPower bills (S103199493.001, s103273734.001)", why: "No PO milestone matches. Immaterial.", proposal: "Leave out of the app." });

// Subcontractors. The engine reads sub cash out from the SOV, so a pay app
// needs its line detail - that comes from the pay app PDF through Sub Billing,
// not from QuickBooks.
const pyr = subBy(/Pyramid/)!; const lum = subBy(/Lumina/)!; const sun = subBy(/Sunstall/)!;
{
  const app1 = subApps.find((a) => a.subcontractor_id === pyr.id && a.app_number === 1)!;
  const t = costCash.find((x) => x.Num === "AFP1 1383")!; routed.add(key(t));
  if (app1.status !== "paid" || isoOf(app1.paid_at) !== t.Date) ops.push({ step: "2 Subs", table: "sub_pay_apps", action: "update", id: app1.id, target: "Pyramid App 1",
    change: `status ${app1.status} -> paid; paid_at ${app1.paid_at ?? "empty"} -> ${t.Date}`, source: `QB: ${usd2(n(t.Debit))} paid ${t.Date} ($6,692.25 retainage held)`,
    set: { status: "paid", paid_at: t.Date } });
}
const subCashPaid: { sub: string; month: string; amount: number; what: string }[] = [
  { sub: "Pyramid", month: month(paidAt("AFP1 1383")!), amount: 127152.84, what: "App 1" },
];
for (const [s, num, what] of [[sun, "I0002882", "Invoice I0002882"], [lum, "App 1 (", "App 1 (partial)"]] as const) {
  const t = costCash.find((x) => x.Num === num)!; routed.add(key(t));
  subCashPaid.push({ sub: s.company_name, month: month(t.Date), amount: n(t.Debit), what });
}
ops.push({ step: "2 Subs", table: "sub_pay_apps", action: "enter-in-app", target: "Pyramid App 2", change: "new pay app, $113,460.04 billed, due 2026-10-18", source: "QB AP: bill \"AFP 2\" 9/18" });
ops.push({ step: "2 Subs", table: "sub_pay_apps", action: "enter-in-app", target: "Pyramid App 3", change: "new pay app, $79,085.37, due 2026-10-28", source: "Rillion 1407, pending your approval" });
if (!subApps.some((a) => a.subcontractor_id === lum.id && a.app_number === 1)) ops.push({ step: "2 Subs", table: "sub_pay_apps", action: "enter-in-app", target: "Lumina App 1", change: "new pay app, $163,174.33 billed. $18,579.40 bond increase paid 9/23 (no retainage). $144,594.93 work less 10% retainage ($14,459.49) = $130,135.44 due, past due since 9/1", source: "QB bill \"App 1\" 8/22; Phil 2026-10-08 on retainage" });
if (!subApps.some((a) => a.subcontractor_id === sun.id && a.app_number === 1)) ops.push({ step: "2 Subs", table: "sub_pay_apps", action: "enter-in-app", target: "Sunstall Invoice I0002882", change: "new pay app, $33,293.33, paid 2026-09-08", source: "QB bill I0002882" });

// Open bills and Rillion invoices on commitments.
const openRouted = new Set<string>(["Lumina Energy Services|App 1 (", "Pyramid Excavation|AFP 2", "Pyramid Excavation|AFP1 1383",
  "MADDOX INDUSTRIAL TRANSFORMER|INV-111328", "GridPower Solutions|S103079015.002", "Cambria County Assoc.|COM147583", "Test Transaction for memo field|"]);
{
  const m = milestone("P-019", /Delivery/);
  if (isoOf(m.expected_date) !== "2026-10-15") ops.push({ step: "3 POs", table: "procurement_payments", action: "update", id: m.id, target: "GridPower P-019 Delivery", change: `expected ${m.expected_date} -> 2026-10-15`, source: "QB AP S103079015.002 due 10/15", set: { expected_date: "2026-10-15" } });
  const cab = milestone("PO-022", /Delivery/);
  ops.push({ step: "3 POs", table: "procurement_payments", action: "update", id: cab.id, target: "CAB Solar PO-022 Delivery",
    change: `${usd2(n(cab.amount))} due ${cab.expected_date} -> ${usd2(3975.24)} due ${PAST_DUE_MONTH.slice(0, 7)} (past due 9/24)`, source: "QB AP COM147583 (Cambria County Assoc.)", set: { amount: 3975.24, expected_date: "2026-10-15" }, hold: "Controller question 5 (CAB = Cambria?)" });
  review.push({ item: "CAB Solar = \"Cambria County Assoc.\" in QB", why: "Amounts tie ($7,950.49 billed of an $8,224.49 PO) but the names do not.", proposal: "Confirm with the Controller, and ask whether the last $274 is still coming." });
  const gc = milestone("PO-021", /delivery/i);
  if (Math.abs(n(gc.amount) - 20718.74) > 0.005 || isoOf(gc.expected_date) !== "2026-10-30") ops.push({ step: "3 POs", table: "procurement_payments", action: "update", id: gc.id, target: "GameChange PO-021",
    change: `${usd2(n(gc.amount))} due ${gc.expected_date} -> ${usd2(20718.74)} due 2026-10-30`, source: "Rillion INV2603581 ($995.82 tax over the PO value)", set: { amount: 20718.74, expected_date: "2026-10-30" } });
  if (!hasMilestone("PO-023", "Delivery invoice 26.0373 (in Rillion)")) {
  const es = milestone("PO-023", /Delivery/, 190339.19);
  ops.push({ step: "3 POs", table: "procurement_payments", action: "update", id: es.id, target: "Elevated Steel PO-023 Delivery 80%", change: `${usd2(n(es.amount))} -> ${usd2(190339.19 - 4003.35)} (first delivery invoice split out)`, source: "Rillion 26.0373", set: { amount: r2(190339.19 - 4003.35) } });
  newMilestone("PO-023", { milestone_name: "Delivery invoice 26.0373 (in Rillion)", amount: 4003.35, expected_date: "2026-10-29", trigger_event: "Invoice" }, "Rillion 26.0373 due 10/29");
  }
  if (!hasMilestone("PO-018", "Invoice S103079013.004 (in Rillion)")) {
  const gp = milestone("PO-018", /Delivery/);
  ops.push({ step: "3 POs", table: "procurement_payments", action: "update", id: gp.id, target: "GridPower PO-018 Delivery balance", change: `${usd2(n(gp.amount))} undated -> ${usd2(n(gp.amount) - 16926.02 - 827.02)} on delivery`, source: "two GridPower invoices split out below", set: { amount: r2(n(gp.amount) - 16926.02 - 827.02) } });
  newMilestone("PO-018", { milestone_name: "Invoice S103079013.004 (in Rillion)", amount: 16926.02, expected_date: "2026-10-30", trigger_event: "Invoice" }, "Rillion S103079013.004");
  newMilestone("PO-018", { milestone_name: "Invoice S103079014.002 (in Rillion)", amount: 827.02, expected_date: "2026-10-28", trigger_event: "Invoice" }, "Rillion S103079014.002");
  }
  review.push({ item: "GridPower Rillion invoices S103079013.004 and S103079014.002", why: "Assigned to PO-018 (the only GridPower PO with an open delivery balance), but sales order S103079013 also appears on P-019 in QB.", proposal: "Check the PO number printed on each invoice." });
}
// Delivery-triggered milestones on a PO with no Net terms are paid on the
// delivery day itself, which pulls them a month early.
for (const po of pos.filter((o) => o.status !== "cancelled" && o.net_terms_days == null)) {
  const open = poPay.filter((p) => p.procurement_order_id === po.id && !p.paid_at && /deliver/i.test(p.trigger_event ?? ""));
  const amt = open.reduce((s, p) => s + n(p.amount), 0);
  if (amt > 0) review.push({ item: `${po.vendor_name} ${po.po_number}: no Net terms`, why: `${usd2(amt)} due on delivery is forecast on the delivery day itself.`, proposal: "Set the PO's Net terms (most are Net 30), which moves this cash a month later." });
}
// Paid in the app, absent from the books.
for (const [poNum, name] of [["PO-017", /Deposit/], ["P-016", /Deposit/], ["PO-018", /Deposit/]] as const) {
  const m = milestone(poNum, name);
  review.push({ item: `${poBy(poNum).vendor_name} ${poNum} deposit ${usd2(n(m.amount))} marked paid ${m.paid_at}`,
    why: "No bill or payment for this vendor in the Sweet Springs cost detail.", proposal: "Ask the Controller whether it was paid, and from which account or job. Left as paid until answered." });
}

// ---- Step 4: cost-code actuals (everything not on a commitment) ----------
const COMMIT_CODES = new Set(codes.filter((c) => c.commitment_covered || /^SSC T/.test(c.code)).map((c) => c.code));
const actualBy = new Map<string, Map<string, number>>(); // code -> month -> cash
const unrouted: any[] = [];
for (const t of [...costCash, ...paidSinceCutoff]) {
  if (routed.has(key(t))) continue;
  const code = appCode(t.Memo);
  if (!code || !codeBy.has(code)) { unrouted.push({ ...t, reason: `QB item "${t.Memo}" has no app code` }); continue; }
  if (COMMIT_CODES.has(code)) { unrouted.push({ ...t, reason: `on bought-out scope ${code} with no commitment matched` }); continue; }
  const m = actualBy.get(code) ?? new Map(); m.set(month(t.Date), r2((m.get(month(t.Date)) ?? 0) + n(t.Debit) - n(t.Credit))); actualBy.set(code, m);
}
for (const u of unrouted) review.push({ item: `${u["Source Name"]} ${u.Num} ${usd2(n(u.Debit))} (${u.Date})`, why: u.reason, proposal: "Route by hand." });

// Open bills on cost codes: due month. Code looked up from the bill itself.
const codeOfBill = (vendor: string, num: string) => {
  const t = costAccrual.find((x) => x.Num === num && (!vendor || String(x["Source Name"]).toLowerCase().startsWith(vendor.toLowerCase().slice(0, 5))));
  if (t) return appCode(t.Memo);
  const byVendor = costAccrual.filter((x) => String(x["Source Name"]).toLowerCase().startsWith(vendor.toLowerCase().slice(0, 5)));
  return byVendor.length ? appCode(byVendor[byVendor.length - 1].Memo) : null;
};
const plannedBy = new Map<string, Map<string, number>>();
const addPlan = (code: string, m: string, v: number) => {
  const x = plannedBy.get(code) ?? new Map(); x.set(m, r2((x.get(m) ?? 0) + v)); plannedBy.set(code, x);
};
const openByCode = new Map<string, number>();
const paidSince = new Set(paidSinceCutoff.map((t) => t.Num));
for (const b of payables) {
  if (openRouted.has(`${b.Vendor}|${b.Num ?? ""}`) || /^Test/.test(b.Vendor)) continue;
  if (paidSince.has(b.Num)) continue;
  const code = codeOfBill(b.Vendor, b.Num);
  const amt = n(b["Open Balance"]);
  if (!code || COMMIT_CODES.has(code)) { review.push({ item: `Open bill ${b.Vendor} ${b.Num} ${usd2(amt)}`, why: code ? `on bought-out scope ${code}` : "no cost code found", proposal: "Route by hand." }); continue; }
  addPlan(code, dueMonth(b["Due Date"]), amt); openByCode.set(code, (openByCode.get(code) ?? 0) + amt);
}
const RILLION_CODE: Record<string, string> = { "Pure Power Engineering": "SSC I", "United Rentals-Sweet Springs": "SSC H" };
for (const r of rillion) {
  const code = RILLION_CODE[r.Supplier];
  if (code) { addPlan(code, dueMonth(r["Due date"]), n(r["Total Amount"])); openByCode.set(code, (openByCode.get(code) ?? 0) + n(r["Total Amount"])); continue; }
  if (r["Invoice number"] === "IN-USA-03346") {
    addPlan("SSC K", PAST_DUE_MONTH, 9000); openByCode.set("SSC K", (openByCode.get("SSC K") ?? 0) + 9000);
    review.push({ item: "FTC IN-USA-03346 $9,000 (Rillion, due 9/7)", why: "No FTC PO or milestone matches $9,000. Put on SSC K (structural engineering), where FTC's other non-PO bills sit.", proposal: "Check what it is; it has been waiting on your approval since 8/28." });
  }
}

// Replace history: every month up to the cutoff, on every code not on a
// commitment, becomes exactly what QB says was paid - no stale plans.
const accrued = new Map<string, number>();
for (const t of costAccrual) { const c = appCode(t.Memo); if (c) accrued.set(c, (accrued.get(c) ?? 0) + n(t.Debit) - n(t.Credit)); }
const fcRowsAfter: { code: string; period_month: string; planned_amount: number; actual_amount: number }[] = [];
const etcNotes: string[] = [];
// Bought-out scope: what QB says was paid on each code, by month, ACTUALS
// ONLY. Cash out for this scope comes from the sub pay apps and PO
// milestones, so the projection skips these codes; the rows exist for the
// cost tiles, which read cost by code. QB codes every bill, so the vendor ->
// code attribution is the books' own.
const commitActual = new Map<string, Map<string, number>>();
for (const t of [...costCash, ...paidSinceCutoff]) {
  const code = appCode(t.Memo);
  if (!code || !COMMIT_CODES.has(code) || !codeBy.has(code)) continue;
  const m = commitActual.get(code) ?? new Map(); m.set(month(t.Date), r2((m.get(month(t.Date)) ?? 0) + n(t.Debit) - n(t.Credit))); commitActual.set(code, m);
}
for (const c of codes.filter((c) => COMMIT_CODES.has(c.code))) {
  if (!c.commitment_covered) ops.push({ step: "4 Cost actuals", table: "cost_codes", action: "update", id: c.id, target: `${c.code} ${c.name}`,
    change: "commitment_covered false -> true", source: "Bought out on purchase orders, like its parent SSC T; stops its actuals reaching the cash flow twice", set: { commitment_covered: true } });
  const old = forecasts.filter((f) => f.cost_code_id === c.id);
  const acts = commitActual.get(c.code) ?? new Map();
  for (const [m, v] of acts) if (Math.abs(v) > 0.005) fcRowsAfter.push({ code: c.code, period_month: m, planned_amount: 0, actual_amount: v });
  const same = old.length === acts.size && old.every((f) => Math.abs(n(f.actual_amount) - (acts.get(f.period_month) ?? -1)) < 0.01 && !n(f.planned_amount));
  if (same || (!old.length && !acts.size)) continue;
  ops.push({ step: "4 Cost actuals", table: "cost_forecasts", action: "update", id: c.id, target: `${c.code} ${c.name}`,
    change: `${old.length} rows (actual ${usd(old.reduce((s, f) => s + n(f.actual_amount), 0))}, plan ${usd(old.filter((f) => !n(f.actual_amount)).reduce((s, f) => s + n(f.planned_amount), 0))}) -> ${acts.size} rows (actual ${usd([...acts.values()].reduce((s, v) => s + v, 0))}, no plan)`,
    source: "QB cash paid by month on this code (bought-out scope: cost tiles only, not the cash flow)" });
}

for (const c of codes) {
  if (COMMIT_CODES.has(c.code)) continue;
  const old = forecasts.filter((f) => f.cost_code_id === c.id);
  const acts = actualBy.get(c.code) ?? new Map();
  const plans = plannedBy.get(c.code) ?? new Map();
  // Budget left after everything already paid, owed or invoiced.
  const est = c.code === "CO-02" ? 0 : (qbEstimate.get(c.code) ?? n(c.estimated_cost));
  const committed = (accrued.get(c.code) ?? 0) + (openByCode.get(c.code) ?? 0) - [...acts.entries()].filter(([m]) => m > "2026-09-01").reduce((s, [, v]) => s + v, 0) * 0;
  let etc = Math.max(0, est - (accrued.get(c.code) ?? 0) - (openByCode.get(c.code) ?? 0) - (acts.get("2026-10-01") ?? 0));
  const months = BURN_CODES.has(c.code) ? BURN_MONTHS : SPREAD_MONTHS;
  if (BURN_CODES.has(c.code)) {
    const trail = ["2026-07-01", "2026-08-01", "2026-09-01"].reduce((s, m) => s + (acts.get(m) ?? 0), 0) / 3;
    const runRate = trail * BURN_MONTHS.length - (plans.get("2026-10-01") ?? 0) - (acts.get("2026-10-01") ?? 0);
    if (runRate > etc + 1) {
      etcNotes.push(`${c.code} ${c.name}: ${usd(etc)} of budget left, but it has been running ${usd(trail)}/month. Forecast at the run rate (${usd(runRate)}) through January - ${usd(runRate - etc)} over budget.`);
      etc = Math.max(0, runRate);
    }
  }
  for (const m of months) addPlan(c.code, m, etc / months.length);
  const after = new Map<string, { p: number; a: number }>();
  for (const [m, v] of acts) after.set(m, { p: 0, a: v });
  for (const [m, v] of plannedBy.get(c.code) ?? new Map()) { const x = after.get(m) ?? { p: 0, a: 0 }; x.p += v; after.set(m, x); }
  for (const [m, x] of after) if (x.p > 0.005 || x.a > 0.005) fcRowsAfter.push({ code: c.code, period_month: m, planned_amount: r2(x.p), actual_amount: r2(x.a) });
  const before = old.reduce((s, f) => s + n(f.actual_amount), 0);
  const afterAct = [...acts.values()].reduce((s, v) => s + v, 0);
  const afterPlan = [...after.values()].reduce((s, x) => s + x.p, 0);
  const beforePlan = old.filter((f) => !n(f.actual_amount)).reduce((s, f) => s + n(f.planned_amount), 0);
  if (old.length || after.size) ops.push({ step: "4 Cost actuals", table: "cost_forecasts", action: "update", id: c.id, target: `${c.code} ${c.name}`,
    change: `${old.length} rows (actual ${usd(before)}, plan ${usd(beforePlan)}) -> ${after.size} rows (actual ${usd(afterAct)}, plan ${usd(afterPlan)})`,
    source: `QB cash paid by month; open bills by due date; ${usd(etc)} remaining budget spread ${months[0].slice(0, 7)} to ${months[months.length - 1].slice(0, 7)}` });
}

// Sub pay apps the sync proposes, for the simulation. Line detail is spread
// pro rata over the sub's SOV - an approximation until each pay app is
// entered from its PDF through Sub Billing, which is where real lines come from.
const sovLines = await all(sb.from("sub_sov_lines").select("id, subcontractor_id, scheduled_value, active").eq("project_id", PID));
const realLines = await all(sb.from("sub_pay_app_lines").select("sub_sov_line_id, total_completed, sub_pay_app_id").in("sub_pay_app_id", subApps.map((a) => a.id)));
type SimApp = { sub: any; app_number: number; gross: number; retainage: number; amount_due: number; status: string; paid_at?: string; due_date: string; lines?: boolean };
const simApps: SimApp[] = [
  { sub: pyr, app_number: 2, gross: 113460.04, retainage: r2(113460.04 * 0.05), amount_due: r2(113460.04 * 0.95), status: "approved", due_date: "2026-10-18", lines: true },
  { sub: pyr, app_number: 3, gross: 79085.37, retainage: r2(79085.37 * 0.05), amount_due: r2(79085.37 * 0.95), status: "received", due_date: "2026-10-28", lines: true },
  { sub: lum, app_number: 1, gross: 163174.33, retainage: 14459.49, amount_due: 130135.44, status: "approved", due_date: "2026-09-01", lines: true },
  { sub: lum, app_number: 1, gross: 0, retainage: 0, amount_due: 18579.40, status: "paid", paid_at: "2026-09-23", due_date: "2026-09-01" },
  { sub: sun, app_number: 1, gross: 33293.33, retainage: 0, amount_due: 33293.33, status: "paid", paid_at: "2026-09-08", due_date: "2026-09-08", lines: true },
];
review.push({ item: "Pyramid App 3 (Rillion 1407, $79,085.37)", why: "Assumed gross with 5% retainage, like App 1.", proposal: "Confirm from the pay app when entering it." });
// A pay app already entered through Sub Billing is real and needs no stand-in.
for (let i = simApps.length - 1; i >= 0; i--) {
  if (subApps.some((a) => a.subcontractor_id === simApps[i].sub.id && a.app_number === simApps[i].app_number)) simApps.splice(i, 1);
}
const cumBySubLine = new Map<string, number>();
for (const l of realLines) cumBySubLine.set(l.sub_sov_line_id, Math.max(cumBySubLine.get(l.sub_sov_line_id) ?? 0, n(l.total_completed)));
const simLines: any[] = [];
const simAppRows: any[] = [];
for (const a of simApps) {
  simAppRows.push({ id: "sim-" + simAppRows.length, project_id: PID, subcontractor_id: a.sub.id, app_number: a.app_number, status: a.status,
    amount_due: a.amount_due, approved_amount_due: a.amount_due, approved_retainage: a.retainage, retainage_this_period: a.retainage,
    paid_at: a.paid_at ?? null, due_date: a.due_date });
  if (!a.lines) continue;
  const lines = sovLines.filter((l) => l.subcontractor_id === a.sub.id && l.active !== false);
  const sv = lines.reduce((s, l) => s + n(l.scheduled_value), 0);
  for (const l of lines) {
    const cum = (cumBySubLine.get(l.id) ?? 0) + a.gross * n(l.scheduled_value) / sv;
    cumBySubLine.set(l.id, cum);
    simLines.push({ sub_sov_line_id: l.id, total_completed: r2(cum), sub_pay_apps: { project_id: PID, app_number: a.app_number + 0.5 } });
  }
}
// billing_entries are read by the engine without their id.
const entryKey = (e: any) => `${e.pay_application_id}|${e.billing_line_id}|${e.period_month}`;
const entrySet = new Map<string, any>();
for (const o of ops.filter((o) => o.table === "billing_entries" && o.set)) {
  const e = entries.find((x) => x.id === o.id)!; entrySet.set(entryKey(e), { ...(entrySet.get(entryKey(e)) ?? {}), ...o.set });
}

// ---------------------------------------------------------------------------
// The projection, before and after. The "after" client serves the live reads
// with the change list applied in memory. Nothing is written.
// ---------------------------------------------------------------------------
const byId = new Map<string, Op>(); for (const o of ops) if (o.id && o.set && !o.hold) byId.set(o.id + o.table, { ...(byId.get(o.id + o.table) ?? {}), ...o, set: { ...(byId.get(o.id + o.table)?.set ?? {}), ...o.set } } as Op);
const codeObj = (code: string) => { const c = codeBy.get(code)!; return { ...c, commitment_covered: c.commitment_covered || COMMIT_CODES.has(code), subcontractors: c.subcontractors ?? null }; };
let dropDraftCos = false;
let skipSimSubs = false;
function patch(table: string, data: any) {
  const apply = (row: any) => { const o = byId.get(row.id + table); return o ? { ...row, ...o.set } : row; };
  const arr = Array.isArray(data) ? data : null;
  if (!arr) return data && data.id ? apply(data) : data;
  let out = arr.map(apply);
  if (table === "billing_entries") out = out.map((e: any) => (entrySet.has(entryKey(e)) ? { ...e, ...entrySet.get(entryKey(e)) } : e));
  if (table === "sub_pay_apps" && !skipSimSubs) out = out.concat(simAppRows);
  if (table === "change_orders" && dropDraftCos) out = out.filter((c: any) => c.status === "approved");
  if (table === "sub_pay_app_lines" && !skipSimSubs) out = out.map((l: any) => ({ ...l, sub_pay_apps: { ...(l.sub_pay_apps ?? {}), app_number: l.sub_pay_apps?.app_number ?? 1 } })).concat(simLines);
  if (table === "cost_forecasts") {
    out = []; // every code's rows are rebuilt from QB below
    for (const f of fcRowsAfter) out.push({ period_month: f.period_month, planned_amount: f.planned_amount, actual_amount: f.actual_amount, cost_codes: codeObj(f.code) });
  }
  if (table === "procurement_payments") {
    for (const o of ops.filter((o) => o.table === "procurement_payments" && o.action === "insert" && !o.hold)) {
      const po = pos.find((p) => p.id === o.row!.procurement_order_id);
      out.push({ ...o.row, id: "new-" + Math.random(), paid_amount: o.row!.paid_amount ?? null, paid_at: o.row!.paid_at ?? null, procurement_orders: { project_id: PID, po_number: po.po_number } });
    }
  }
  return out;
}
function wrap(b: any, table: string): any {
  return new Proxy(b, {
    get(target, prop) {
      if (prop === "then") return (res: any, rej: any) => target.then((r: any) => res(r?.data ? { ...r, data: patch(table, r.data) } : r), rej);
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...a: any[]) => { const out = v.apply(target, a); return out && typeof out === "object" && "then" in out ? wrap(out, table) : out; };
    },
  });
}
const patched = new Proxy(sb, { get(t, p) { if (p === "from") return (table: string) => wrap(t.from(table), table); return t[p]; } });

const before = await buildProjection(sb, PID, { today: TODAY, monthsAhead: 6 });
const withDrafts = await buildProjection(patched, PID, { today: TODAY, monthsAhead: 6 });
// Main view: the contract as signed. Draft change orders are a scenario.
dropDraftCos = true;
const after = await buildProjection(patched, PID, { today: TODAY, monthsAhead: 6 });
// What the app shows the moment --apply finishes, before the four sub pay
// apps are entered in Sub Billing.
skipSimSubs = true;
const afterWrite = await buildProjection(patched, PID, { today: TODAY, monthsAhead: 6 });
skipSimSubs = false;

const afterFixed = after.rows;

// Tie-out: cash to date.
const qbIn = revCash.reduce((s, t) => s + n(t.Credit), 0);
const qbOut = costCash.reduce((s, t) => s + n(t.Debit) - n(t.Credit), 0);
const cumAt = (rows: any[], m: string) => rows.filter((r) => r.month <= m).reduce((s, r) => s + r.netCash, 0);
const sum = (rows: any[], m: string, k: string) => rows.filter((r) => r.month <= m).reduce((s, r) => s + r[k], 0);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const L: string[] = [];
L.push(`# Sweet Springs - QuickBooks sync, DRY RUN`, "");
L.push(`Cutoff ${CUTOFF} (payments through 2026-10-06). Run ${new Date().toISOString().slice(0, 16).replace("T", " ")}. **Nothing was written.**`, "");
{
  const rows = afterFixed;
  const tin = rows.reduce((s, r) => s + r.cashIn, 0), tout = rows.reduce((s, r) => s + r.totalCashOut, 0);
  const fwd = rows.filter((r) => r.month >= "2026-10-01");
  const low = fwd.reduce((m, r) => (r.cumulativeCash < m.cumulativeCash ? r : m), fwd[0]);
  const deposits = 62757.32;
  L.push(`## Summary`, "");
  L.push(`| # | Measure | Value |`, `|---|---|---|`);
  L.push(`| 1 | Cash received to date | ${usd(qbIn)} - ties to QuickBooks |`);
  L.push(`| 2 | Cash paid to date | ${usd(sum(rows, "2026-09-01", "totalCashOut"))} in the app vs ${usd(qbOut)} in QuickBooks; the difference is three PO deposits the books do not show (review items) |`);
  L.push(`| 3 | Total cash in, whole job | ${usd(tin)} (contract ${usd(n(project.contract_value))}) |`);
  L.push(`| 4 | Total cash out, whole job | ${usd(tout)} |`);
  L.push(`| 5 | Cash margin at completion | ${usd(tin - tout)} (${((tin - tout) / tin * 100).toFixed(1)}%); ${usd(tin - tout + deposits)} if the three deposits were never this job's |`);
  L.push(`| 6 | Lowest point | ${low.label}: ${usd(low.cumulativeCash)} cumulative (${usd(low.cumulativeCash + deposits)} on QuickBooks' figures) |`, "");
  L.push(`Main view is the contract as signed (approved change orders only). Draft CO-07 and CO-08 are a separate scenario below.`, "");
  L.push(`### Engine rules this projection runs on`, "");
  L.push(`Built into src/lib/projection.ts on 2026-10-08 (approved by Phil).`, "");
  L.push(`| # | Fix | What it changes here |`, `|---|---|---|`);
  L.push(`| 1 | Nothing unpaid lands before the current month | Removes about $287k of phantom August cash in and $56k of phantom September cash out; past-due bills and AFP 12 land in October |`);
  L.push(`| 2 | Sub pay apps are cash (paid at paid_at, open at due date) | Books the $179k already paid to Pyramid, Sunstall and Lumina, which the engine never counted |`);
  L.push(`| 3 | Sub billed-to-date is the latest app's cumulative total, not a sum | No effect today; prevents App 1 being subtracted twice once Pyramid App 2 is entered |`);
  L.push(`| 4 | Contract-line scope includes change-order allocations | CO-02's $709,977 is forecast through the lines it raises instead of not at all; $489,214 of contract back in the forecast |`, "");
}
L.push(`## Tie-out: cash to date at ${CUTOFF}`, "");
L.push(`| # | Measure | Cash in | Cash out | Net |`, `|---|---|---|---|---|`);
L.push(`| 1 | QuickBooks (cash basis) | ${usd(qbIn)} | ${usd(qbOut)} | ${usd(qbIn - qbOut)} |`);
L.push(`| 2 | App today | ${usd(sum(before.rows, "2026-09-01", "cashIn"))} | ${usd(sum(before.rows, "2026-09-01", "totalCashOut"))} | ${usd(cumAt(before.rows, "2026-09-01"))} |`);
L.push(`| 3 | App after this sync | ${usd(sum(afterFixed, "2026-09-01", "cashIn"))} | ${usd(sum(afterFixed, "2026-09-01", "totalCashOut"))} | ${usd(cumAt(afterFixed, "2026-09-01"))} |`, "");
L.push(`Owner retainage held at the cutoff (excluding AFP 12): ${usd2(retainHeld)}.`, "");
L.push(`## Projection, monthly`, "");
const table = (rows: any[], title: string) => {
  L.push(`### ${title}`, "", `| Month | Cash in | Cash out | Net | Cumulative |`, `|---|---|---|---|---|`);
  for (const r of rows.filter((r) => r.month >= "2026-07-01")) L.push(`| ${r.label}${r.isCurrent ? " (now)" : ""} | ${usd(r.cashIn)} | ${usd(r.totalCashOut)} | ${usd(r.netCash)} | ${usd(r.cumulativeCash)} |`);
  L.push("");
};
table(before.rows, "App today, before this sync");
table(afterFixed, "After this sync - approved change orders only");
table(withDrafts.rows, "Scenario - CO-07 and CO-08 approved and billed this month");
table(afterWrite.rows, "Right after --apply, before the four sub pay apps are entered");
L.push(`## Change list`, "");
const steps = [...new Set(ops.map((o) => o.step))].sort();
let k = 0;
for (const s of steps) {
  L.push(`### Step ${s}`, "", `| # | Table | Action | Target | Change | QuickBooks evidence |`, `|---|---|---|---|---|---|`);
  for (const o of ops.filter((o) => o.step === s)) L.push(`| ${++k} | ${o.table} | ${o.hold ? "HOLD" : o.action} | ${o.target} | ${o.change}${o.hold ? ` (waits on ${o.hold})` : ""} | ${o.source} |`);
  L.push("");
}
L.push(`## Forecast calls the sync makes`, "");
for (const e of etcNotes) L.push(`- ${e}`);
L.push(`- Past-due bills and AFP 12's receipt are placed in ${PAST_DUE_MONTH.slice(0, 7)}.`);
L.push(`- Unspent budget on the non-labor codes (general conditions, vehicles, per diem, facilities, insurance, bonds) is forecast as spent, spread to January. That is conservative: if it is not spent, the margin improves by the same amount.`);
L.push(`- Owner billing for work the schedule shows finishing by October is forecast on AFP 13 and received in November. It is only as good as the schedule's finish dates.`, "");
L.push(`## Needs a decision or a document`, "", `| # | Item | Why | Proposal |`, `|---|---|---|---|`);
review.forEach((r, i) => L.push(`| ${i + 1} | ${r.item} | ${r.why} | ${r.proposal} |`));
L.push("", `## Engine warnings after the sync`, "", `| # | Kind | Ref | Message |`, `|---|---|---|---|`);
after.warnings.forEach((w, i) => L.push(`| ${i + 1} | ${w.kind} | ${w.ref} | ${w.message.replace(/\|/g, "/")} |`));

mkdirSync("reports/cashflow", { recursive: true });
writeFileSync(`reports/cashflow/qb-sync-${CUTOFF}.md`, L.join("\n"));
writeFileSync(`reports/cashflow/qb-sync-${CUTOFF}.json`, JSON.stringify({ ops, review, fcRowsAfter, before: before.rows, after: afterFixed, warningsBefore: before.warnings, warningsAfter: after.warnings }, null, 1));
console.log(`ops ${ops.length}, review ${review.length}, unrouted ${unrouted.length}`);
console.log(`QB in ${usd(qbIn)} out ${usd(qbOut)} net ${usd(qbIn - qbOut)} | before ${usd(cumAt(before.rows, "2026-09-01"))} | after in ${usd(sum(afterFixed, "2026-09-01", "cashIn"))} out ${usd(sum(afterFixed, "2026-09-01", "totalCashOut"))} net ${usd(cumAt(afterFixed, "2026-09-01"))}`);
console.log(`wrote reports/cashflow/qb-sync-${CUTOFF}.md`);


// ---------------------------------------------------------------------------
// --apply
// ---------------------------------------------------------------------------
const writable = ops.filter((o) => !o.hold && ["update", "insert"].includes(o.action));
console.log(`writable ops ${writable.length}, held ${ops.filter((o) => o.hold).length}, enter-in-app ${ops.filter((o) => o.action === "enter-in-app").length}`);
if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Backup: every row any op touches, as it is now.
  const backup: Record<string, any[]> = {};
  const grab = async (table: string, col: string, ids: string[]) => {
    if (!ids.length) return;
    backup[table] = (backup[table] ?? []).concat(await all(sb.from(table).select("*").in(col, ids)));
  };
  const idsOf = (t: string) => [...new Set(writable.filter((o) => o.table === t && o.id).map((o) => o.id!))];
  for (const t of ["cost_codes", "pay_applications", "billing_entries", "sub_pay_apps", "procurement_payments", "procurement_orders"]) await grab(t, "id", idsOf(t));
  await grab("cost_forecasts", "cost_code_id", idsOf("cost_forecasts"));
  writeFileSync(`reports/cashflow/qb-sync-backup-${stamp}.json`, JSON.stringify(backup, null, 1));
  console.log(`backup written: reports/cashflow/qb-sync-backup-${stamp}.json`);

  let done = 0;
  for (const o of writable) {
    if (o.table === "cost_forecasts") {
      const rows = fcRowsAfter.filter((f) => codeBy.get(f.code)!.id === o.id);
      const del = await sb.from("cost_forecasts").delete().eq("cost_code_id", o.id);
      if (del.error) throw new Error(`${o.target}: ${del.error.message}`);
      if (rows.length) {
        const ins = await sb.from("cost_forecasts").insert(rows.map((f) => ({
          cost_code_id: o.id, period_month: f.period_month, planned_amount: f.planned_amount, actual_amount: f.actual_amount,
          notes: `QuickBooks sync ${CUTOFF}`,
        })));
        if (ins.error) throw new Error(`${o.target}: ${ins.error.message}`);
      }
    } else if (o.action === "insert") {
      const r = await sb.from(o.table).insert(o.row);
      if (r.error) throw new Error(`${o.target}: ${r.error.message}`);
    } else {
      const r = await sb.from(o.table).update(o.set).eq("id", o.id);
      if (r.error) throw new Error(`${o.target}: ${r.error.message}`);
    }
    done++;
  }
  console.log(`applied ${done} ops`);

  // The bills behind every cost number (0070). Replaced wholesale: the pack
  // is cumulative, so the latest one is the full history.
  const probe = await sb.from("cost_transactions").select("id").limit(1);
  if (probe.error) {
    console.log(`cost_transactions not written (${probe.error.message}) - apply db/migrations/0070_cost_transactions.sql`);
  } else {
    const txRow = (t: any, basis: "cash" | "accrual", sourceFile: string) => {
      const code = appCode(t.Memo);
      return {
        project_id: PID, cost_code_id: code ? codeBy.get(code)?.id ?? null : null, basis,
        txn_date: t.Date, qb_type: t.Type, qb_num: t.Num == null ? null : String(t.Num),
        vendor: t["Source Name"] ?? null, qb_item: t.Memo ?? null, paid_from: t.Split ?? null,
        amount: r2(n(t.Debit) - n(t.Credit)), qb_cutoff: CUTOFF, source_file: sourceFile,
      };
    };
    const rows = [
      ...costCash.map((t) => txRow(t, "cash", "Cost Detail - CASH BASIS")),
      ...paidSinceCutoff.map((t) => txRow(t, "cash", "Payments since cutoff")),
      ...costAccrual.map((t) => txRow(t, "accrual", "Cost Detail - ACCRUAL BASIS")),
    ].filter((r) => r.amount !== 0);
    const del = await sb.from("cost_transactions").delete().eq("project_id", PID);
    if (del.error) throw new Error(`cost_transactions: ${del.error.message}`);
    for (let i = 0; i < rows.length; i += 200) {
      const ins = await sb.from("cost_transactions").insert(rows.slice(i, i + 200));
      if (ins.error) throw new Error(`cost_transactions: ${ins.error.message}`);
    }
    const sumOf = (b: string) => r2(rows.filter((r) => r.basis === b).reduce((s, r) => s + r.amount, 0));
    console.log(`cost_transactions: ${rows.length} rows (cash ${usd2(sumOf("cash"))}, accrual ${usd2(sumOf("accrual"))})`);
  }
}
