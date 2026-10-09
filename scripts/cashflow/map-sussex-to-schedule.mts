// Put Sussex's cost and billing on the schedule, 2026-10-08.
//
// Procurement placements are Phil's (2026-10-08): switchgear PO and module
// delivery at the start of Electrical, racking delivery and racking material
// at the start of Mechanical - via the zero-day milestones 3.1-3.3, which are
// tied start-to-start to 4.4 / 4.3 (scripts/schedule/add-sussex-procurement-
// milestones-2026-10-08.mts).
//
// The schedule is still being built, so this maps to what exists and says
// where it is using a stand-in. RE-RUN IT after every schedule revision: the
// billing side moves on its own (a line earns in the month its task
// finishes), but cost_forecasts are written amounts and only move when this
// rewrites them.
//
// COST (cost_codes -> cost_forecasts)
//   Each code is spread over the calendar days of the tasks it belongs to,
//   in proportion to the days falling in each month - not evenly over the
//   whole job. "lump" codes land in a single month (bonds at EPC execution,
//   material at delivery). Rows carrying an actual are never touched; only
//   planned-only rows are replaced, and the spread covers estimate minus
//   actuals. $0 codes get no rows.
//   100-1020 Electrical Design is marked commitment_covered: Pure Power's SOV
//   ($96,100) already carries it, and counting both doubles $96K. The $3,000
//   between budget and subcontract becomes margin (Phil, 2026-10-08).
//
// BILLING (billing_lines.linked_task_wbs_codes)
//   Exhibit E is milestone billing, so each line links to ONE task and earns
//   in the month that task finishes. The nine LNTP lines are already linked
//   and are left alone.
//
// Dry run by default; pass --apply to write.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";

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

const DESIGN_TO_IFP = [
  "1.2.1.1", "1.2.1.2", "1.2.1.3", "1.2.1.4",
  "1.2.2.1", "1.2.2.2", "1.2.2.3",
  "1.2.3.1", "1.2.3.2", "1.2.3.3",
];
const IFP = ["1.2.1.4", "1.2.2.3", "1.2.3.3"];
const CONSTRUCTION = ["4.1", "4.2", "4.3", "4.4", "4.5"];

type CostRule = { tasks: string[]; how: "spread" | "lump_start" | "lump_end"; standIn?: string; covered?: boolean };
const COST: Record<string, CostRule> = {
  // LNTP
  "100-1010": { tasks: ["1.2.1.1", "1.2.1.2", "1.2.1.3", "1.2.1.4", "1.2.1.5"], how: "spread" },
  "100-1020": { tasks: ["1.2.3.1", "1.2.3.2", "1.2.3.3", "1.2.3.4"], how: "spread", covered: true },
  "100-1030": { tasks: ["1.2.2.1", "1.2.2.2", "1.2.2.3", "1.2.2.4"], how: "spread" },
  "800-1030": { tasks: DESIGN_TO_IFP, how: "spread" },
  // EPCA - engineering / procurement
  "100-1040": { tasks: IFP, how: "spread", standIn: "IFP packages until permitting has real tasks" },
  "200-1030": { tasks: ["3.2"], how: "lump_end" },
  "200-1050": { tasks: ["4.4"], how: "lump_start", standIn: "start of Electrical until cable has a delivery task" },
  // EPCA - construction
  "300-1010": { tasks: ["4.2"], how: "spread" },
  "300-1020": { tasks: ["4.2"], how: "spread" },
  "300-1030": { tasks: ["4.3"], how: "spread" },
  "300-1040": { tasks: ["4.3"], how: "spread" },
  "300-1050": { tasks: ["4.4"], how: "spread" },
  "300-1060": { tasks: ["4.4"], how: "spread" },
  "300-1080": { tasks: ["4.4", "4.5"], how: "spread" },
  "300-1090": { tasks: ["4.1"], how: "spread" },
  "300-1100": { tasks: ["4.5"], how: "spread" },
  // EPCA - general conditions
  "800-1010": { tasks: CONSTRUCTION, how: "spread" },
  "800-1020": { tasks: CONSTRUCTION, how: "spread" },
  "800-1050": { tasks: CONSTRUCTION, how: "spread" },
  "800-1060": { tasks: CONSTRUCTION, how: "spread" },
  "800-1070": { tasks: CONSTRUCTION, how: "spread" },
  "800-1090": { tasks: CONSTRUCTION, how: "spread" },
  "800-1100": { tasks: CONSTRUCTION, how: "spread" },
  "800-1120": { tasks: CONSTRUCTION, how: "spread" },
  "800-1130": { tasks: CONSTRUCTION, how: "spread" },
  "800-1200": { tasks: CONSTRUCTION, how: "spread" },
  "800-1150": { tasks: ["0.1.3.3"], how: "lump_end" },
  "800-1160": { tasks: ["0.1.3.3"], how: "lump_end" },
};

