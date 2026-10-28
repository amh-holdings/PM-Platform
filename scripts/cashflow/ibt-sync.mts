// IBT -> app cost sync for Sussex. DRY RUN unless --apply.
//
//   npx tsx scripts/cashflow/ibt-sync.mts "<IBT pack folder>"
//   npx tsx scripts/cashflow/ibt-sync.mts "<IBT pack folder>" --apply
//
// IBT TVIG CT JV, LLC keeps the JV's books. Each month IBT finance sends four
// PDFs, filed on Drive under Mac Mini/Sussex Cash Flow/IBT <YYYY-MM-DD>/:
//   Job Cost Report        budget + costs to date by IBT cost code
//   AP Aging Report        open bills (vendor, invoice, due date; NO cost code)
//   Contract Receivables   owner invoices billed / received
//   Income Statement       cross-check on billings and cost
//
// THE RULE: IBT's books are the record for what the JV has incurred, billed
// and been paid; the app owns the forecast. Mirrors qb-sync.mts (Sweet
// Springs), which does the same against AHC's QuickBooks.
//
// What it does:
//   1. reads the four PDFs by text position (columns are matched to the
//      header row, so a blank Change Orders or Costs to Date cell can't shift
//      a number into the wrong column) and checks each report against its own
//      printed totals,
//   2. crosswalks every IBT code to ONE app code: same number AND same scope
//      maps itself, RENUMBER lists the deliberate exceptions, and a same
//      number with a different scope is never mapped silently,
//   3. lists the changes that would make the app agree with IBT. Cost lands
//      as the movement since the last sync: IBT costs to date minus the
//      actuals the app already carries, posted in the report's month,
//   4. writes nothing without --apply; with it, every touched row is backed
//      up to reports/cashflow/ first and ops marked `hold` are skipped.
//
// After an --apply that changes cost, re-run map-sussex-to-schedule.mts so
// the remaining budget re-spreads around the new actuals.
//
// Output: reports/cashflow/ibt-sync-<as of>.md and .json

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const raw = readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const l of raw.split("\n")) {
  const t = l.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
}) as any;

const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";
const DIR = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!DIR) throw new Error("usage: ibt-sync.mts <IBT pack folder> [--apply]");

// IBT cost code -> app cost code where the numbers differ but the scope is
// the same (budgets tie to the cent). Confirmed against the 10/15/2026 report.
const RENUMBER: Record<string, string> = {
  "200-1030": "100-1030", // Structural Design, $10,000 - IBT files it under procurement
  "200-1035": "200-1030", // Racking, Mounting & Trackers, $900,454.74
  "800-1030": "800-1020", // IBT's Project Management is IBT Annex A (Phil, 2026-10-28); app 800-1030 is TVIG Annex A - LNTP
};
// IBT AP carries no cost code, so open bills are coded by vendor. A vendor
// missing here is reported, never guessed.
const VENDOR_CODE: Record<string, { code: string; confirmed: boolean; note: string }> = {
  "HUB INTERNATIONAL": { code: "800-1150", confirmed: true, note: "the JV's bond (Phil, 2026-10-28)" },
};

const n = (v: any) => Number(v ?? 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const usd2 = (v: number) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (s: string) => Number(s.replace(/,/g, "").replace(/^\((.*)\)$/, "-$1"));
const isNum = (s: string) => /^\(?-?[\d,]+\.\d{2}\)?$/.test(s) || /^\(?-?\d{1,3}(,\d{3})+\)?$/.test(s) || /^\d+$/.test(s);
const mdy = (s: string) => {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? "20" + m[3] : m[3];
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
};
const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)?$/, "").replace(/[^a-z0-9]+/g, " ").trim();

