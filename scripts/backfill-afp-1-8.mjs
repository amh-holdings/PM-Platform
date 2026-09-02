// Backfill Sweet Springs pay applications AFP 1 - AFP 8 from the executed
// G702/G703 PDFs (OneDrive_1_8-20-2026). The platform already held the
// per-line billing_entries for these periods; what was missing was the
// pay_applications headers, the frozen G703 line snapshots, and the
// entry -> pay_application linkage.
//
// Every header figure below is transcribed from the executed G702. Every
// line figure is derived from the existing billing_entries and was checked
// against the executed G703 continuation sheets for AFP 1, 2A, 6 and 8.
//
//   node scripts/backfill-afp-1-8.mjs          (dry run)
//   node scripts/backfill-afp-1-8.mjs --apply
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const APPLY = process.argv.includes("--apply");
const r2 = n => Math.round(n * 100) / 100;
const money = n => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- Schedule of values, period-correct ------------------------------------
// LNTP era (AFP 1 only). Per AFP 1's G703 the transformer line was 110,500.24
// and pile testing was split across two rows (5,925.00 + 17,775.00); the
// platform carries one 1.09 row at 23,700.00, which is how AHC themselves
// re-presented it in AFP 2A's "from previous" column.
const SOV_LNTP = { "1.01": 22580.68, "1.02": 11290.34, "1.03": 16935.51, "1.04": 22580.68,
  "1.05": 22580.68, "1.06": 5645.17, "1.07": 5645.17, "1.08": 5645.17, "1.09": 23700.00,
  "1.10": 277667.52, "1.11": 49637.64, "1.12": 110500.24 };

// EPC era (AFP 2A - AFP 7). Sums to exactly 2,507,500.00.
const SOV_EPC = { "1.01": 22580.68, "1.02": 11290.34, "1.03": 16935.51, "1.04": 22580.68,
  "1.05": 22580.68, "1.06": 5645.17, "1.07": 5645.17, "1.08": 5645.17, "1.09": 23700.00,
  "1.10": 277667.52, "1.11": 49637.64, "1.12": 110500.50, "2.00": 85017.50, "3.00": 85017.50,
  "4.00": 0, "5.01": 0, "5.02": 10000.00, "5.03": 0, "5.04": 20000.00, "5.05": 168335.32,
  "5.06": 5000.00, "5.07": 10000.00, "5.08": 20000.00, "6.01": 100000.00, "6.02": 350000.00,
  "6.03": 125000.00, "7.01": 50000.00, "7.02": 152900.00, "7.03": 24002.80, "7.04": 88000.00,
  "8.01": 195817.82, "8.02": 40000.00, "8.03": 20000.00, "9.00": 160000.00, "10.00": 160000.00,
  "11.00": 64000.00, "12.00": 0 };

// AFP 8 adds CO 1 (incurred costs through 8-30-2025) -> 2,876,175.48.
const SOV_AFP8 = { ...SOV_EPC, "13.00": 368675.48 };

// ---- Work completed this period, by SOV line -------------------------------
// Taken from the billing_entries already in the platform. The single
// "AFP 2A/2B" entry group is split here per the executed 2A and 2B G703s.
const PERIODS = [
  { app: "AFP 1",  sov: SOV_LNTP, start: "2024-05-01", end: "2024-05-31", appDate: "2024-06-04",
    work: { "1.01": 22580.68, "1.09": 5925.00, "1.12": 27625.06 },
    retainCum: {}, doc: { completed: 56130.74, prev: 0, retainCum: 0, due: 56130.74, sovTotal: 574408.80 } },
  { app: "AFP 2A", sov: SOV_EPC, start: "2024-06-01", end: "2024-06-30", appDate: "2024-07-08",
    work: { "1.09": 17775.00, "1.10": 69416.88, "1.11": 49637.64 },
    retainCum: {}, doc: { completed: 192960.26, prev: 56130.74, retainCum: 0, due: 136829.52, sovTotal: 2507500.00 } },
  { app: "AFP 2B", sov: SOV_EPC, start: "2024-06-01", end: "2024-06-30", appDate: "2024-07-09",
    work: { "1.12": 82875.44, "2.00": 85017.50 },
    retainCum: { "2.00": 8501.75 }, doc: { completed: 360853.20, prev: 192960.26, retainCum: 8501.75, due: 159391.19, sovTotal: 2507500.00 } },
  { app: "AFP 3R", sov: SOV_EPC, start: "2024-07-01", end: "2024-07-31", appDate: "2024-08-26",
    work: { "1.10": 69416.88 },
    retainCum: { "2.00": 4250.88 }, doc: { completed: 430270.08, prev: 360853.20, retainCum: 4250.88, due: 69416.88, sovTotal: 2507500.00 } },
  { app: "AFP 4R", sov: SOV_EPC, start: "2024-10-01", end: "2024-10-31", appDate: "2024-10-31",
    work: { "1.02": 11290.34, "1.03": 16935.51, "1.04": 22580.68, "1.05": 11290.34 },
    retainCum: { "2.00": 4250.88 }, doc: { completed: 492366.95, prev: 430270.08, retainCum: 4250.88, due: 62096.87, sovTotal: 2507500.00 } },
  { app: "AFP 5R", sov: SOV_EPC, start: "2024-12-01", end: "2024-12-31", appDate: "2025-01-08",
    work: { "1.05": 5645.17, "3.00": 42508.75 },
    retainCum: { "2.00": 4250.88, "3.00": 2125.43 }, doc: { completed: 540520.87, prev: 492366.95, retainCum: 6376.31, due: 46028.48, sovTotal: 2507500.00 } },
  { app: "AFP 6",  sov: SOV_EPC, start: "2025-02-01", end: "2025-02-28", appDate: "2025-02-28",
    work: { "1.05": 5645.17, "3.00": 42508.75, "5.06": 5000.00 },
    retainCum: { "2.00": 4250.88, "3.00": 4250.87, "5.06": 250.00 }, doc: { completed: 593674.79, prev: 540520.87, retainCum: 8751.75, due: 50778.48, sovTotal: 2507500.00 } },
  { app: "AFP 7",  sov: SOV_EPC, start: "2025-06-01", end: "2025-06-25", appDate: "2025-06-25",
    work: { "1.10": 138833.76 },
    retainCum: { "2.00": 4250.88, "3.00": 4250.87, "5.06": 250.00 }, doc: { completed: 732508.55, prev: 593674.79, retainCum: 8751.75, due: 138833.76, sovTotal: 2507500.00 } },
  { app: "AFP 8",  sov: SOV_AFP8, start: "2025-11-01", end: "2025-11-30", appDate: "2025-11-21",
    work: { "13.00": 368675.48 },
    retainCum: { "2.00": 4250.88, "3.00": 4250.87, "5.06": 250.00 }, doc: { completed: 1101184.03, prev: 732508.55, retainCum: 8751.75, due: 368675.48, sovTotal: 2876175.48 } },
];