// [item, task it earns on, stand-in note]
const BILLING: [string, string, string?][] = [
  ["2.00", "0.1.3.3"],
  ["3.00", "LAST_IFC"],
  ["4.00", "4.1", "Mobilization until permit receipt is a task"],
  ["5.02", "3.3"],
  ["5.04", "0.2.2.5"],
  ["5.05", "3.2"],
  ["5.06", "3.1"],
  ["6.01", "4.1"],
  ["6.02", "4.1"],
  ["6.03", "4.2"],
  ["7.01", "4.4"],
  ["7.02", "4.4"],
  ["7.03", "4.5"],
  ["7.04", "4.4"],
  ["8.01", "4.3"],
  ["8.02", "4.3"],
  ["9.00", "4.4", "end of Electrical until Mechanical Completion is a milestone"],
  ["10.00", "4.5", "end of Commissioning until COD is a milestone"],
  ["11.00", "4.5", "end of Commissioning until Substantial Completion is a milestone"],
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86400000;
const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7) + "-01";

const { data: tasks, error: tErr } = await sb
  .from("schedule_tasks")
  .select("wbs_code, task_name, start_date, end_date")
  .eq("project_id", PID);
if (tErr) throw tErr;
const task = new Map((tasks ?? []).map((t) => [t.wbs_code, t]));
// Exhibit E 3.00 earns on the LAST IFC set to finish (Phil, 2026-10-08).
// Resolved per run, so a re-run follows whichever package slips.
const lastIfc = ["1.2.1.5", "1.2.2.4", "1.2.3.4"]
  .map((w) => task.get(w))
  .filter((t): t is NonNullable<typeof t> => !!t?.end_date)
  .sort((a, b) => String(b.end_date).localeCompare(String(a.end_date)))[0];
if (!lastIfc) throw new Error("no dated IFC task");
for (const row of BILLING) if (row[1] === "LAST_IFC") row[1] = lastIfc.wbs_code;
const need = (w: string) => {
  const t = task.get(w);
  if (!t?.start_date || !t?.end_date) throw new Error(`task ${w} missing or undated`);
  return t as { wbs_code: string; task_name: string; start_date: string; end_date: string };
};

/** Days per month across the union of the tasks' date ranges. */
function dayWeights(rule: CostRule): Map<string, number> {
  const w = new Map<string, number>();
  if (rule.how !== "spread") {
    const t = need(rule.tasks[0]);
    w.set(monthOf(d(rule.how === "lump_start" ? t.start_date : t.end_date)), 1);
    return w;
  }
  const days = new Set<number>();
  for (const code of rule.tasks) {
    const t = need(code);
    for (let x = d(t.start_date); x <= d(t.end_date); x += DAY) days.add(x);
  }
  for (const x of days) w.set(monthOf(x), (w.get(monthOf(x)) ?? 0) + 1);
  return w;
}

function spread(amount: number, weights: Map<string, number>): Map<string, number> {
  const months = [...weights.keys()].sort();
  const total = [...weights.values()].reduce((s, n) => s + n, 0);
  const out = new Map<string, number>();
  let left = r2(amount);
  months.forEach((m, i) => {
    const v = i === months.length - 1 ? left : r2((amount * weights.get(m)!) / total);
    out.set(m, v);
    left = r2(left - v);
  });
  return out;
}

// ---------------- COST ----------------
const { data: codes, error: cErr } = await sb
  .from("cost_codes")
  .select("id, code, name, estimated_cost")
  .eq("project_id", PID);
if (cErr) throw cErr;
const { data: existing } = await sb
  .from("cost_forecasts")
  .select("id, cost_code_id, period_month, planned_amount, actual_amount")
  .in("cost_code_id", (codes ?? []).map((c) => c.id));