// ---------------------------------------------------------------------------
// PDF reading
// ---------------------------------------------------------------------------
type Item = { x0: number; x1: number; s: string };
type Row = { page: number; y: number; items: Item[] };
async function rowsOf(path: string): Promise<Row[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
  const out: Row[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const byY = new Map<number, Item[]>();
    for (const it of tc.items as any[]) {
      const s = String(it.str ?? "").trim();
      if (!s) continue;
      const y = Math.round(it.transform[5]);
      const x0 = it.transform[4];
      (byY.get(y) ?? byY.set(y, []).get(y)!).push({ x0, x1: x0 + it.width, s });
    }
    for (const [y, items] of [...byY].sort((a, b) => b[0] - a[0])) out.push({ page: p, y, items: items.sort((a, b) => a.x0 - b.x0) });
  }
  return out;
}
const text = (rows: Row[]) => rows.map((r) => r.items.map((i) => i.s).join(" ")).join("\n");
// Right-aligned numbers belong to the header whose right edge is nearest.
function column(x1: number, headers: { name: string; x1: number }[]) {
  return headers.reduce((best, h) => (Math.abs(h.x1 - x1) < Math.abs(best.x1 - x1) ? h : best)).name;
}
function headersOf(rows: Row[], names: string[]) {
  const out: { name: string; x1: number }[] = [];
  for (const name of names) {
    const it = rows.flatMap((r) => r.items).find((i) => i.s === name);
    if (!it) throw new Error(`header "${name}" not found - has the IBT report layout changed?`);
    out.push({ name, x1: it.x1 });
  }
  return out;
}

const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".pdf"));
const file = (re: RegExp) => {
  const f = files.find((x) => re.test(x));
  if (!f) throw new Error(`IBT pack is missing ${re}`);
  return join(DIR, f);
};

// ---- Job Cost Report -------------------------------------------------------
type JobLine = { code: string; name: string; costClass: string; original: number; changeOrders: number; revised: number; toDate: number; available: number };
const jobRows = await rowsOf(file(/job[ _-]*cost/i));
const jobAsOf = mdy(text(jobRows).match(/to (\d{1,2}\/\d{1,2}\/\d{4})/)?.[1] ?? "");
if (!jobAsOf) throw new Error("job cost report: no 'to <date>' line");
const JH = headersOf(jobRows, ["Estimated Costs", "Change Orders", "Estimate", "Costs to Date", "Available Budget"]);
const job = new Map<string, JobLine>();
for (const r of jobRows) {
  const [first, ...rest] = r.items;
  if (!/^\d{3}-\d{4}$/.test(first?.s ?? "")) continue;
  const words = rest.filter((i) => !isNum(i.s));
  const vals: Record<string, number> = {};
  for (const i of rest.filter((i) => isNum(i.s))) vals[column(i.x1, JH)] = num(i.s);
  const line: JobLine = {
    code: first.s, name: words[0]?.s ?? "", costClass: words[1]?.s ?? "",
    original: vals["Estimated Costs"] ?? 0, changeOrders: vals["Change Orders"] ?? 0, revised: vals["Estimate"] ?? 0,
    toDate: vals["Costs to Date"] ?? 0, available: vals["Available Budget"] ?? 0,
  };
  // A code split across a page break prints its row again on the next page.
  const prev = job.get(line.code);
  if (prev && (prev.revised !== line.revised || prev.toDate !== line.toDate)) throw new Error(`${line.code} printed twice with different amounts`);
  if (!prev) job.set(line.code, line);
}
const jobTotal = (() => {
  const i = jobRows.findIndex((r) => r.items.some((x) => /Grand Totals/.test(x.s)));
  const tot = jobRows.slice(i + 1).find((r) => r.items.every((x) => isNum(x.s)) && r.items.length >= 2);
  if (!tot) throw new Error("job cost report: no grand total row");
  const v: Record<string, number> = {};
  for (const x of tot.items) v[column(x.x1, JH)] = num(x.s);
  return { revised: v["Estimate"] ?? 0, toDate: v["Costs to Date"] ?? 0 };
})();
const jobSum = (k: "revised" | "toDate") => r2([...job.values()].reduce((s, l) => s + l[k], 0));
if (jobSum("revised") !== jobTotal.revised) throw new Error(`job cost lines sum to ${jobSum("revised")}, report total ${jobTotal.revised}`);
if (jobSum("toDate") !== jobTotal.toDate) throw new Error(`job cost to date sums to ${jobSum("toDate")}, report total ${jobTotal.toDate}`);

