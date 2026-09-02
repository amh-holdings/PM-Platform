/**
 * Check which db/migrations/*.sql are actually live, by probing for the
 * artifact each one creates. Migrations are hand-applied in the Supabase SQL
 * editor, so the file existing proves nothing.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// [migration, table, column]  - column null means "table must exist"
const PROBES = [
  ["0005_schedule_tasks", "schedule_tasks", null],
  ["0006_billing_forecast", "billing_entries", "planned_amount"],
  ["0009_dprs_and_lifecycle", "dprs", null],
  ["0010_pay_applications", "pay_applications", null],
  ["0011_procurement", "procurement_orders", null],
  ["0012_cash_in_month", "billing_entries", "cash_in_month"],
  ["0016_billing_line_procurement_link", "billing_lines", "linked_procurement_order_ids"],
  ["0017_procurement_signed_status", "procurement_orders", "signed_at"],
  ["0019_po_billing_allocations", "procurement_order_billing_allocations", null],
  ["0020_change_order_cost_profit", "change_orders", "cost_amount"],
  ["0021_qaqc_inspections", "inspections", null],
  ["0022_field_reports", "inspections", "dpr_id"],
  ["0022_field_reports (origin)", "inspections", "origin"],
  ["0023_cm_daily_logs", "cm_daily_logs", null],
  ["0023_inspection_wbs", "inspections", "schedule_task_id"],
  ["0024_inspection_task_progress", "inspections", "task_new_pct"],
  ["0025_dpr_equipment_active", "dprs", "equipment_on_site"],
  ["0030_scope_sub_projects", "subcontractors", null],
  ["0031_cm_daily_log_status", "cm_daily_logs", "status"],
  ["0032_schedule_baseline", "schedule_tasks", "baseline_start"],
  ["0033_schedule_engine_phase1", "schedule_tasks", "date_constraint_type"],
  ["0034_schedule_constraint_log", "schedule_constraints", null],
  ["0035_commodity_tracking", "commodities", null],
  ["0035_commodity_tracking (prod)", "daily_production", null],
  ["0036_daily_production_phil_only", "daily_production", "entered_by"],
  ["0037_afp_hardening (retainage)", "pay_applications", "retainage_pct"],
  ["0037_afp_hardening (sov)", "commodities", "contract_sov_item"],
  ["0038_sub_billing", "sub_pay_apps", null],
  ["0039_sub_dpr_drafts", "dprs", "draft_payload"],
  ["0039_sub_dpr_drafts (updated_at)", "dprs", "updated_at"],
  ["0040_production_proposals", "daily_production", "confirmed_at"],
  ["0041_weekly_progress_reports", "weekly_progress_reports", null],
  ["0042_weekly_report_safety_and_photos", "weekly_progress_reports", "safety_summary"],
  ["0043_weekly_report_photo_selection", "weekly_progress_reports", "photo_keys"],
  ["0045_monthly_manpower_report", "monthly_manpower_reports", null],
  ["0045_monthly_manpower_report (cm hours)", "cm_daily_logs", "ahc_man_hours"],
];

// 0029 (RLS policies) and 0044 (a data update plus a dropped index) leave no
// artifact PostgREST can see. Both are written to be safe to re-run, so the
// answer for them is always "run it", not "probe it".
const UNPROBEABLE = [
  ["0029_sub_read_schedule_and_subs", "SELECT policies for the sub roles"],
  ["0044_production_no_confirmation_gate", "backfill + drop index"],
];

const out = [];
for (const [name, table, col] of PROBES) {
  const r = await sb.from(table).select(col ?? "*").limit(1);
  const live = !r.error;
  out.push({ migration: name, probe: col ? `${table}.${col}` : `table ${table}`, live: live ? "LIVE" : "*** MISSING ***" });
}
console.table(out);
const missing = out.filter((o) => o.live !== "LIVE");
console.log(missing.length ? `\n${missing.length} unapplied:` : "\nEverything probed is live.");
missing.forEach((m) => console.log(`  - ${m.migration}  (${m.probe})`));

// 0044 has one observable consequence even though the migration itself does
// not: no daily_production row should be left unconfirmed once it has run.
const un = await sb
  .from("daily_production")
  .select("id", { count: "exact", head: true })
  .is("confirmed_at", null);
console.log(
  un.error
    ? `\ndaily_production unconfirmed: could not read (${un.error.message})`
    : `\ndaily_production rows still unconfirmed: ${un.count} ${
        un.count === 0 ? "(consistent with 0044 having run)" : "(0044 has NOT run)"
      }`,
);

console.log("\nNot probeable from here, safe to re-run either way:");
UNPROBEABLE.forEach(([n, what]) => console.log(`  - ${n}  (${what})`));