const plan: { code: (typeof codes)[number]; rule: CostRule; rows: Map<string, number> }[] = [];
for (const c of codes ?? []) {
  const est = Number(c.estimated_cost ?? 0);
  const rule = COST[c.code];
  if (!rule) {
    if (est !== 0) throw new Error(`${c.code} ${c.name} has $${est} and no rule`);
    continue;
  }
  const actual = (existing ?? [])
    .filter((f) => f.cost_code_id === c.id)
    .reduce((s, f) => s + Number(f.actual_amount ?? 0), 0);
  const rows = rule.covered ? new Map() : spread(est - actual, dayWeights(rule));
  plan.push({ code: c, rule, rows });
}

const months = [...new Set(plan.flatMap((p) => [...p.rows.keys()]))].sort();
console.log("COST SPREAD (planned, by month)");
console.table(
  months.map((m) => ({
    month: m.slice(0, 7),
    amount: r2(plan.reduce((s, p) => s + (p.rows.get(m) ?? 0), 0)).toLocaleString("en-US", { minimumFractionDigits: 2 }),
  })),
);
const costTotal = r2(plan.reduce((s, p) => s + [...p.rows.values()].reduce((a, b) => a + b, 0), 0));
console.log(`Cost forecast total $${costTotal.toLocaleString()} (100-1020 carried by Pure Power's SOV instead)`);
for (const p of plan.filter((p) => p.rule.standIn)) console.log(`  stand-in ${p.code.code} ${p.code.name}: ${p.rule.standIn}`);

// ---------------- BILLING ----------------
const { data: lines, error: bErr } = await sb
  .from("billing_lines")
  .select("id, item_number, description, scheduled_value, linked_task_wbs_codes")
  .eq("project_id", PID);
if (bErr) throw bErr;
const byItem = new Map((lines ?? []).map((l) => [l.item_number, l]));
console.log("\nBILLING (earns in the month its task finishes)");
console.table(
  BILLING.map(([item, w, note]) => {
    const l = byItem.get(item);
    if (!l) throw new Error(`no SOV line ${item}`);
    const t = need(w);
    return {
      item,
      value: Number(l.scheduled_value).toLocaleString(),
      task: `${w} ${t.task_name}`.slice(0, 40),
      finishes: t.end_date,
      "stand-in": note ? "yes" : "",
    };
  }),
);
const unmapped = (lines ?? []).filter(
  (l) => Number(l.scheduled_value) > 0 && !(l.linked_task_wbs_codes ?? []).length && !BILLING.some(([i]) => i === l.item_number),
);
if (unmapped.length) throw new Error(`SOV lines with value and no task: ${unmapped.map((l) => l.item_number).join(", ")}`);
for (const [item, , note] of BILLING) if (note) console.log(`  stand-in ${item}: ${note}`);

if (!APPLY) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}

// Construction (300-xxxx) will be subcontracted at Net 30 or longer (Phil,
// 2026-10-08) but has no sub yet, so the code carries the terms (0072). A sub
// linked later overrides them. Skipped until 0072 is applied.
const { data: probe } = await sb.from("cost_codes").select("*").eq("project_id", PID).limit(1);
const hasTerms = !!probe?.length && "payment_terms_days" in probe[0];
if (!hasTerms) console.log("payment_terms_days: migration 0072 not applied - Net 30 skipped. Re-run after applying it.");

for (const p of plan) {
  const { error } = await sb
    .from("cost_codes")
    .update({
      linked_task_wbs_codes: p.rule.tasks,
      commitment_covered: !!p.rule.covered,
      ...(hasTerms ? { payment_terms_days: p.code.code.startsWith("300-") ? 30 : null } : {}),
    })
    .eq("id", p.code.id);
  if (error) throw error;
  const stale = (existing ?? []).filter((f) => f.cost_code_id === p.code.id && Number(f.actual_amount ?? 0) === 0);
  if (stale.length) {
    const { error: dErr } = await sb.from("cost_forecasts").delete().in("id", stale.map((f) => f.id));
    if (dErr) throw dErr;
  }
  const rows = [...p.rows.entries()]
    .filter(([, v]) => v !== 0)
    .map(([m, v]) => ({ cost_code_id: p.code.id, period_month: m, planned_amount: v, actual_amount: 0, notes: "map-sussex-to-schedule" }));
  if (rows.length) {
    const { error: iErr } = await sb.from("cost_forecasts").upsert(rows, { onConflict: "cost_code_id,period_month" });
    if (iErr) throw iErr;
  }
}
for (const [item, w] of BILLING) {
  const { error } = await sb.from("billing_lines").update({ linked_task_wbs_codes: [w] }).eq("id", byItem.get(item)!.id);
  if (error) throw error;
}
console.log("\nWrote cost forecasts and billing links.");
