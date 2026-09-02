/**
 * Derive AFP 12's SOV percentages from work actually complete AS OF NOW.
 *
 * Phil's direction 2026-08-20: the application is due today, so the number is
 * whatever is done as of right now. Work that is finished but has not yet had
 * an inspection approved still counts - do not hold billing for the paperwork.
 *
 * Basis: schedule_tasks.pct_complete, which is the platform's current state of
 * each task, mapped to SOV lines through billing_lines.linked_task_wbs_codes.
 * The latest approved daily-report pin is printed alongside as a cross-check so
 * the derivation stays auditable and any gap between the two is visible.
 *
 *   dprs (sub submits, AHC approves)
 *     -> inspections.status='approved', .task_new_pct  [cross-check column]
 *   schedule_tasks.pct_complete                        [billing basis]
 *   billing_lines.linked_task_wbs_codes                [SOV <-> WBS map]
 *
 * Tasks are weighted equally within a line. Run with --apply to rewrite AFP 12.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const APPLY = process.argv.includes("--apply");
const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const r2 = (n) => Math.round(n * 100) / 100;
const RET_PCT = 5, APP = "AFP 12", PSTART = "2026-08-01", PEND = "2026-08-31";
const BILLED = ["on_pay_app", "submitted", "approved", "paid"];

const { data: lines } = await sb.from("billing_lines")
  .select("id,item_number,description,scheduled_value,sort_order,linked_task_wbs_codes")
  .eq("project_id", PID).order("sort_order", { ascending: true, nullsFirst: false }).order("item_number");
const { data: tasks } = await sb.from("schedule_tasks")
  .select("id,wbs_code,task_name,pct_complete,status,status_source").eq("project_id", PID);
const taskByWbs = new Map(tasks.map((t) => [t.wbs_code, t]));
const taskById = new Map(tasks.map((t) => [t.id, t]));
const { data: insp } = await sb.from("inspections")
  .select("status,submitted_at,decided_at,schedule_task_id,task_new_pct")
  .eq("project_id", PID).eq("status", "approved").not("schedule_task_id", "is", null);

// Latest approved pin per task, by REPORT (submitted) date - cross-check only.
const pinByWbs = new Map();
for (const i of [...insp].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) {
  const t = taskById.get(i.schedule_task_id);
  if (t) pinByWbs.set(t.wbs_code, { pct: Number(i.task_new_pct ?? 0), reported: i.submitted_at?.slice(0, 10) });
}

const notes = [];
function derive(item) {
  const l = lines.find((x) => x.item_number === item);
  const wbs = l.linked_task_wbs_codes ?? [];
  const rows = wbs.map((w) => {
    const t = taskByWbs.get(w);
    const pin = pinByWbs.get(w);
    const done = Number(t?.pct_complete ?? 0);
    if (pin && pin.pct !== done)
      notes.push(`${item} / ${w} "${t.task_name}": billing ${done}% complete as of now; latest approved pin (reported ${pin.reported}) was ${pin.pct}%.`);
    if (!pin && done > 0)
      notes.push(`${item} / ${w} "${t.task_name}": billing ${done}% complete as of now; no inspection approved against it yet.`);
    return {
      wbs: w, task: (t?.task_name ?? "(not in schedule)").slice(0, 38),
      status: t?.status ?? "-", "billed %": done,
      "approved pin": pin ? `${pin.pct}% (${pin.reported})` : "none",
    };
  });
  const pct = rows.reduce((s, r) => s + r["billed %"], 0) / (rows.length || 1);
  const sv = Number(l.scheduled_value);
  return { line: l, rows, pct, amount: r2(sv * (pct / 100)) };
}

const civil = derive("6.02");
const swppp = derive("6.03");

console.log("=== 6.02 Civil, Roads and Landscaping - $413,045.92 ===");
console.table(civil.rows);
console.log(`  ${r2(civil.pct)}% across ${civil.rows.length} linked tasks  ->  $${civil.amount.toLocaleString()}\n`);
console.log("=== 6.03 Fencing/SWPPP - $203,835.79 ===");
console.table(swppp.rows);
console.log(`  ${r2(swppp.pct)}% across ${swppp.rows.length} linked tasks  ->  $${swppp.amount.toLocaleString()}\n`);

// 6.01 Mobilization carries no linked_task_wbs_codes - milestone line billed by
// agreement (35% on AFP 11), not measured work. Phil closed it out 2026-08-20.
const MOBILIZATION = 208495.89;
console.log(`=== 6.01 Mobilization ===\n  no linked WBS tasks - milestone line, not measured work.\n  Phil's call: 35% -> 100% = $${MOBILIZATION.toLocaleString()}\n`);

const BILL = [
  { item: "6.01", amount: MOBILIZATION },
  { item: "6.02", amount: civil.amount },
  { item: "6.03", amount: swppp.amount },
];
for (const b of BILL) b.ret = r2(b.amount * (RET_PCT / 100));
const thisPeriod = r2(BILL.reduce((s, b) => s + b.amount, 0));
const retTotal = r2(BILL.reduce((s, b) => s + b.ret, 0));

console.log("=== AFP 12 ===");
console.table(BILL.map((b) => {
  const l = lines.find((x) => x.item_number === b.item); const sv = Number(l.scheduled_value);
  return { item: b.item, desc: l.description.slice(0, 34), scheduled: sv.toLocaleString(), "this period": b.amount.toLocaleString(), pct: `${r2((b.amount / sv) * 100)}%`, retainage: b.ret.toLocaleString() };
}));
console.log(`  total this period $${thisPeriod.toLocaleString()}   retainage $${retTotal.toLocaleString()}   DUE $${r2(thisPeriod - retTotal).toLocaleString()}`);
if (notes.length) { console.log("\n=== basis notes ==="); notes.forEach((f) => console.log(` - ${f}`)); }

if (!APPLY) { console.log("\nDRY RUN - re-run with --apply to rewrite AFP 12."); process.exit(0); }

const { data: app } = await sb.from("pay_applications").select("id").eq("project_id", PID).eq("app_number", APP).single();
const appId = app.id;
for (const b of BILL) {
  const line = lines.find((l) => l.item_number === b.item);
  const { data: ex } = await sb.from("billing_entries").select("id")
    .eq("billing_line_id", line.id).eq("period_month", PSTART).maybeSingle();
  const payload = {
    planned_amount: 0, actual_amount: b.amount, retainage_amount: b.ret,
    pay_application_id: appId, status: "on_pay_app", afp_number: APP,
    notes: b.item === "6.01"
      ? "AFP 12 - mobilization milestone closed out 35% -> 100% (no WBS link, not measured work)."
      : "AFP 12 - work complete as of 2026-08-20 across the linked WBS tasks.",
  };
  const res = ex
    ? await sb.from("billing_entries").update(payload).eq("id", ex.id)
    : await sb.from("billing_entries").insert({ billing_line_id: line.id, period_month: PSTART, ...payload });
  if (res.error) throw new Error(`${b.item}: ${res.error.message}`);
}

const { data: entries } = await sb.from("billing_entries")
  .select("id,billing_line_id,period_month,actual_amount,planned_amount,pay_application_id,status,afp_number")
  .in("billing_line_id", lines.map((l) => l.id));
const prev = new Map(), cur = new Map();
for (const e of entries) {
  const amt = Number(e.actual_amount || 0) > 0 ? Number(e.actual_amount) : Number(e.planned_amount || 0);
  if (amt <= 0) continue;
  if (e.pay_application_id === appId) cur.set(e.billing_line_id, r2((cur.get(e.billing_line_id) ?? 0) + amt));
  else if (e.period_month < PSTART && (!!e.pay_application_id || !!e.afp_number || BILLED.includes(e.status)))
    prev.set(e.billing_line_id, r2((prev.get(e.billing_line_id) ?? 0) + amt));
}
const retByItem = new Map(BILL.map((b) => [b.item, b.ret]));
const inserts = lines.map((l, i) => {
  const p = prev.get(l.id) ?? 0, c = cur.get(l.id) ?? 0;
  const sv = Number(l.scheduled_value ?? 0), tot = r2(p + c);
  return {
    pay_application_id: appId, billing_line_id: l.id, item_number: l.item_number,
    description: l.description, scheduled_value: sv,
    work_completed_previous: p, work_completed_this_period: c, materials_stored: 0,
    total_completed_and_stored: tot,
    pct_complete: sv > 0 ? r2(Math.min(100, (tot / sv) * 100)) : 0,
    balance_to_finish: r2(sv - tot),
    retainage_amount: retByItem.get(l.item_number) ?? 0,
    sort_order: l.sort_order ?? i,
  };
});
await sb.from("pay_application_lines").delete().eq("pay_application_id", appId);
const ins = await sb.from("pay_application_lines").insert(inserts);
if (ins.error) throw new Error(ins.error.message);
const prevTotal = r2(inserts.reduce((s, l) => s + l.work_completed_previous, 0));
const up = await sb.from("pay_applications").update({
  total_completed: thisPeriod, total_retainage: retTotal,
  previous_billings: prevTotal, amount_due: r2(thisPeriod - retTotal),
  notes: `Percentages are work complete as of 2026-08-20 across the linked WBS tasks. 6.02 = ${r2(civil.pct)}% of ${civil.rows.length} tasks; 6.03 = ${r2(swppp.pct)}% of ${swppp.rows.length}. 6.01 mobilization closed out to 100% (milestone line, no WBS link).`,
}).eq("id", appId);
if (up.error) throw new Error(up.error.message);
console.log(`\nAFP 12 rewritten. ${inserts.length} snapshot lines, previous $${prevTotal.toLocaleString()}.`);