// ---- Contract Receivables ------------------------------------------------
type Invoice = { invoice: string; description: string; date: string; paidOn: string | null; invoiced: number; received: number; due: number; retainage: number };
const arRows = await rowsOf(file(/receivable/i));
const arAsOf = mdy(text(arRows).match(/AS OF:\s*(\S+)/)?.[1] ?? "");
const contractAmount = num(text(arRows).match(/Contract Amount:\s*([\d,.]+)/)?.[1] ?? "0");
const AH = headersOf(arRows, ["Date", "Paid", "Invoiced", "Received", "Due", "Retainage", "Receivable"]);
const invoices: Invoice[] = [];
for (const r of arRows) {
  const [first, ...rest] = r.items;
  if (!/^\d{3}-\d{2,}$/.test(first?.s ?? "")) continue;
  const v: Record<string, string> = {};
  for (const i of rest) if (isNum(i.s) || mdy(i.s)) v[column(i.x1, AH)] = i.s;
  invoices.push({
    invoice: first.s, description: rest.find((i) => !isNum(i.s) && !mdy(i.s))?.s ?? "",
    date: mdy(v.Date ?? "") ?? "", paidOn: mdy(v.Paid ?? ""),
    invoiced: num(v.Invoiced ?? "0"), received: num(v.Received ?? "0"), due: num(v.Due ?? "0"), retainage: num(v.Retainage ?? "0"),
  });
}
const arTotal = num(arRows.find((r) => r.items.some((i) => /Grand Total/.test(i.s)))?.items.filter((i) => isNum(i.s))[0]?.s ?? "NaN");
if (r2(invoices.reduce((s, i) => s + i.invoiced, 0)) !== arTotal) throw new Error(`receivables lines don't sum to the grand total ${arTotal}`);

// ---- AP Aging ------------------------------------------------------------
type Bill = { vendor: string; trx: string; invoice: string; date: string; dueDate: string | null; amount: number; retainage: number; onHold: boolean };
const apRows = await rowsOf(file(/ap[ _-]*aging/i));
const apAsOf = mdy(text(apRows).match(/As Of Date:\s*(\S+)/)?.[1] ?? "");
const bills: Bill[] = [];
{
  const PH = headersOf(apRows, ["Current", "31-60 Days", "61-90 Days", "90+ Days", "Retainage"]);
  let vendor = "";
  for (const r of apRows) {
    const [first, second, ...rest] = r.items;
    if (/^\d+ -$/.test(first?.s ?? "")) { vendor = second?.s ?? ""; continue; }
    if (!/^\*?\d+$/.test(first?.s ?? "") || !second) continue;
    const date = rest.find((i) => mdy(i.s));
    if (!date) continue;
    let amount = 0, retainage = 0;
    for (const i of rest.filter((i) => isNum(i.s))) {
      if (column(i.x1, PH) === "Retainage") retainage += num(i.s); else amount += num(i.s);
    }
    const due = r.items.map((i) => i.s.match(/(\d{1,2}\/\d{1,2}\/\d{2})$/)?.[1]).filter(Boolean).pop();
    bills.push({ vendor, trx: first.s.replace("*", ""), invoice: second.s, date: mdy(date.s)!, dueDate: due && due !== date.s ? mdy(due) : mdy(date.s), amount: r2(amount), retainage: r2(retainage), onHold: first.s.startsWith("*") });
  }
}
const apTotal = num(apRows.find((r) => r.items.some((i) => /Net Payable Total/.test(i.s)))?.items.find((i) => isNum(i.s))?.s
  ?? apRows[apRows.findIndex((r) => r.items.some((i) => /Net Payable Total/.test(i.s))) - 1]?.items.find((i) => isNum(i.s))?.s ?? "NaN");
if (r2(bills.reduce((s, b) => s + b.amount + b.retainage, 0)) !== apTotal) throw new Error(`AP bills sum to ${bills.reduce((s, b) => s + b.amount, 0)}, report total ${apTotal}`);

// ---- Income Statement ----------------------------------------------------
const isRows = await rowsOf(file(/income[ _-]*statement/i));
const isPeriod = text(isRows).match(/(\d{2}\/\d{2}\/\d{2}) To (\d{2}\/\d{2}\/\d{2})/);
const isLines = isRows.map((r) => ({ label: r.items.filter((i) => !isNum(i.s)).map((i) => i.s).join(" "), nums: r.items.filter((i) => isNum(i.s)).map((i) => num(i.s)) }))
  .filter((l) => l.label && l.nums.length >= 2);
