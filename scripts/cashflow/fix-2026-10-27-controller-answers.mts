// Sweet Springs - apply the Controller's 2026-10-23 answers. DRY RUN ONLY.
//
//   npx tsx scripts/cashflow/fix-2026-10-27-controller-answers.mts
//   npx tsx scripts/cashflow/fix-2026-10-27-controller-answers.mts --apply
//
// Nancy answered the eight questions from the 9/30 QB sync on 10/23
// ("response to phil.docx"). Phil approved these fixes 2026-10-27:
//   1. GroundWork PO-017, Power Factors P-016 and GridPower PO-018 deposits
//      were never paid - QB shows no payment anywhere. Unpaid, owed now.
//   2. Insurance: $112,675.31 of Sweet Springs excess E&O + umbrella premiums
//      (2025 and 2026 policy years) was paid by TVIG and never posted to the
//      job. Book it to SSC V Insurance; it is not in any change order.
//   3. Maddox $500/month storage belongs on CO-01 (QB SSC Z CO1-5 Maddox),
//      whatever code Rillion gave each bill.
//   4. CAB Solar = "Cambria County Assoc.". PO-022 is $7,950.49 material +
//      $1,010 freight; $3,975.24 still owed on the invoice, freight not billed.
//   5. AFP 2B held $4,250.88 retainage (5% of the $85,017.50 regular amount);
//      AFP 3R held and released nothing (Nancy's retainage calculation tab).
//   6. CO-04 is $67,458.31, as billed and in QB.
//   7. Held vendors: Phil expects this week's run to clear what is due, so
//      past-due vendor items are dated 10/30.
// Every touched row is backed up to reports/cashflow/ before --apply writes.
//
// Output: reports/cashflow/fix-2026-10-27.md

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { buildProjection } from "@/lib/projection";

const env: Record<string, string> = {};
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const t = l.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
}) as any;

const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const APPLY = process.argv.includes("--apply");
const TODAY = new Date("2026-10-27T12:00:00");
const RUN_DATE = "2026-10-30"; // this week's payment run
const SOURCE = "Controller answers 2026-10-23, Phil 2026-10-27";

