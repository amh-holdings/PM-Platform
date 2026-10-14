// Backfill Sussex AFP 1 from the invoice that went to Dimension, 2026-10-14.
//
// Source: Drive, Mac Mini/Pay Application #01 20260626 (1).pdf - IBT TVIG CT
// JV invoice 202-01, dated 6/26/2026, item 001 "LNTP Execution (10% LNTP
// Agreement value)" $29,038.82. Billed outside the platform; Phil confirms it
// is the only Sussex pay app so far and that it is still OPEN (unpaid).
//
// The invoice wins over the SOV, as on Sweet Springs: 1.01.1 is $29,038.72 on
// the Exhibit E load and the invoice reads .82, so the line shows 10 cents
// over until somebody says which is right. LNTP carries no retainage
// (Exhibit E Note 3, 0071).
//
// Pay app, billing entry and pay_application_lines snapshot are written the
// way backfill-afp-10-11.mjs and createPayApplication() write them. Status
// "submitted" with no paid date, so the projection reads it as billed and
// expects the cash on Net 30. Idempotent; dry run by default, --apply writes.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";
const APP = {
  app_number: "AFP 1",
  period_start: "2026-06-01",
  period_end: "2026-06-30",
  submitted_at: "2026-06-26T12:00:00+00:00",
  item: "1.01.1",
  amount: 29038.82,
  notes: "Invoice 202-01 dated 6/26/2026, billed outside the platform. LNTP Execution (10% LNTP Agreement value). Open - not paid as of 2026-10-14.",
};

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
const r2 = (n: number) => Math.round(n * 100) / 100;

const { data: lines, error: lErr } = await sb
  .from("billing_lines")
  .select("id, item_number, description, scheduled_value, sort_order, retainage_exempt")
  .eq("project_id", PID)
  .order("sort_order", { ascending: true, nullsFirst: false })
  .order("item_number");
if (lErr) throw lErr;
const line = lines!.find((l) => l.item_number === APP.item);
if (!line) throw new Error(`no SOV line ${APP.item}`);
const ret = line.retainage_exempt ? 0 : r2(APP.amount * 0.05);
console.log(`${APP.app_number} ${APP.item} ${line.description}: $${APP.amount} (SOV $${line.scheduled_value}, ${r2(APP.amount - Number(line.scheduled_value))} over), retainage $${ret}`);

if (!APPLY) {
  console.log("Dry run. Pass --apply to write.");
  process.exit(0);
}

const { data: found } = await sb.from("pay_applications").select("id").eq("project_id", PID).eq("app_number", APP.app_number).maybeSingle();
const doc = {
  period_start: APP.period_start,
  period_end: APP.period_end,
  status: "submitted",
  submitted_at: APP.submitted_at,
  paid_at: null,
  previous_billings: 0,
  total_completed: APP.amount,
  total_retainage: ret,
  amount_due: r2(APP.amount - ret),
  notes: APP.notes,
};
let appId = found?.id as string | undefined;
if (appId) {
  const { error } = await sb.from("pay_applications").update(doc).eq("id", appId);
  if (error) throw error;
} else {
  const { data, error } = await sb.from("pay_applications").insert({ project_id: PID, app_number: APP.app_number, ...doc }).select("id").single();
  if (error) throw error;
  appId = data.id as string;
}

const entry = {
  planned_amount: 0,
  actual_amount: APP.amount,
  retainage_amount: ret,
  pay_application_id: appId,
  status: "submitted",
  afp_number: APP.app_number,
  submitted_at: APP.submitted_at,
  notes: "Backfilled from invoice 202-01 (AFP 1).",
};
const { data: ex } = await sb.from("billing_entries").select("id").eq("billing_line_id", line.id).eq("period_month", APP.period_start).maybeSingle();
const { error: eErr } = ex
  ? await sb.from("billing_entries").update(entry).eq("id", ex.id)
  : await sb.from("billing_entries").insert({ billing_line_id: line.id, period_month: APP.period_start, ...entry });
if (eErr) throw eErr;

// G703 snapshot. First application, so nothing is previous.
const inserts = lines!.map((l, i) => {
  const sched = Number(l.scheduled_value ?? 0);
  const cur = l.id === line.id ? APP.amount : 0;
  return {
    pay_application_id: appId,
    billing_line_id: l.id,
    item_number: l.item_number,
    description: l.description,
    scheduled_value: sched,
    work_completed_previous: 0,
    work_completed_this_period: cur,
    materials_stored: 0,
    total_completed_and_stored: cur,
    pct_complete: sched > 0 ? r2(Math.min(100, (cur / sched) * 100)) : 0,
    balance_to_finish: r2(sched - cur),
    retainage_amount: l.id === line.id ? ret : 0,
    sort_order: l.sort_order ?? i,
  };
});
const { error: dErr } = await sb.from("pay_application_lines").delete().eq("pay_application_id", appId);
if (dErr) throw dErr;
const { error: iErr } = await sb.from("pay_application_lines").insert(inserts as never);
if (iErr) throw iErr;
console.log(`Written: ${APP.app_number} (${appId}), 1 billing entry, ${inserts.length} G703 lines.`);