// Columns: current period, %, YTD, %.
const ytd = (re: RegExp) => isLines.filter((l) => re.test(l.label)).reduce((s, l) => s + (l.nums[2] ?? l.nums[0]), 0);
const isBillings = ytd(/^BILLINGS/i);
const isNetProfit = ytd(/^Net Profit/i);

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const all = async (q: any) => { const { data, error } = await q; if (error) throw new Error(error.message); return data as any[]; };
const codes = await all(sb.from("cost_codes").select("*").eq("project_id", PID));
const codeBy = new Map(codes.map((c) => [c.code, c]));
const forecasts = await all(sb.from("cost_forecasts").select("*").in("cost_code_id", codes.map((c) => c.id)));
const payApps = await all(sb.from("pay_applications").select("*").eq("project_id", PID));
const entries = await all(sb.from("billing_entries").select("*").in("pay_application_id", payApps.map((p) => p.id)));
const billingLines = await all(sb.from("billing_lines").select("scheduled_value").eq("project_id", PID));
const subs = await all(sb.from("subcontractors").select("id, company_name, contract_value, active").eq("project_id", PID));
// Placeholder POs are the forecast's stand-ins for buys not yet made - not a
// commitment.
const pos = (await all(sb.from("procurement_orders").select("id, po_number, vendor_name, total_value, status").eq("project_id", PID)))
  .filter((p) => !/^SX-PLACEHOLDER/.test(p.po_number ?? "") && p.status !== "cancelled");

type Op = { step: string; table: string; action: "update" | "insert" | "review"; id?: string; target: string; change: string; source: string; set?: Record<string, any>; row?: Record<string, any>; hold?: string };
const ops: Op[] = [];
const review: { item: string; why: string; proposal: string }[] = [];

// ---- Step 0: crosswalk ---------------------------------------------------
type Map1 = { ibt: JobLine; app: any | null; how: string };
const cross: Map1[] = [];
for (const l of job.values()) {
  if (RENUMBER[l.code]) { cross.push({ ibt: l, app: codeBy.get(RENUMBER[l.code]) ?? null, how: `renumbered ${l.code} -> ${RENUMBER[l.code]}` }); continue; }
  const same = codeBy.get(l.code);
  // IBT truncates long names ("Mechanical Installation (Modul"), so a prefix
  // match on either side counts as the same scope.
  if (same && (norm(same.name).startsWith(norm(l.name)) || norm(l.name).startsWith(norm(same.name)))) { cross.push({ ibt: l, app: same, how: "same code" }); continue; }
  cross.push({ ibt: l, app: null, how: same ? `same number, different scope (app: "${same.name}")` : "no app code" });
}
const unmapped = cross.filter((c) => !c.app);
for (const c of unmapped) review.push({ item: `IBT ${c.ibt.code} ${c.ibt.name} (${usd2(c.ibt.revised)} budget, ${usd2(c.ibt.toDate)} to date)`, why: c.how, proposal: "Name the app code it belongs to (add it to RENUMBER). Its cost is not synced until then." });
const mappedTo = new Set(cross.filter((c) => c.app).map((c) => c.app.code));
const appOnly = codes.filter((c) => !mappedTo.has(c.code) && n(c.estimated_cost) !== 0);

// Budget: reported, not written. Which budget is the record for the JV is
// Phil's call (open as of 2026-10-28).
const budgetDiffs = cross.filter((c) => c.app && Math.abs(c.ibt.revised - n(c.app.estimated_cost)) > 0.005);
const appBudget = r2(codes.reduce((s, c) => s + n(c.estimated_cost), 0));
if (Math.abs(appBudget - jobTotal.revised) > 0.005 || budgetDiffs.length) review.push({ item: `Budget: IBT ${usd2(jobTotal.revised)} vs app ${usd2(appBudget)} (${usd2(jobTotal.revised - appBudget)})`,
  why: `${budgetDiffs.length} mapped codes differ, ${unmapped.length} IBT codes and ${appOnly.length} app codes have no partner. See the crosswalk table.`,
  proposal: "Decide which budget is the record for the JV before anything is written to estimated_cost." });

