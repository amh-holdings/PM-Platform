// Seed Pyramid Excavation's executed SOV and pay application 1.
//
// Source: "Pyramid Excavation 2026.08.13 Sweet Spring Pay App #1.pdf" -
// the Application for Payment (column C is the executed SOV), invoice #1383,
// and the signed Exhibit F-1 conditional waiver.
//
// Phil approved app 1 as billed on 2026-08-13, so it loads as approved
// history and is NOT re-verified. Its column F becomes the locked baseline
// that app 2's "from previous application" column has to reconcile to.
//
// Idempotent: upserts on (subcontractor_id, item_number) and
// (subcontractor_id, app_number).
//
//   node scripts/seed-pyramid-sub-billing.mjs [--dry]

import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const DRY = process.argv.includes("--dry");

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0"; // Sweet Springs Solar

// ---- The executed SOV, verbatim from column C. Totals $798,067.00. ----
// billed = column E on app 1 (there was no column D; app 1 is the first bill).
const SECTIONS = [
  ["1.00", "SITE PREPARATION & MOBILIZATION"],
  ["2.00", "EARTHWORK & GRADING"],
  ["3.00", "ACCESS ROADS"],
  ["5.00", "SWPPP & EROSION CONTROL"],
  ["7.00", "FINAL SITE WORK"],
  ["8.00", "CLOSEOUT"],
];

const SOV = [
  // item,  section, description,                                            scheduled,  app1 billed, app1 retainage
  ["1.01", "1.00", "Mobilization to site (equipment, trailers, temporary facilities)", 26922.68, 21538.14, 1076.91],
  ["1.02", "1.00", "Site survey verification and layout",                     13461.34,  3365.34,  168.27],
  ["1.03", "1.00", "Erosion and sediment control installation (initial)",     20192.01,  4038.40,  201.92],
  ["1.04", "1.00", "Tree clearing and grubbing",                             151922.68, 75961.34, 3798.07],
  ["2.01", "2.00", "Mass grading and site preparation",                       87498.71,  8749.87,  437.49],
  ["2.02", "2.00", "Cut and fill operations",                                 60576.03,        0,       0],
  ["2.03", "2.00", "Subgrade preparation for array areas",                    47114.69,        0,       0],
  ["2.04", "2.00", "Drainage structures and stormwater management",           40384.02,        0,       0],
  ["3.01", "3.00", "Access road construction (subbase and base course)",      80768.04,  8076.80,  403.84],
  ["3.02", "3.00", "Internal site roads",                                     60576.03,        0,       0],
  ["3.03", "3.00", "Road surfacing and finish grading",                       40384.02,        0,       0],
  ["5.01", "5.00", "SWPPP implementation and ongoing maintenance",            20192.01,  2019.20,  100.96],
  ["5.02", "5.00", "Silt fence and erosion control devices",                  13461.34, 10096.00,  504.80],
  ["7.01", "7.00", "Topsoil placement and final grading",                     33653.35,        0,       0],
  ["7.02", "7.00", "Hydroseeding and revegetation",                           40384.02,        0,       0],
  ["7.03", "7.00", "Final landscaping and site restoration",                  13461.34,        0,       0],
  ["8.01", "8.00", "Demobilization and site cleanup",                         13461.34,        0,       0],
  ["8.02", "8.00", "Punchlist completion and final walkthrough",              20192.01,        0,       0],
  ["8.03", "8.00", "Closeout documentation and as-builts",                    13461.34,        0,       0],
];

// ---- App 1 header, from the G702 block and invoice #1383. ----
const APP1 = {
  app_number: 1,
  app_date: "2026-08-13",
  period_start: null,          // the form shows only "PERIOD TO: 8.13.26"
  period_end: "2026-08-13",
  retainage_pct: 5,
  payment_terms_days: 30,      // form and invoice both say Net 30
  due_date: "2026-09-12",
  invoice_number: "1383",
  invoice_date: "2026-08-13",
  invoice_total: 133845.09,
  billed_previous: 0,
  billed_this_period: 133845.09,
  billed_to_date: 133845.09,
  retainage_this_period: 6692.25,
  retainage_to_date: 6692.25,
  amount_due: 127152.84,
  approved_this_period: 133845.09,
  approved_retainage: 6692.25,
  approved_amount_due: 127152.84,
  status: "approved",
  lien_waiver_received: true,
  lien_waiver_amount: 127152.84,
  lien_waiver_through_date: "2026-08-13",
  approval_notes:
    "Approved as billed by Phil on 2026-08-13, before the verification engine existed. " +
    "Loaded as baseline history and intentionally not re-verified. Column F here is the " +
    "locked 'from previous application' reference for app 2.",
  notes:
    "Source: Pyramid Excavation 2026.08.13 Sweet Spring Pay App #1.pdf (G702 + invoice 1383 + Exhibit F-1 waiver).",
};