const all = async (q: any) => { const { data, error } = await q; if (error) throw new Error(error.message); return data as any[]; };
const n = (v: any) => Number(v ?? 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const usd = (v: number) => (v < 0 ? "-$" : "$") + Math.abs(Math.round(v)).toLocaleString("en-US");
const usd2 = (v: number) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Op = {
  fix: string; table: string; action: "update" | "insert" | "delete";
  id?: string; set?: Record<string, any>; row?: Record<string, any>; what: string;
};
const ops: Op[] = [];
const update = (fix: string, table: string, id: string, set: Record<string, any>, what: string) => ops.push({ fix, table, action: "update", id, set, what });

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------
const pos = await all(sb.from("procurement_orders").select("*").eq("project_id", PID));
const poPay = await all(sb.from("procurement_payments").select("*").in("procurement_order_id", pos.map((p) => p.id)));
const codes = await all(sb.from("cost_codes").select("*, subcontractors(payment_terms_days, retainage_pct)").eq("project_id", PID));
const forecasts = await all(sb.from("cost_forecasts").select("*").in("cost_code_id", codes.map((c) => c.id)));
const payApps = await all(sb.from("pay_applications").select("*").eq("project_id", PID));
const cos = await all(sb.from("change_orders").select("*").eq("project_id", PID));
const lines = await all(sb.from("billing_lines").select("*").eq("project_id", PID));
const txns = await all(sb.from("cost_transactions").select("*").eq("project_id", PID));

const code = (c: string) => { const x = codes.find((k) => k.code === c); if (!x) throw new Error(`no code ${c}`); return x; };
const po = (num: string) => { const x = pos.find((p) => p.po_number.endsWith(num)); if (!x) throw new Error(`no PO ${num}`); return x; };
const pay = (poNum: string, milestone: RegExp) => {
  const x = poPay.filter((p) => p.procurement_order_id === po(poNum).id && milestone.test(p.milestone_name));
  if (x.length !== 1) throw new Error(`${poNum} ${milestone}: ${x.length} rows`);
  return x[0];
};

// ---- 1. Deposits that were never paid -------------------------------------
for (const [poNum, vendor] of [["PO-017", "GroundWork"], ["P-016", "Power Factors"], ["PO-018", "GridPower"]]) {
  const d = pay(poNum, /^Deposit$/);
  if (!d.paid_at) continue;
  update("1 Deposits", "procurement_payments", d.id,
    { paid_at: null, paid_amount: null, expected_date: RUN_DATE, notes: `Never paid - no payment in QB on any account (${SOURCE}). Was marked paid ${d.paid_at}.` },
    `${vendor} ${poNum} deposit ${usd2(n(d.amount))}: paid ${d.paid_at} -> unpaid, owed now (dated ${RUN_DATE})`);
}

// ---- 2. Insurance ----------------------------------------------------------
const INSURANCE = 112675.31;
const V = code("SSC V");
const vRows = forecasts.filter((f) => f.cost_code_id === V.id);
if (!vRows.some((f) => Math.abs(n(f.actual_amount) - INSURANCE) < 0.01)) {
  for (const f of vRows.filter((f) => !n(f.actual_amount)))
    ops.push({ fix: "2 Insurance", table: "cost_forecasts", action: "delete", id: f.id, what: `SSC V plan ${f.period_month.slice(0, 7)} ${usd2(n(f.planned_amount))} removed - budget is used up` });
  ops.push({ fix: "2 Insurance", table: "cost_forecasts", action: "insert",
    row: { cost_code_id: V.id, period_month: "2026-10-01", planned_amount: 0, actual_amount: INSURANCE, notes: `Sweet Springs excess E&O + umbrella, 2025 ($69,594.31) and 2026 ($43,081.00) policy years, paid by TVIG, not yet posted in QB (${SOURCE})` },
    what: `SSC V Insurance: ${usd2(INSURANCE)} actual, Oct 2026` });
  for (const basis of ["cash", "accrual"])
    ops.push({ fix: "2 Insurance", table: "cost_transactions", action: "insert",
      row: { project_id: PID, cost_code_id: V.id, basis, txn_date: "2026-10-27", qb_type: "Manual", qb_num: null, vendor: "TVIG, Inc. (Vendor)",
        qb_item: "SSC V Insurance - Sweet Springs excess E&O + umbrella 2025/2026 (not yet in QB)", paid_from: null, amount: INSURANCE,
        qb_cutoff: "2026-09-30", source_file: "Controller memo 2026-10-23" },
      what: `Cost detail row (${basis}) for the insurance, so the cost tiles show it` });
}

// ---- 3. Maddox storage -> CO-01 -------------------------------------------
const CO1 = code("CO-01");
const storage = txns.filter((t) => /MADDOX/i.test(t.vendor ?? "") && Math.abs(n(t.amount) - 500) < 0.01 && t.cost_code_id !== CO1.id);
const moveBy = new Map<string, Map<string, number>>(); // code id -> month -> amount (cash only)
for (const t of storage) {
  update("3 Maddox storage", "cost_transactions", t.id, { cost_code_id: CO1.id },
    `Maddox ${t.qb_num ?? ""} $500 (${t.basis} ${t.txn_date}) ${codes.find((c) => c.id === t.cost_code_id)?.code} -> CO-01`);
  if (t.basis !== "cash") continue;
  const m = t.txn_date.slice(0, 7) + "-01";
  const x = moveBy.get(t.cost_code_id) ?? new Map(); x.set(m, (x.get(m) ?? 0) + 500); moveBy.set(t.cost_code_id, x);
}
const intoCo1 = new Map<string, number>();
for (const [cid, months] of moveBy) for (const [m, v] of months) {
  const f = forecasts.find((x) => x.cost_code_id === cid && x.period_month === m);
  if (!f || n(f.actual_amount) < v - 0.01) throw new Error(`no actual to move on ${cid} ${m}`);
  const left = r2(n(f.actual_amount) - v);
  if (left === 0 && !n(f.planned_amount)) ops.push({ fix: "3 Maddox storage", table: "cost_forecasts", action: "delete", id: f.id, what: `${codes.find((c) => c.id === cid).code} ${m.slice(0, 7)} actual ${usd2(v)} -> CO-01` });
  else update("3 Maddox storage", "cost_forecasts", f.id, { actual_amount: left }, `${codes.find((c) => c.id === cid).code} ${m.slice(0, 7)} actual ${usd2(n(f.actual_amount))} -> ${usd2(left)}`);
  intoCo1.set(m, (intoCo1.get(m) ?? 0) + v);
}
for (const [m, v] of intoCo1) {
  const f = forecasts.find((x) => x.cost_code_id === CO1.id && x.period_month === m);
  if (f) update("3 Maddox storage", "cost_forecasts", f.id, { actual_amount: r2(n(f.actual_amount) + v) }, `CO-01 ${m.slice(0, 7)} actual ${usd2(n(f.actual_amount))} -> ${usd2(n(f.actual_amount) + v)}`);
  else ops.push({ fix: "3 Maddox storage", table: "cost_forecasts", action: "insert", row: { cost_code_id: CO1.id, period_month: m, planned_amount: 0, actual_amount: v, notes: `Maddox storage moved to CO-01 (${SOURCE})` }, what: `CO-01 ${m.slice(0, 7)} actual ${usd2(v)} (new)` });
}

// ---- 4. CAB Solar PO-022 ----------------------------------------------------
const cab = po("PO-022");
if (Math.abs(n(cab.total_value) - 7950.49) > 0.005) update("4 CAB Solar", "procurement_orders", cab.id, { total_value: 7950.49 },
  `PO-022 material ${usd2(n(cab.total_value))} -> $7,950.49 (+ $1,010 freight = $8,960.49)`);
const cabRest = poPay.find((p) => p.procurement_order_id === cab.id && p.milestone_name === "Delivery" && !p.paid_at);
if (cabRest) {
  update("4 CAB Solar", "procurement_payments", cabRest.id,
    { milestone_name: "Invoice COM147583 balance", trigger_event: "Invoice", amount: 3975.24, expected_date: RUN_DATE, notes: `CAB bills as "Cambria County Assoc." in QB; due 9/24 (${SOURCE})` },
    `CAB ${usd2(n(cabRest.amount))} due ${cabRest.expected_date} -> invoice balance $3,975.24 due ${RUN_DATE}`);
  ops.push({ fix: "4 CAB Solar", table: "procurement_payments", action: "insert",
    row: { procurement_order_id: cab.id, milestone_name: "Freight (not billed yet)", trigger_event: "Delivery to site", expected_date: cabRest.expected_date, amount: 1010, net_terms_days: 30, side: "vendor", notes: `On the PO, not yet invoiced (${SOURCE})` },
    what: `CAB freight $1,010, not billed yet, kept at ${cabRest.expected_date}` });
}

// ---- 5. AFP 2B / 3R retainage ---------------------------------------------
const app = (num: string) => payApps.find((a) => a.app_number === num)!;
const b2 = app("AFP 2B"), r3 = app("AFP 3R");
if (n(b2.total_retainage) !== 4250.88) update("5 Retainage", "pay_applications", b2.id, { total_retainage: 4250.88, amount_due: r2(n(b2.total_completed) - 4250.88) },
  `AFP 2B retainage ${usd2(n(b2.total_retainage))} -> $4,250.88; amount due ${usd2(n(b2.amount_due))} -> ${usd2(n(b2.total_completed) - 4250.88)}`);
if (n(r3.total_retainage) !== 0) update("5 Retainage", "pay_applications", r3.id, { total_retainage: 0 },
  `AFP 3R retainage ${usd2(n(r3.total_retainage))} (a release) -> $0; amount due stays ${usd2(n(r3.amount_due))}`);

// ---- 6. CO-04 -------------------------------------------------------------
const co4 = cos.find((c) => c.co_number === "CO-04")!;
if (n(co4.co_value) !== 67458.31) {
  update("6 CO-04", "change_orders", co4.id, { co_value: 67458.31, description: String(co4.description).replace("$67,458.34", "$67,458.31") }, `CO-04 value ${usd2(n(co4.co_value))} -> $67,458.31`);
  const line = lines.find((l) => l.change_order_id === co4.id);
  if (line && n(line.scheduled_value) !== 67458.31) update("6 CO-04", "billing_lines", line.id, { scheduled_value: 67458.31 }, `G703 line ${line.item_number} scheduled value ${usd2(n(line.scheduled_value))} -> $67,458.31`);
}

// ---- 7. Held vendors: past due -> this week's run -------------------------
for (const p of poPay.filter((p) => !p.paid_at && p.expected_date && p.expected_date < TODAY.toISOString().slice(0, 10) && p.side !== "owner")) {
  if (ops.some((o) => o.id === p.id)) continue;
  update("7 Payment run", "procurement_payments", p.id, { expected_date: RUN_DATE },
    `${pos.find((x) => x.id === p.procurement_order_id).vendor_name} "${p.milestone_name}" ${usd2(n(p.amount))}: ${p.expected_date} -> ${RUN_DATE}`);
}

// ---------------------------------------------------------------------------
// Projection before and after. The "after" client serves the live reads with
// the ops applied in memory.
// ---------------------------------------------------------------------------
const touchedCodes = new Set<string>([...ops.filter((o) => o.table === "cost_forecasts").map((o) => o.row?.cost_code_id ?? forecasts.find((f) => f.id === o.id)?.cost_code_id)]);
const forecastsAfter = forecasts
  .filter((f) => !ops.some((o) => o.table === "cost_forecasts" && o.action === "delete" && o.id === f.id))
  .map((f) => ({ ...f, ...(ops.find((o) => o.table === "cost_forecasts" && o.action === "update" && o.id === f.id)?.set ?? {}) }))
  .concat(ops.filter((o) => o.table === "cost_forecasts" && o.action === "insert").map((o) => o.row as any));
const codeObj = (id: string) => { const c = codes.find((k) => k.id === id); return { ...c, subcontractors: c.subcontractors ?? null }; };

function patch(table: string, data: any) {
  if (!Array.isArray(data)) return data;
  if (table === "cost_forecasts") {
    const keep = data.filter((r: any) => !touchedCodes.has(r.cost_codes?.id));
    return keep.concat(forecastsAfter.filter((f) => touchedCodes.has(f.cost_code_id)).map((f) => ({ period_month: f.period_month, planned_amount: f.planned_amount, actual_amount: f.actual_amount, cost_codes: codeObj(f.cost_code_id) })));
  }
  let out = data
    .filter((r: any) => !ops.some((o) => o.table === table && o.action === "delete" && o.id === r.id))
    .map((r: any) => { const o = ops.filter((o) => o.table === table && o.action === "update" && o.id === r.id); return o.length ? Object.assign({ ...r }, ...o.map((x) => x.set)) : r; });
  for (const o of ops.filter((o) => o.table === table && o.action === "insert")) {
    const row: any = { id: "new-" + Math.random(), paid_at: null, paid_amount: null, procurement_order_line_id: null, sort_order: null, pct_of_total: null, ...o.row };
    if (table === "procurement_payments") row.procurement_orders = { project_id: PID, po_number: pos.find((p) => p.id === row.procurement_order_id).po_number };
    out.push(row);
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

const before = await buildProjection(sb, PID, { today: TODAY, monthsAhead: 9 });
const after = await buildProjection(patched, PID, { today: TODAY, monthsAhead: 9 });

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const L: string[] = [];
L.push(`# Sweet Springs - Controller answers, ${APPLY ? "APPLIED" : "DRY RUN"}`, "");
L.push(`Run ${new Date().toISOString().slice(0, 16).replace("T", " ")}. ${APPLY ? "Written to the live database; backup beside this report." : "**Nothing was written.**"}`, "");
L.push("## Summary", "", "| # | Measure | Before | After | Change |", "|---|---|---|---|---|");
const tot = (p: any) => p.totals;
const low = (p: any) => p.rows.filter((r: any) => r.month >= "2026-10-01").reduce((a: any, r: any) => (r.cumulativeCash < a.cumulativeCash ? r : a));
const lb = low(before), la = low(after);
const rowsOf: [string, number, number][] = [
  ["Margin at completion", tot(before).margin, tot(after).margin],
  ["Cash in, whole job", tot(before).cashIn, tot(after).cashIn],
  ["Cash out, whole job", tot(before).cashOut, tot(after).cashOut],
  ["Cash net, whole job", tot(before).cashNet, tot(after).cashNet],
];
rowsOf.forEach(([k, b, a], i) => L.push(`| ${i + 1} | ${k} | ${usd(b)} | ${usd(a)} | ${usd(a - b)} |`));
L.push(`| ${rowsOf.length + 1} | Lowest point ahead | ${lb.label}: ${usd(lb.cumulativeCash)} | ${la.label}: ${usd(la.cumulativeCash)} | ${usd(la.cumulativeCash - lb.cumulativeCash)} |`, "");

L.push("## Changes", "", "| # | Fix | Table | Change |", "|---|---|---|---|");
ops.forEach((o, i) => L.push(`| ${i + 1} | ${o.fix} | ${o.table} | ${o.what} |`));
L.push("");

L.push("## Monthly cash, before -> after", "", "| Month | Cash in | Cash out | Net | Cumulative before | Cumulative after |", "|---|---|---|---|---|---|");
for (const r of after.rows.filter((r: any) => r.month >= "2026-07-01")) {
  const b = before.rows.find((x: any) => x.month === r.month);
  L.push(`| ${r.label} | ${usd(r.cashIn)} | ${usd(r.totalCashOut)} | ${usd(r.netCash)} | ${usd(b?.cumulativeCash ?? 0)} | ${usd(r.cumulativeCash)} |`);
}
L.push("");
mkdirSync("reports/cashflow", { recursive: true });
writeFileSync("reports/cashflow/fix-2026-10-27.md", L.join("\n"));
console.log(L.join("\n"));

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
if (APPLY) {
  const backup: Record<string, any[]> = {};
  for (const t of new Set(ops.map((o) => o.table))) {
    const ids = ops.filter((o) => o.table === t && o.id).map((o) => o.id!);
    backup[t] = ids.length ? await all(sb.from(t).select("*").in("id", ids)) : [];
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(`reports/cashflow/fix-2026-10-27-backup-${stamp}.json`, JSON.stringify({ ops, backup }, null, 2));
  for (const o of ops) {
    const q = o.action === "update" ? sb.from(o.table).update(o.set).eq("id", o.id)
      : o.action === "delete" ? sb.from(o.table).delete().eq("id", o.id)
      : sb.from(o.table).insert(o.row);
    const r = await q;
    if (r.error) throw new Error(`${o.fix} ${o.table} ${o.action}: ${r.error.message}`);
  }
  console.log(`\nApplied ${ops.length} changes. Backup: reports/cashflow/fix-2026-10-27-backup-${stamp}.json`);
}