// ---- Step 1: open AP -----------------------------------------------------
// A bill in AP should already be in the job cost's costs to date. One that
// isn't (vendor's code shows less to date than the bill) has not been
// distributed to the job yet - carried as cost in its invoice month. A bill
// booked on an earlier run is recognised by its note and not booked again.
const reportMonth = jobAsOf.slice(0, 7) + "-01";
const apPending = new Map<string, number>(); // app code -> AP not yet in job cost
const apBookedNow = new Map<string, number>(); // app code -> booked by this run
for (const b of bills) {
  const v = VENDOR_CODE[b.vendor];
  if (!v) { review.push({ item: `Open bill ${b.vendor} ${b.invoice} ${usd2(b.amount)} (${b.date})`, why: "IBT's AP report has no cost code and this vendor is not in VENDOR_CODE.", proposal: "Ask IBT which cost code it is distributed to." }); continue; }
  const app = codeBy.get(v.code)!;
  const ibtLine = cross.find((c) => c.app?.code === v.code)?.ibt;
  const inJobCost = (ibtLine?.toDate ?? 0) >= b.amount - 0.005;
  if (inJobCost) continue;
  apPending.set(v.code, r2((apPending.get(v.code) ?? 0) + b.amount + b.retainage));
  review.push({ item: `${b.vendor} ${b.invoice} ${usd2(b.amount)} is in AP but not in job cost`, why: `IBT ${ibtLine?.code ?? v.code} shows ${usd2(ibtLine?.toDate ?? 0)} to date as of ${jobAsOf}, but the bill is dated ${b.date}. ${v.confirmed ? "" : `Code ${v.code} is an assumption: ${v.note}.`}`, proposal: "Ask IBT to distribute it to the job. The app carries it as incurred meanwhile." });
  if (forecasts.some((f) => f.cost_code_id === app.id && String(f.notes ?? "").includes(`ibt-sync AP ${b.invoice}`))) continue;
  const month = b.date.slice(0, 7) + "-01";
  const row = forecasts.find((f) => f.cost_code_id === app.id && f.period_month === month);
  const hold = v.confirmed ? undefined : `confirm ${b.vendor} ${b.invoice} is ${v.code} ${app.name} (${v.note}) and why it is not on the job cost report`;
  if (!hold) apBookedNow.set(v.code, r2((apBookedNow.get(v.code) ?? 0) + b.amount));
  ops.push(row
    ? { step: "1 AP", table: "cost_forecasts", action: "update", id: row.id, target: `${app.code} ${month.slice(0, 7)}`, change: `actual ${usd2(n(row.actual_amount))} -> ${usd2(n(row.actual_amount) + b.amount)}, due ${b.dueDate}`, source: `IBT AP ${b.vendor} inv ${b.invoice} ${b.date}`, set: { actual_amount: r2(n(row.actual_amount) + b.amount), notes: `ibt-sync AP ${b.invoice}` }, hold }
    : { step: "1 AP", table: "cost_forecasts", action: "insert", target: `${app.code} ${month.slice(0, 7)}`, change: `new actual ${usd2(b.amount)}, due ${b.dueDate}`, source: `IBT AP ${b.vendor} inv ${b.invoice} ${b.date}`, row: { cost_code_id: app.id, period_month: month, planned_amount: 0, actual_amount: b.amount, notes: `ibt-sync AP ${b.invoice}` }, hold });
}

// ---- Step 2: cost incurred ---------------------------------------------
// Incurred = IBT costs to date + AP not yet on the job cost. actual_cost is
// what the Costs page shows; the month rows must add up to the same figure,
// so whatever they are short lands in the report month.
const appActual = (c: any) => r2(forecasts.filter((f) => f.cost_code_id === c.id).reduce((s, f) => s + n(f.actual_amount), 0));
for (const c of cross.filter((c) => c.app)) {
  const app = c.app;
  const incurred = r2(c.ibt.toDate + (apPending.get(app.code) ?? 0));
  if (Math.abs(n(app.actual_cost) - incurred) > 0.005) ops.push({ step: "2 Cost", table: "cost_codes", action: "update", id: app.id, target: `${app.code} ${app.name}`,
    change: `actual_cost ${usd2(n(app.actual_cost))} -> ${usd2(incurred)}`, source: `IBT job cost ${c.ibt.code} ${usd2(c.ibt.toDate)} to date ${jobAsOf}${apPending.get(app.code) ? ` + ${usd2(apPending.get(app.code)!)} AP not yet on it` : ""}`, set: { actual_cost: incurred } });
  const have = r2(appActual(app) + (apBookedNow.get(app.code) ?? 0));
  const delta = r2(incurred - have);
  if (Math.abs(delta) < 0.005) continue;
  if (delta < 0) { review.push({ item: `${app.code} incurred fell`, why: `IBT ${usd2(incurred)}, app month rows carry ${usd2(have)}.`, proposal: "A credit or recode at IBT - find which month to reverse." }); continue; }
  const row = forecasts.find((f) => f.cost_code_id === app.id && f.period_month === reportMonth);
  const actual = r2(n(row?.actual_amount) + delta);
  // The row's plan is replaced by the actual (engine reads actual when > 0);
  // map-sussex-to-schedule re-spreads what is left of the budget.
  ops.push(row
    ? { step: "2 Cost", table: "cost_forecasts", action: "update", id: row.id, target: `${app.code} ${reportMonth.slice(0, 7)}`, change: `actual ${usd2(n(row.actual_amount))} -> ${usd2(actual)} (plan ${usd2(n(row.planned_amount))} gives way)`, source: `incurred ${usd2(incurred)} less ${usd2(have)} already in the app`, set: { actual_amount: actual, notes: `ibt-sync ${jobAsOf}` } }
    : { step: "2 Cost", table: "cost_forecasts", action: "insert", target: `${app.code} ${reportMonth.slice(0, 7)}`, change: `new actual ${usd2(actual)}`, source: `incurred ${usd2(incurred)} less ${usd2(have)} already in the app`, row: { cost_code_id: app.id, period_month: reportMonth, planned_amount: 0, actual_amount: actual, notes: `ibt-sync ${jobAsOf}` } });
}