const round2 = (v) => Math.round(v * 100) / 100;

async function main() {
  const { data: sub, error: subErr } = await sb
    .from("subcontractors")
    .select("id, company_name, contract_value, retainage_pct")
    .eq("project_id", PROJECT_ID)
    .ilike("company_name", "%Pyramid%")
    .single();
  if (subErr) throw new Error(`Pyramid not found: ${subErr.message}`);

  const sovTotal = round2(SOV.reduce((s, r) => s + r[3], 0));
  const billedTotal = round2(SOV.reduce((s, r) => s + r[4], 0));
  const retTotal = round2(SOV.reduce((s, r) => s + r[5], 0));

  console.log(`Sub: ${sub.company_name} (${sub.id})`);
  console.log(`SOV lines: ${SOV.length}  total: $${sovTotal.toLocaleString()}  contract on file: $${Number(sub.contract_value).toLocaleString()}`);
  console.log(`App 1 billed: $${billedTotal.toLocaleString()}  line retainage sum: $${retTotal.toLocaleString()} (form says $${APP1.retainage_this_period})`);
  if (sovTotal !== Number(sub.contract_value)) {
    console.warn(`  WARNING: SOV total does not equal the contract value on file.`);
  }
  if (billedTotal !== APP1.billed_this_period) {
    throw new Error(`Line total ${billedTotal} does not match the app header ${APP1.billed_this_period}`);
  }
  if (DRY) return console.log("\n--dry: nothing written.");

  const sectionName = Object.fromEntries(SECTIONS);

  // ---- SOV lines ----
  const sovRows = SOV.map(([item, section, description, scheduled], i) => ({
    project_id: PROJECT_ID,
    subcontractor_id: sub.id,
    item_number: item,
    section_code: section,
    section_name: sectionName[section],
    description,
    scheduled_value: scheduled,
    // Mapping stays 'unmapped' until Phil and Mark confirm the draft. The
    // engine reports unmapped lines as unverifiable rather than passing them.
    verification_method: "unmapped",
    sort_order: (i + 1) * 10,
  }));

  const { error: sovErr } = await sb
    .from("sub_sov_lines")
    .upsert(sovRows, { onConflict: "subcontractor_id,item_number" });
  if (sovErr) throw new Error(`SOV upsert failed: ${sovErr.message}`);
  console.log(`\nUpserted ${sovRows.length} SOV lines.`);

  // ---- Pay app 1 header ----
  const { data: app, error: appErr } = await sb
    .from("sub_pay_apps")
    .upsert(
      { project_id: PROJECT_ID, subcontractor_id: sub.id, ...APP1 },
      { onConflict: "subcontractor_id,app_number" },
    )
    .select("id")
    .single();
  if (appErr) throw new Error(`Pay app upsert failed: ${appErr.message}`);
  console.log(`Upserted pay app 1 (${app.id}).`);

  // ---- Pay app 1 lines ----
  const { data: sovSaved } = await sb
    .from("sub_sov_lines")
    .select("id, item_number")
    .eq("subcontractor_id", sub.id);
  const sovIdByItem = Object.fromEntries((sovSaved ?? []).map((r) => [r.item_number, r.id]));

  await sb.from("sub_pay_app_lines").delete().eq("sub_pay_app_id", app.id);

  const lineRows = SOV.map(([item, , description, scheduled, thisPeriod, retainage], i) => ({
    sub_pay_app_id: app.id,
    sub_sov_line_id: sovIdByItem[item] ?? null,
    item_number: item,
    description,
    scheduled_value: scheduled,
    from_previous: 0,
    this_period: thisPeriod,
    materials_stored: 0,
    total_completed: thisPeriod,
    pct_billed: scheduled > 0 ? round2((thisPeriod / scheduled) * 10000) / 10000 : 0,
    balance_to_finish: round2(scheduled - thisPeriod),
    retainage_amount: retainage,
    // Approved as billed. No verification was run on this application.
    approved_this_period: thisPeriod,
    flag_level: null,
    sort_order: (i + 1) * 10,
  }));

  const { error: lineErr } = await sb.from("sub_pay_app_lines").insert(lineRows);
  if (lineErr) throw new Error(`Line insert failed: ${lineErr.message}`);
  console.log(`Inserted ${lineRows.length} pay app lines.`);

  // Payment terms on the executed bill say Net 30; the subcontractor record
  // says payment_terms_days = 60 while payment_terms reads "Net 30". Leave the
  // record alone - it gets corrected from the subcontract, not from a bill -
  // but make sure the contradiction is visible.
  console.log(
    `\nNOTE: subcontractor record still carries payment_terms_days=60 while the bill and invoice both say Net 30. Resolve from the executed subcontract.`,
  );
  console.log("Done.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
