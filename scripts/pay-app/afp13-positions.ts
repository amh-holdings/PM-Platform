/**
 * What AFP 13 should say on the three lines Dimension commented on.
 *
 * Christian Mechwart, 2026-09-28, on the September invoice:
 *   POI Procurement  - redacted PO to Egnyte, and why 66%?
 *   Fencing/SWPPP    - recommend lower, fence is 0% on the commodity tracker
 *   Civil Roads      - invoice percentage needs to match the commodity tracker
 *
 * Every number here comes from the app's own libraries rather than a
 * spreadsheet: the rule of credit on the line, the PO payment milestones, and
 * the commodity tracker's own confirmed production. That is the point - a
 * figure we can show the working for is the only kind worth arguing about.
 *
 * Evidence stops at the project's billing cutoff, so running this on the 29th
 * answers the same question it would have answered on the 20th. Sweet Springs
 * bills to the 20th; see db/migrations/0067.
 *
 * Read only.
 *
 * Run: npx tsx scripts/pay-app/afp13-positions.ts [2026-09-01]
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { applyRuleOfCredit, parseRuleOfCredit } from "@/lib/rule-of-credit";
import { estimateProcurementProgress } from "@/lib/progress";
import { scopeByLine } from "@/lib/sov-amendments";
import { progressAsOf } from "@/lib/billing-period";

const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const raw = readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const usd = (n: number) =>
  "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pc = (n: number) => `${(n * 100).toFixed(2)}%`;

async function main() {
  // Sweet Springs bills to the 20th. Evidence stops there however late in the
  // month this is run, or the figures quietly include the next application's
  // work. See db/migrations/0067.
  const { data: project } = await sb.from("projects").select("*").eq("id", PID).maybeSingle();
  const cutoffDay =
    (project as { billing_cutoff_day?: number | null } | null)?.billing_cutoff_day ?? null;
  const PERIOD = process.argv[2] ?? "2026-09-01";
  const asOf = progressAsOf(PERIOD, new Date(), cutoffDay);
  console.log(
    `Period ${PERIOD}  |  evidence as of ${asOf}` +
      (cutoffDay ? `  (cutoff day ${cutoffDay})` : "  (no cutoff set - month end)") +
      "\n",
  );

  const { data: lines } = await sb.from("billing_lines").select("*").eq("project_id", PID);
  const { data: amendments } = await sb
    .from("billing_line_amendments")
    .select("amendment_line_id, base_line_id, amount")
    .eq("project_id", PID);
  const { data: tasks } = await sb
    .from("schedule_tasks")
    .select("wbs_code, task_name, pct_complete, duration_days, start_date, end_date")
    .eq("project_id", PID);
  const { data: totals } = await sb
    .from("v_billing_line_totals")
    .select("billing_line_id, total_billed")
    .eq("project_id", PID);

  const scope = scopeByLine(lines ?? [], amendments ?? []);
  const billed = new Map((totals ?? []).map((t) => [t.billing_line_id, Number(t.total_billed ?? 0)]));
  const byWbs = new Map((tasks ?? []).map((t) => [t.wbs_code, t]));
  const line = (item: string) => (lines ?? []).find((l) => l.item_number === item)!;

  // ---------------- 6.03 Fencing/SWPPP ----------------
  const l603 = line("6.03");
  const sc603 = scope.get(l603.id) ?? 0;
  const b603 = billed.get(l603.id) ?? 0;
  const rule = parseRuleOfCredit((l603 as { rule_of_credit?: unknown }).rule_of_credit);
  console.log(`===== 6.03 Fencing/SWPPP =====`);
  console.log(`scope ${usd(sc603)}   billed to date ${usd(b603)}  (${pc(b603 / sc603)})`);
  if (!rule) {
    console.log("no rule of credit on the line");
  } else {
    const rocTasks = (l603.linked_task_wbs_codes ?? []).map((w: string) => {
      const t = byWbs.get(w);
      return {
        wbsCode: w,
        taskName: t?.task_name ?? w,
        pct: Number(t?.pct_complete ?? 0) / 100,
        durationDays: t?.duration_days ?? null,
      };
    });
    const res = applyRuleOfCredit({ rule, tasks: rocTasks });
    for (const c of res.components) {
      console.log(`  ${c.name.padEnd(8)} weight ${String(c.weightPct).padStart(3)}%  own progress ${pc(c.pct).padStart(8)}  contributes ${pc((c.weightPct / 100) * c.pct).padStart(8)}  (${c.tasks.length} task${c.tasks.length === 1 ? "" : "s"})`);
    }
    const earnedPct = res.pct;
    const earned = sc603 * earnedPct;
    console.log(`  EARNED ${pc(earnedPct)}  =  ${usd(earned)}`);
    console.log(`  this period = earned - billed = ${usd(earned - b603)}`);
    if (earned - b603 < 0) {
      console.log(`  -> bill $0.00 this period. The line sits ${usd(b603 - earned)} above the rule,`);
      console.log(`     which the fence absorbs when 5.1.2 runs (${byWbs.get("5.1.2")?.start_date} to ${byWbs.get("5.1.2")?.end_date}).`);
    }
  }

  // ---------------- 6.02 Civil, Roads ----------------
  const l602 = line("6.02");
  const sc602 = scope.get(l602.id) ?? 0;
  const b602 = billed.get(l602.id) ?? 0;
  console.log(`\n===== 6.02 Civil, Roads and Landscaping =====`);
  console.log(`scope ${usd(sc602)}   billed to date ${usd(b602)}  (${pc(b602 / sc602)})`);
  const { data: commodities } = await sb.from("commodities").select("id, key, label, uom, total_quantity, total_verified").eq("project_id", PID);
  const { data: prod } = await sb.from("daily_production").select("commodity_id, quantity, production_date, confirmed_at").eq("project_id", PID);
  const byC = new Map<string, { qty: number; last: string }>();
  for (const p of prod ?? []) {
    if (!p.confirmed_at) continue;
    if (p.production_date > asOf) continue;
    const b = byC.get(p.commodity_id) ?? { qty: 0, last: "" };
    b.qty += Number(p.quantity ?? 0);
    if (p.production_date > b.last) b.last = p.production_date;
    byC.set(p.commodity_id, b);
  }
  console.log(`  commodity tracker, civil rows:`);
  for (const c of (commodities ?? []).filter((c) => ["civil_work", "site_prep", "road_install", "fencing"].includes(c.key))) {
    const b = byC.get(c.id) ?? { qty: 0, last: "-" };
    const pctOf = c.uom === "pct" ? b.qty / 100 : (Number(c.total_quantity) > 0 ? b.qty / Number(c.total_quantity) : 0);
    console.log(`    ${c.key.padEnd(13)} ${String(b.qty).padStart(8)} ${c.uom.padEnd(5)} = ${pc(pctOf).padStart(8)}  through ${b.last}  ${c.total_verified ? "" : "(total is an unverified placeholder)"}`);
  }
  const civil = (commodities ?? []).find((c) => c.key === "civil_work");
  if (civil) {
    const cw = (byC.get(civil.id)?.qty ?? 0) / 100;
    console.log(`  at the tracker's Civil Work figure: ${usd(sc602 * cw)} earned, this period ${usd(sc602 * cw - b602)}`);
  }

  // ---------------- 5.05 POI Procurement ----------------
  const l505 = line("5.05");
  const sc505 = scope.get(l505.id) ?? 0;
  const b505 = billed.get(l505.id) ?? 0;
  console.log(`\n===== 5.05 POI Procurement =====`);
  console.log(`scope ${usd(sc505)}   billed to date ${usd(b505)}  (${pc(b505 / sc505)})`);
  const poIds: string[] = l505.linked_procurement_order_ids ?? [];
  const { data: pos } = await sb.from("procurement_orders").select("*").in("id", poIds.length ? poIds : ["00000000-0000-0000-0000-000000000000"]);
  const { data: ms } = await sb.from("procurement_payments").select("*").in("procurement_order_id", poIds.length ? poIds : ["00000000-0000-0000-0000-000000000000"]);
  const msByPo = new Map<string, unknown[]>();
  for (const m of ms ?? []) {
    const arr = msByPo.get(m.procurement_order_id) ?? [];
    arr.push(m);
    msByPo.set(m.procurement_order_id, arr);
  }
  const linked = (pos ?? []).map((p) => ({
    po_number: p.po_number,
    vendor_name: p.vendor_name,
    total_value: p.total_value,
    status: p.status,
    signed_at: p.signed_at,
    actual_delivery_date: (p as { actual_delivery_date?: string | null }).actual_delivery_date ?? null,
    milestones: (msByPo.get(p.id) ?? []) as never[],
  }));
  for (const p of linked) {
    console.log(`  ${String(p.po_number).padEnd(20)} ${String(p.vendor_name).slice(0, 24).padEnd(24)} ${usd(Number(p.total_value)).padStart(13)}  signed ${p.signed_at?.slice(0, 10) ?? "-"}  delivered ${p.actual_delivery_date?.slice(0, 10) ?? "-"}  ${(p.milestones ?? []).length} milestone(s)`);
  }
  const est = estimateProcurementProgress({ scheduled_value: sc505 }, linked as never, asOf);
  console.log(`\n  earned by milestone: ${usd(est.earnedValue)}  = ${pc(est.earnedValue / sc505)} of the line`);
  for (const d of est.detail ?? []) console.log(`    ${d}`);
  console.log(`  this period = earned - billed = ${usd(est.earnedValue - b505)}`);
  console.log(`\n  for reference, 66% of the line is ${usd(sc505 * 0.66)}`);
}

main();