// ---- Step 3: owner billing and receipts -----------------------------------
// IBT invoice 202-NN = app AFP N.
const afpOf = (inv: string) => "AFP " + parseInt(inv.split("-")[1], 10);
for (const inv of invoices) {
  const pa = payApps.find((p) => p.app_number === afpOf(inv.invoice));
  if (!pa) { review.push({ item: `IBT invoice ${inv.invoice} ${inv.description} ${usd2(inv.invoiced)}`, why: `No ${afpOf(inv.invoice)} in the app.`, proposal: "Enter the pay app in the app from the invoice PDF." }); continue; }
  if (Math.abs(n(pa.total_completed) - inv.invoiced) > 0.005) review.push({ item: `${pa.app_number} gross differs`, why: `App ${usd2(n(pa.total_completed))}, IBT ${usd2(inv.invoiced)}.`, proposal: "IBT's invoice is what the owner was billed - correct the app." });
  if (inv.received > 0 && inv.paidOn) {
    if (Math.abs(inv.received - n(pa.amount_due)) > 0.005) review.push({ item: `${pa.app_number} paid ${usd2(inv.received)} against ${usd2(n(pa.amount_due))} due`, why: "Short or over payment.", proposal: "Find out what the owner held back." });
    const set: Record<string, any> = {};
    if (String(pa.paid_at ?? "").slice(0, 10) !== inv.paidOn) set.paid_at = inv.paidOn;
    if (pa.status !== "paid") set.status = "paid";
    if (Object.keys(set).length) ops.push({ step: "3 Owner", table: "pay_applications", action: "update", id: pa.id, target: pa.app_number,
      change: Object.entries(set).map(([k, v]) => `${k} ${pa[k] ?? "empty"} -> ${v}`).join("; "), source: `IBT receivables: ${inv.invoice} ${usd2(inv.received)} received ${inv.paidOn}`, set });
    for (const e of entries.filter((e) => e.pay_application_id === pa.id)) {
      const es: Record<string, any> = {};
      if (String(e.paid_at ?? "").slice(0, 10) !== inv.paidOn) es.paid_at = inv.paidOn;
      if (e.status !== "paid") es.status = "paid";
      if (Object.keys(es).length) ops.push({ step: "3 Owner", table: "billing_entries", action: "update", id: e.id, target: `${pa.app_number} line entry ${usd2(n(e.actual_amount))}`,
        change: Object.entries(es).map(([k, v]) => `${k} ${e[k] ?? "empty"} -> ${v}`).join("; "), source: "same receipt", set: es });
    }
  }
}
for (const pa of payApps) if (!invoices.some((i) => afpOf(i.invoice) === pa.app_number))
  review.push({ item: `${pa.app_number} is not on IBT's receivables (as of ${arAsOf})`, why: "Billed in the app, not in the JV's books.", proposal: "Confirm IBT has invoiced it." });
const sov = r2(billingLines.reduce((s, b) => s + n(b.scheduled_value), 0));
if (Math.abs(sov - contractAmount) > 0.005) review.push({ item: `Contract amount: IBT ${usd2(contractAmount)}, app SOV ${usd2(sov)}`, why: "A change order one side has and the other doesn't.", proposal: "Reconcile." });
const arBilled = r2(invoices.reduce((s, i) => s + i.invoiced, 0));
if (Math.abs(Math.round(arBilled) - Math.round(isBillings)) > 1) review.push({ item: `Income statement billings ${usd2(isBillings)} vs receivables ${usd2(arBilled)}`, why: "The two IBT reports disagree.", proposal: "Ask IBT." });
if (Math.abs(r2(isBillings - isNetProfit) - jobTotal.toDate) > 1 && isNetProfit !== 0) review.push({ item: `Income statement cost ${usd2(isBillings - isNetProfit)} vs job cost to date ${usd2(jobTotal.toDate)}`, why: `Different cutoffs (${isPeriod?.[2]} vs ${jobAsOf}) or cost booked outside the job.`, proposal: "Check against the next month's pack." });

