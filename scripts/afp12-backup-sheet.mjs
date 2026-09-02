/**
 * AFP 12 backup / substantiation sheet for Dimension.
 *
 * The percentages on the application come from what the platform shows as
 * complete, and that completion came through the daily reports. This renders
 * the audit trail behind every dollar: SOV line -> linked WBS tasks -> percent
 * complete shown in the app -> the approved report that put it there.
 *
 * Writes reports/AFP-12-backup.html. Open and print to PDF to attach to the
 * pay application package.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const AS_OF = process.argv[2] ?? "2026-08-20";
const money = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const { data: app } = await sb.from("pay_applications").select("*").eq("project_id", PID).eq("app_number", "AFP 12").single();
const { data: palines } = await sb.from("pay_application_lines").select("*").eq("pay_application_id", app.id);
const { data: lines } = await sb.from("billing_lines")
  .select("item_number,description,scheduled_value,linked_task_wbs_codes").eq("project_id", PID);
const { data: tasks } = await sb.from("schedule_tasks")
  .select("id,wbs_code,task_name,status,pct_complete,status_source").eq("project_id", PID);
const taskByWbs = new Map(tasks.map((t) => [t.wbs_code, t]));
const taskById = new Map(tasks.map((t) => [t.id, t]));
const { data: insp } = await sb.from("inspections")
  .select("status,submitted_at,decided_at,schedule_task_id,task_new_pct,inspector_name")
  .eq("project_id", PID).eq("status", "approved").not("schedule_task_id", "is", null);
const pins = new Map();
for (const i of [...insp].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) {
  const t = taskById.get(i.schedule_task_id);
  if (t) pins.set(t.wbs_code, i);
}
const { data: dprs } = await sb.from("dprs").select("report_date,status,crew_count,work_narrative")
  .eq("project_id", PID).eq("status", "approved").order("report_date");

const billed = palines.filter((r) => Number(r.work_completed_this_period) > 0)
  .sort((a, b) => a.item_number.localeCompare(b.item_number));

let sections = "";
for (const r of billed) {
  const bl = lines.find((l) => l.item_number === r.item_number);
  const wbs = bl?.linked_task_wbs_codes ?? [];
  const sv = Number(r.scheduled_value);
  const amt = Number(r.work_completed_this_period);
  if (!wbs.length) {
    sections += `<section><h3>${esc(r.item_number)} &mdash; ${esc(r.description)}</h3>
      <p class="basis">Milestone line. Not measured work and carries no linked schedule activities; billed by agreement against the mobilization milestone. Prior applications billed 35% (AFP 11); this application closes the line out.</p>
      <table><tr><th>Scheduled value</th><td class="n">${money(sv)}</td></tr>
      <tr><th>Previously billed</th><td class="n">${money(r.work_completed_previous)}</td></tr>
      <tr><th class="hi">This application</th><td class="n hi">${money(amt)}</td></tr>
      <tr><th>Complete to date</th><td class="n">${r.pct_complete}%</td></tr></table></section>`;
    continue;
  }
  const rows = wbs.map((w) => {
    const t = taskByWbs.get(w);
    const pct = Number(t?.pct_complete ?? 0);
    const pin = pins.get(w);
    const src = pin
      ? `Approved report ${pin.submitted_at.slice(0, 10)}${pin.decided_at ? `, accepted ${pin.decided_at.slice(0, 10)}` : ""}`
      : (pct > 0 ? "Status set by AHC site supervision" : "Not started");
    return `<tr><td>${esc(w)}</td><td>${esc(t?.task_name ?? "")}</td><td>${esc(t?.status ?? "-")}</td>
      <td class="n${pct > 0 ? " hi" : ""}">${pct}%</td><td class="src">${esc(src)}</td></tr>`;
  }).join("");
  const avg = wbs.reduce((s, w) => s + Number(taskByWbs.get(w)?.pct_complete ?? 0), 0) / wbs.length;
  sections += `<section><h3>${esc(r.item_number)} &mdash; ${esc(r.description)}</h3>
    <p class="basis">Percent complete is the average across the ${wbs.length} schedule activities mapped to this contract line, taken from the completion status recorded in the project platform as of ${esc(AS_OF)}.</p>
    <table class="grid"><thead><tr><th>WBS</th><th>Activity</th><th>Status</th><th>% Complete</th><th>Substantiation</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <table class="calc">
      <tr><th>Scheduled value</th><td class="n">${money(sv)}</td></tr>
      <tr><th>Average complete (${wbs.length} activities)</th><td class="n">${Math.round(avg * 100) / 100}%</td></tr>
      <tr><th>Previously billed</th><td class="n">${money(r.work_completed_previous)}</td></tr>
      <tr><th class="hi">This application</th><td class="n hi">${money(amt)}</td></tr>
    </table></section>`;
}

const dprRows = dprs.map((d) => `<tr><td>${esc(d.report_date)}</td><td class="n">${d.crew_count ?? "-"}</td><td>${esc((d.work_narrative || "").slice(0, 120))}</td></tr>`).join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>AFP 12 Backup</title><style>
*{box-sizing:border-box}body{font:13px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;margin:0;padding:32px;max-width:1000px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:15px;margin:28px 0 8px;padding-bottom:5px;border-bottom:2px solid #111}
h3{font-size:14px;margin:0 0 6px}.sub{color:#555;margin:0 0 20px}
.hdr{border:1px solid #ccc;padding:12px 14px;margin-bottom:8px;background:#fafafa}
.hdr table{width:100%}.hdr th{text-align:left;font-weight:600;width:170px;padding:2px 0}.hdr td{padding:2px 0}
section{border:1px solid #ddd;padding:14px;margin-bottom:14px;page-break-inside:avoid}
.basis{color:#555;margin:0 0 10px;font-size:12px}
table{border-collapse:collapse}
.grid{width:100%;margin-bottom:10px}
.grid th{background:#f2f2f2;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:5px 7px;border:1px solid #ddd}
.grid td{padding:5px 7px;border:1px solid #ddd}
.calc{width:100%;max-width:420px;margin-left:auto}
.calc th{text-align:left;font-weight:500;padding:3px 8px}.calc td{padding:3px 8px}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.hi{font-weight:700}.src{font-size:11px;color:#444}
.tot{width:100%;max-width:460px;margin-left:auto;border:1px solid #111}
.tot th{text-align:left;padding:5px 10px}.tot td{padding:5px 10px}
.tot tr:last-child{background:#f2f2f2}.tot tr:last-child th,.tot tr:last-child td{font-weight:700;font-size:15px}
@media print{body{padding:0}}
</style></head><body>
<h1>Application for Payment No. 12 &mdash; Substantiation</h1>
<p class="sub">Sweet Springs Solar, LLC &nbsp;&middot;&nbsp; 19362 Constitution Highway, Orange County, VA 22960</p>
<div class="hdr"><table>
<tr><th>Contractor</th><td>American Helios Constructors, LLC</td><th>Period</th><td>${esc(app.period_start)} to ${esc(app.period_end)}</td></tr>
<tr><th>Owner</th><td>Sweet Springs Solar, LLC</td><th>Progress as of</th><td>${esc(AS_OF)}</td></tr>
<tr><th>Contract sum to date</th><td>$3,787,185.91</td><th>Retainage</th><td>5%</td></tr>
</table></div>
<p class="basis">Percent complete on each contract line below is taken from the activity completion recorded in the AHC project platform, which is populated from the daily reports submitted from site and accepted by AHC. The approved report date behind each activity is shown in the Substantiation column.</p>

<h2>Contract lines billed this application</h2>
${sections}

<h2>Application summary</h2>
<table class="tot">
<tr><th>Total completed and stored to date</th><td class="n">${money(Number(app.previous_billings) + Number(app.total_completed))}</td></tr>
<tr><th>Less previous certificates for payment</th><td class="n">${money(app.previous_billings)}</td></tr>
<tr><th>Work completed this application</th><td class="n">${money(app.total_completed)}</td></tr>
<tr><th>Less retainage at 5%</th><td class="n">(${money(app.total_retainage).slice(1)})</td></tr>
<tr><th>Current payment due</th><td class="n">${money(app.amount_due)}</td></tr>
</table>

<h2>Daily reports accepted this period (${dprs.length})</h2>
<table class="grid"><thead><tr><th>Report date</th><th>Crew</th><th>Work performed</th></tr></thead><tbody>${dprRows}</tbody></table>
</body></html>`;

mkdirSync("reports", { recursive: true });
writeFileSync("reports/AFP-12-backup.html", html);
console.log(`reports/AFP-12-backup.html written - ${billed.length} contract lines, ${dprs.length} accepted daily reports.`);
for (const r of billed) console.log(`  ${r.item_number}  ${money(r.work_completed_this_period)}`);
console.log(`  TOTAL ${money(app.total_completed)}  |  retainage ${money(app.total_retainage)}  |  DUE ${money(app.amount_due)}`);
