// Sweet Springs - Oct 27 payment run + Lumina hold. DRY RUN unless --apply.
//
//   npx tsx scripts/cashflow/fix-2026-10-27-payment-run.mts [--apply]
//
// Phil 2026-10-27: the bills on the Controller's 10/26 payables list that he
// released go out today; Lumina App 1 is held while the project is paused.
// Lumina stays in the forecast (the money is still owed) on a placeholder
// date, guaranteed substantial completion, so October no longer shows it.
// Cost-code bills paid today move from plan to actual in October. The HUB
// bond ($31,224) is left as owed: HUB shows it paid in August though it never
// cleared, so it is not recorded as paid until the Controller confirms.

import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env: Record<string, string> = {};
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const t = l.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) as any;
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const APPLY = process.argv.includes("--apply");
const PAID = "2026-10-27";
const OCT = "2026-10-01";
const HOLD_DATE = "2027-01-21";
const all = async (q: any) => { const { data, error } = await q; if (error) throw new Error(error.message); return data as any[]; };
const n = (v: any) => Number(v ?? 0);
const r2 = (v: number) => Math.round(v * 100) / 100;

type Op = { table: string; action: "update" | "insert"; id?: string; set?: any; row?: any; what: string };
const ops: Op[] = [];

const subs = await all(sb.from("subcontractors").select("id, company_name").eq("project_id", PID));
const apps = await all(sb.from("sub_pay_apps").select("*").eq("project_id", PID));
const subApp = (name: RegExp, num: number, status: string) => {
  const s = subs.find((x) => name.test(x.company_name));
  return apps.find((a) => a.subcontractor_id === s.id && a.app_number === num && a.status === status);
};

const lum = subApp(/Lumina/, 1, "approved");
if (lum && lum.due_date !== HOLD_DATE) ops.push({ table: "sub_pay_apps", action: "update", id: lum.id,
  set: { due_date: HOLD_DATE, notes: `ON HOLD - project paused (Phil ${PAID}). Due date is a placeholder (substantial completion), not a commitment. Contractual due date was ${lum.due_date}.` },
  what: `Lumina App 1 $${n(lum.approved_amount_due ?? lum.amount_due).toLocaleString()} held: due ${lum.due_date} -> ${HOLD_DATE} placeholder` });

const pyr2 = subApp(/Pyramid/, 2, "approved");
if (pyr2) ops.push({ table: "sub_pay_apps", action: "update", id: pyr2.id, set: { status: "paid", paid_at: PAID },
  what: `Pyramid App 2 $${n(pyr2.approved_amount_due).toLocaleString()} -> paid ${PAID} (QB 10/26 shows only its retainage open)` });

// Cost-code bills released today (Controller's 10/26 payables list).
// Hirschler (SSC B, $3,526.50) and United Rentals (SSC H, $3,726.11) are NOT
// here: their October rows still carry plan, and the engine reads a row's
// actual in place of its plan, so a partial actual would drop the rest of the
// month's plan. They are inside October's plan already - same cash.
const BILLS: [string, string, number][] = [
  ["SSC A", "AMH Holdings 1207", 13725],
  ["SSC G", "HUB International 4610907", 750],
  ["SSC I", "Pure Power PPE-00048021, PPE-00047564", 68.75 + 3500],
  ["SSC J", "Kimley Horn 113761000-0826, Foresight 9208", 1665.76 + 900],
  ["CO-01", "Maddox storage Q134209-7", 500],
];
const codes = await all(sb.from("cost_codes").select("id, code").eq("project_id", PID));
for (const [code, what, amt] of BILLS) {
  const c = codes.find((x) => x.code === code);
  const f = (await all(sb.from("cost_forecasts").select("*").eq("cost_code_id", c.id).eq("period_month", OCT)))[0];
  const mark = `Paid ${PAID}: ${what}`;
  if (f && String(f.notes ?? "").includes(mark)) continue;
  if (f) ops.push({ table: "cost_forecasts", action: "update", id: f.id,
    set: { actual_amount: r2(n(f.actual_amount) + amt), planned_amount: r2(Math.max(0, n(f.planned_amount) - amt)), notes: [f.notes, mark].filter(Boolean).join(" | ") },
    what: `${code} Oct: ${what} $${amt.toLocaleString()} paid (plan $${n(f.planned_amount).toLocaleString()} -> $${Math.max(0, r2(n(f.planned_amount) - amt)).toLocaleString()}, actual $${n(f.actual_amount).toLocaleString()} -> $${r2(n(f.actual_amount) + amt).toLocaleString()})` });
  else ops.push({ table: "cost_forecasts", action: "insert", row: { cost_code_id: c.id, period_month: OCT, planned_amount: 0, actual_amount: amt, notes: mark },
    what: `${code} Oct: ${what} $${amt.toLocaleString()} paid (no October plan; new actual)` });
}

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
if (only) ops.splice(0, ops.length, ...ops.filter((o) => new RegExp(only).test(o.what)));
for (const o of ops) console.log(`- ${o.table}: ${o.what}`);
if (!APPLY) { console.log(`\nDRY RUN - ${ops.length} changes, nothing written.`); process.exit(0); }
const backup: Record<string, any[]> = {};
for (const t of new Set(ops.map((o) => o.table))) {
  const ids = ops.filter((o) => o.table === t && o.id).map((o) => o.id!);
  backup[t] = ids.length ? await all(sb.from(t).select("*").in("id", ids)) : [];
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`reports/cashflow/payment-run-2026-10-27-backup-${stamp}.json`, JSON.stringify({ ops, backup }, null, 2));
for (const o of ops) {
  const r = o.action === "update" ? await sb.from(o.table).update(o.set).eq("id", o.id) : await sb.from(o.table).insert(o.row);
  if (r.error) throw new Error(`${o.table}: ${r.error.message}`);
}
console.log(`\nApplied ${ops.length} changes. Backup: reports/cashflow/payment-run-2026-10-27-backup-${stamp}.json`);