// ---- Overrun watch -------------------------------------------------------
// The point of the monthly sync: which codes will finish over budget. Spent
// alone is never over until the end, so each code is projected at the
// largest of its budget, what is signed (subcontracts + real POs) and what is
// already incurred (IBT to date + AP not yet in job cost). Measured against
// the app budget - the estimate the margin was set on. IBT's budget is shown
// beside it; a code IBT budgets higher is flagged, not counted as overrun.
type Watch = { code: string; name: string; budget: number; ibtBudget: number | null; committed: number; incurred: number; forecast: number; over: number; flags: string[] };
const watch: Watch[] = [];
for (const c of codes) {
  const budget = n(c.estimated_cost);
  const ibt = cross.find((x) => x.app?.code === c.code)?.ibt;
  const sub = subs.find((s) => s.id === c.subcontractor_id && s.active !== false);
  const po = pos.find((p) => p.id === c.procurement_order_id);
  const committed = r2(n(sub?.contract_value) + n(po?.total_value));
  const incurred = r2((ibt?.toDate ?? 0) + (apPending.get(c.code) ?? 0));
  const forecast = Math.max(budget, committed, incurred);
  const flags: string[] = [];
  if (incurred > budget + 0.005) flags.push(`incurred ${usd2(incurred)} is past budget`);
  else if (budget > 0 && incurred >= budget * 0.8) flags.push(`${Math.round((incurred / budget) * 100)}% of budget spent`);
  if (committed > budget + 0.005) flags.push(`signed ${usd2(committed)} (${sub?.company_name ?? po?.vendor_name}) is over budget`);
  if (ibt && ibt.revised > budget + 0.005) flags.push(`IBT budgets ${usd2(ibt.revised)}`);
  if (!budget && (incurred || committed)) flags.push("cost on a $0 code");
  if (budget || incurred || committed || flags.length) watch.push({ code: c.code, name: c.name, budget, ibtBudget: ibt?.revised ?? null, committed, incurred, forecast, over: r2(forecast - budget), flags });
}
// IBT cost with no app code can't be judged against a budget - always shown.
for (const u of unmapped.filter((u) => u.ibt.toDate > 0))
  watch.push({ code: `IBT ${u.ibt.code}`, name: u.ibt.name, budget: 0, ibtBudget: u.ibt.revised, committed: 0, incurred: u.ibt.toDate, forecast: u.ibt.toDate, over: u.ibt.toDate, flags: ["IBT cost with no app code"] });