const NOTES = {
  "AFP 1": "Backfilled from the executed G702/G703 (AFP 1 Sweet Springs 2024.06.04.pdf). LNTP-era schedule of values; G703 total 574,408.80. The executed G702 line 1 printed 550,708.80, which omits the 23,700.00 pile-testing rows carried on its own G703 - transcribed here per the G703. Titled 'Rivanna Solar' on the form.",
  "AFP 2A": "Backfilled from the executed G702/G703 (AFP 2A Sweet Springs 2024.07.08.pdf). First application on the 2,507,500.00 EPC schedule of values (contract dated 28-Jun-24). Net 10 day terms. Titled 'Rivanna Solar' on the form.",
  "AFP 2B": "Backfilled from the executed G702/G703 (AFP 2B Sweet Springs 2024.07.09.pdf). Same period as AFP 2A. Retainage withheld at 10% of line 2.00 (8,501.75); reduced to 5% (4,250.88) beginning AFP 3R and never trued up in cash - see AFP 3R note. Titled 'Rivanna Solar' on the form.",
  "AFP 3R": "Backfilled from the executed G702/G703 (AFP 3 R Sweet Springs 2024.08.26.pdf). Retainage rate dropped from 10% to 5%, cutting cumulative retainage from 8,501.75 to 4,250.88, but line 8 was billed as the period work delta with no retainage release. 4,250.87 of over-withheld retainage from AFP 2B remains unrecovered. Titled 'Rivanna Solar' on the form.",
  "AFP 4R": "Backfilled from the executed G702/G703 (AFP 4R Sweet Springs 10-31-2024.pdf). Revised at owner request to remove racking/procurement costs (Dimension email 10/29/2024). Titled 'Rivanna Solar' on the form.",
  "AFP 5R": "Backfilled from the executed G702/G703 (AFP 5R Sweet Springs 2025.01.08.pdf). The executed G702 line 7 printed 430,270.08 (AFP 3R's total) instead of AFP 4R's 492,366.95; line 8 of 46,028.48 was nonetheless computed off AFP 4R, so the amount billed is correct and only the printed line 7 is stale. Titled 'Rivanna Solar' on the form.",
  "AFP 6": "Backfilled from the executed G702/G703 (AFP 6 Sweet Springs 2-28-2025.pdf). Notarized. The executed G702 line 7 again printed the stale 430,270.08; line 8 of 50,778.48 was computed off AFP 5R and is correct. G703 totals row leaves column I blank though G702 line 5 shows 8,751.75. Titled 'Rivanna Solar' on the form.",
  "AFP 7": "Backfilled from the executed G702/G703 (AFP 7 Sweet Springs 2025.06.25.pdf). Notarized. Line 7 correctly carries AFP 6's earned-less-retainage. Titled 'Rivanna Solar' on the form.",
  "AFP 8": "Backfilled from the executed G702/G703 (AFP 8 Sweet Springs 2025.11.21 CO 1.pdf). Notarized. First form titled 'Sweet Springs'. Adds CO 1 - incurred costs through 8-30-2025, 368,675.48 - taking the contract sum to 2,876,175.48. Net 10 day terms.",
};