const flagged = watch.filter((w) => w.flags.length).sort((a, b) => b.over - a.over || a.code.localeCompare(b.code));
const overTotal = r2(watch.reduce((s, w) => s + w.over, 0));
const budgetMargin = r2(contractAmount - appBudget);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const L: string[] = [];
L.push(`# IBT sync - Sussex, job cost to ${jobAsOf}`, "");
L.push("## Overrun watch", "");
L.push(`Forecast overrun **${usd2(overTotal)}** against the ${usd2(appBudget)} budget. Margin at budget ${usd2(budgetMargin)}, at forecast ${usd2(r2(budgetMargin - overTotal))}.`, "");
L.push(`Forecast per code = the largest of budget, signed commitments and cost incurred. ${watch.length - flagged.length} codes have nothing to flag.`, "");
if (flagged.length) {
  L.push("| # | Code | Name | Budget | Signed | Incurred | Forecast | Over | Why flagged |", "|---|---|---|---|---|---|---|---|---|");
  flagged.forEach((w, i) => L.push(`| ${i + 1} | ${w.code} | ${w.name} | ${usd2(w.budget)} | ${usd2(w.committed)} | ${usd2(w.incurred)} | ${usd2(w.forecast)} | ${w.over > 0 ? "**" + usd2(w.over) + "**" : "-"} | ${w.flags.join("; ")} |`));
  L.push("");
}
L.push(`Pack: \`${DIR}\`  `, `Job cost to ${jobAsOf} | AP as of ${apAsOf} | receivables as of ${arAsOf} | income statement ${isPeriod?.[1]} to ${isPeriod?.[2]}  `, `Mode: ${APPLY ? "APPLY" : "dry run - nothing written"}`, "");
L.push("## Totals", "", "| # | Item | IBT | App |", "|---|---|---|---|");
L.push(`| 1 | Budget | ${usd2(jobTotal.revised)} | ${usd2(appBudget)} |`);
L.push(`| 2 | Cost to date | ${usd2(jobTotal.toDate)} | ${usd2(r2(codes.reduce((s, c) => s + n(c.actual_cost), 0)))} |`);
L.push(`| 3 | Open AP | ${usd2(apTotal)} | - |`);
L.push(`| 4 | Billed to owner | ${usd2(arBilled)} | ${usd2(r2(payApps.reduce((s, p) => s + n(p.total_completed), 0)))} |`);
L.push(`| 5 | Received from owner | ${usd2(r2(invoices.reduce((s, i) => s + i.received, 0)))} | ${usd2(r2(payApps.filter((p) => p.status === "paid").reduce((s, p) => s + n(p.amount_due), 0)))} |`);
L.push(`| 6 | Contract | ${usd2(contractAmount)} | ${usd2(sov)} |`, "");
L.push("## Crosswalk", "", "| # | IBT code | IBT name | App code | App name | IBT budget | App budget | Diff | IBT to date | How |", "|---|---|---|---|---|---|---|---|---|---|");
cross.forEach((c, i) => L.push(`| ${i + 1} | ${c.ibt.code} | ${c.ibt.name} | ${c.app?.code ?? "**none**"} | ${c.app?.name ?? ""} | ${usd2(c.ibt.revised)} | ${c.app ? usd2(n(c.app.estimated_cost)) : ""} | ${c.app ? usd2(r2(c.ibt.revised - n(c.app.estimated_cost))) : ""} | ${usd2(c.ibt.toDate)} | ${c.how} |`));
appOnly.forEach((c, i) => L.push(`| ${cross.length + i + 1} | **none** | | ${c.code} | ${c.name} | | ${usd2(n(c.estimated_cost))} | | | app only |`));
L.push("", "## Changes", "");
if (!ops.length) L.push("None.");
else { L.push("| # | Step | Table | Target | Change | Source | Status |", "|---|---|---|---|---|---|---|"); ops.forEach((o, i) => L.push(`| ${i + 1} | ${o.step} | ${o.table} | ${o.target} | ${o.change} | ${o.source} | ${o.hold ? "HOLD: " + o.hold : "ready"} |`)); }
L.push("", "## For review", "");
if (!review.length) L.push("None.");
else { L.push("| # | Item | Why | Proposal |", "|---|---|---|---|"); review.forEach((r, i) => L.push(`| ${i + 1} | ${r.item} | ${r.why} | ${r.proposal} |`)); }

mkdirSync("reports/cashflow", { recursive: true });
const base = `reports/cashflow/ibt-sync-${jobAsOf}`;
writeFileSync(base + ".md", L.join("\n") + "\n");
writeFileSync(base + ".json", JSON.stringify({ jobAsOf, apAsOf, arAsOf, job: [...job.values()], bills, invoices, isLines, watch, ops, review }, null, 2));
console.log(L.join("\n"));
console.log(`\nWrote ${base}.md`);

if (APPLY) {
  const ready = ops.filter((o) => !o.hold && o.action !== "review");
  const backup: Record<string, any[]> = {};
  for (const o of ready.filter((o) => o.id)) {
    const { data } = await sb.from(o.table).select("*").eq("id", o.id);
    (backup[o.table] ??= []).push(...(data ?? []));
  }
  const bpath = `reports/cashflow/ibt-sync-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(bpath, JSON.stringify(backup, null, 2));
  for (const o of ready) {
    const { error } = o.action === "insert"
      ? await sb.from(o.table).insert(o.row)
      : await sb.from(o.table).update(o.set).eq("id", o.id);
    if (error) throw new Error(`${o.target}: ${error.message}`);
  }
  console.log(`Applied ${ready.length} changes (${ops.length - ready.length} held). Backup: ${bpath}`);
  if (ready.some((o) => o.table === "cost_forecasts")) console.log("Cost changed - re-run scripts/cashflow/map-sussex-to-schedule.mts --apply.");
}