// ---- Build and verify ------------------------------------------------------
const { data: bl } = await sb.from("billing_lines").select("id,item_number,description").eq("project_id", PID);
const byItem = Object.fromEntries(bl.map(l => [l.item_number.trim(), l]));

const cumWork = {};   // item -> cumulative work completed
const report = [];
let prevCum = 0;
const plans = [];

for (const p of PERIODS) {
  const items = Object.keys(p.sov).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const prevWork = { ...cumWork };
  for (const [it, amt] of Object.entries(p.work)) cumWork[it] = r2((cumWork[it] || 0) + amt);

  const lines = items.map((it, i) => {
    const sched = p.sov[it];
    const prev = prevWork[it] || 0;
    const thisP = p.work[it] || 0;
    const total = r2(prev + thisP);
    const bill = byItem[it];
    if (!bill) throw new Error(`no billing_line for item ${it}`);
    return { item_number: it, description: bill.description, billing_line_id: bill.id,
      scheduled_value: sched, work_completed_previous: prev, work_completed_this_period: thisP,
      materials_stored: 0, total_completed_and_stored: total,
      pct_complete: sched ? r2((total / sched) * 100) : 0,
      balance_to_finish: r2(sched - total), retainage_amount: p.retainCum[it] || 0, sort_order: i };
  });

  const sovSum = r2(lines.reduce((s, l) => s + l.scheduled_value, 0));
  const compSum = r2(lines.reduce((s, l) => s + l.total_completed_and_stored, 0));
  const thisSum = r2(lines.reduce((s, l) => s + l.work_completed_this_period, 0));
  const retSum  = r2(lines.reduce((s, l) => s + l.retainage_amount, 0));
  const retDelta = r2(p.doc.retainCum - (report.length ? PERIODS[report.length - 1].doc.retainCum : 0));

  const chk = (a, b) => r2(a) === r2(b) ? "OK" : `DIFF ${r2(a - b)}`;
  report.push({
    app: p.app, rows: lines.length,
    "SOV": money(sovSum), "vs G702 L3": chk(sovSum, p.doc.sovTotal),
    "completed to date": money(compSum), "vs G702 L4": chk(compSum, p.doc.completed),
    "this period": money(thisSum),
    "previous": money(prevCum), "vs G702 L7": chk(prevCum, p.doc.prev),
    "retain cum": money(retSum), "vs G702 L5": chk(retSum, p.doc.retainCum),
    "due": money(p.doc.due),
  });

  plans.push({ p, lines, header: {
    project_id: PID, app_number: p.app, period_start: p.start, period_end: p.end,
    status: "paid", total_completed: thisSum, total_retainage: retDelta,
    previous_billings: prevCum, amount_due: p.doc.due,
    submitted_at: `${p.appDate}T12:00:00+00:00`, notes: NOTES[p.app] } });

  prevCum = compSum;
}

console.log("VERIFICATION vs executed G702 / G703");
console.table(report);
const bad = report.filter(r => Object.entries(r).some(([k, v]) => k.startsWith("vs ") && v !== "OK"));
console.log(bad.length ? `\n!! ${bad.length} row(s) fail verification - NOT applying` : "\nAll rows tie to the executed documents.");
console.log(`\nFinal cumulative after AFP 8: $${money(prevCum)}  (platform AFP 9 previous_billings: $1,101,184.03)`);

if (!APPLY) { console.log("\n[dry run] pass --apply to write."); process.exit(bad.length ? 1 : 0); }
if (bad.length) process.exit(1);

// ---- Apply -----------------------------------------------------------------
for (const { p, lines, header } of plans) {
  const { data: existing } = await sb.from("pay_applications").select("id").eq("project_id", PID).eq("app_number", p.app).maybeSingle();
  let appId;
  if (existing) {
    await sb.from("pay_applications").update(header).eq("id", existing.id);
    await sb.from("pay_application_lines").delete().eq("pay_application_id", existing.id);
    appId = existing.id; console.log(`updated ${p.app}`);
  } else {
    const { data, error } = await sb.from("pay_applications").insert(header).select("id").single();
    if (error) throw error;
    appId = data.id; console.log(`inserted ${p.app}`);
  }
  const rows = lines.map(l => ({ pay_application_id: appId, ...l }));
  const { error: le } = await sb.from("pay_application_lines").insert(rows);
  if (le) throw le;
  console.log(`  ${rows.length} G703 lines`);

  // link the existing billing_entries for this period to the new header
  for (const it of Object.keys(p.work)) {
    const { error: ue } = await sb.from("billing_entries").update({ pay_application_id: appId })
      .eq("billing_line_id", byItem[it].id).in("afp_number", [p.app, "AFP 2A/2B"])
      .eq("actual_amount", p.work[it]);
    if (ue) console.log(`  !! link ${it}: ${ue.message}`);
  }
}
console.log("\ndone");
