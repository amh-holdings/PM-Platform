// Imports AHC's Cash Flow Working spreadsheet into the new billing tables.
//
// Source: db/reference/cash-flow.xlsx
// Tables touched: change_orders, billing_lines, billing_entries, cost_forecasts
//                 + projects.contract_value
//
// Idempotent: upserts on natural keys. Safe to re-run after the spreadsheet
// changes; existing rows will be updated and missing months stay missing.
//
// Usage:
//   node scripts/import-cashflow.mjs [--project-id <uuid>] [--dry-run]
//
// Defaults to Sweet Springs project id.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

// ============ ENV / ARGS ============

const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) throw new Error("Missing Supabase env in .env.local");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectIdIdx = args.indexOf("--project-id");
const PROJECT_ID =
  projectIdIdx >= 0 ? args[projectIdIdx + 1] : "53cff193-21e4-45ff-833d-43813e8578a0";

const sb = createClient(SB_URL, SB_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Item numbers to skip during auto-import from the spreadsheet.
// CO-04 IS a real change order ($364,000, paid Jan 2026 per Phil
// 2026-05-28), but the spreadsheet's Cash-In sheet has CO-04 spread
// across many months in a way that does not reflect the actual billing
// event. The correct entry (single $364k Jan 2026 actual) was inserted
// via scripts/_restore-co04.mjs and lives in Supabase already; we skip
// auto-importing CO-04's monthly cells so a re-run of this script
// doesn't re-spread it.
const SKIP_ITEM_NUMBERS = new Set(["CO-04"]);

// ============ HELPERS ============

function parseMoney(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (!s || s === "-" || s === "$-" || s === "-   ") return 0;
  let stripped = s.replace(/[$,\s]/g, "");
  const neg = /^\(.+\)$/.test(stripped);
  stripped = stripped.replace(/^\((.+)\)$/, "$1");
  const n = Number(stripped);
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

const MONTH_RE = /^([A-Za-z]+)\s+(\d{4})$/;
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function parseMonthHeader(s) {
  if (!s) return null;
  const trimmed = String(s).trim();
  const m = trimmed.match(MONTH_RE);
  if (!m) {
    if (/^may$/i.test(trimmed)) {
      // file has bare "May" header for one column - assume 2026 from spreadsheet context
      return { year: 2026, month: 4 };
    }
    return null;
  }
  const month = MONTHS[m[1].toLowerCase()];
  if (month == null) return null;
  return { year: Number(m[2]), month };
}

function isoMonth({ year, month }) {
  const y = String(year).padStart(4, "0");
  const mo = String(month + 1).padStart(2, "0");
  return `${y}-${mo}-01`;
}

function todayMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// CO detection: item_number starts with "CO-"
function coNumberOf(itemNumber) {
  if (!itemNumber) return null;
  const m = String(itemNumber).trim().match(/^(CO-\d+)/i);
  return m ? m[1].toUpperCase() : null;
}

// ============ READ FILE ============

const buf = readFileSync("db/reference/cash-flow.xlsx");
const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
const cashIn = XLSX.utils.sheet_to_json(wb.Sheets["Cash - In "], {
  header: 1, defval: null, raw: false,
});

// ============ PARSE CASH-IN ============

const header = cashIn[0] ?? [];
const monthByCol = new Map(); // col -> { period_month iso, year, month }
for (let c = 0; c < header.length; c++) {
  const parsed = parseMonthHeader(header[c]);
  if (parsed) monthByCol.set(c, { iso: isoMonth(parsed), ...parsed });
}
console.log(`Parsed ${monthByCol.size} monthly columns from Cash-In header`);

const todayMonth = todayMonthIso();
console.log(`Cutoff: entries with period_month <= ${todayMonth} count as actual; later count as planned`);

const billingLines = [];
const billingEntries = [];
const changeOrdersByNum = new Map();

for (let i = 1; i < cashIn.length; i++) {
  const r = cashIn[i] ?? [];
  const itemNumber = r[0] == null ? null : String(r[0]).trim();
  if (!itemNumber) continue;
  if (SKIP_ITEM_NUMBERS.has(itemNumber.toUpperCase())) continue;
  const type = r[1] == null ? null : String(r[1]).trim();
  const description = r[2] == null ? "" : String(r[2]).trim();
  const scheduledValue = parseMoney(r[3]);

  const coNum = coNumberOf(itemNumber) ?? coNumberOf(type);
  if (coNum) {
    changeOrdersByNum.set(coNum, {
      co_number: coNum,
      description: description || type || coNum,
      co_value: scheduledValue,
      status: "approved",
    });
  }

  billingLines.push({
    item_number: itemNumber,
    type,
    description,
    scheduled_value: scheduledValue,
    sort_order: i,
    _co_number: coNum,
  });

  for (const [col, { iso }] of monthByCol) {
    const amount = parseMoney(r[col]);
    if (amount === 0) continue;
    const isActual = iso <= todayMonth;
    billingEntries.push({
      _item_number: itemNumber,
      period_month: iso,
      planned_amount: isActual ? 0 : amount,
      actual_amount: isActual ? amount : 0,
    });
  }
}

// Also pick up CO-01 / CO-02 from the SOV sheet (they live below the totals)
const sov = XLSX.utils.sheet_to_json(wb.Sheets["SOV"], {
  header: 1, defval: null, raw: false,
});
for (let i = 1; i < sov.length; i++) {
  const r = sov[i] ?? [];
  const itemNumber = r[0] == null ? null : String(r[0]).trim();
  if (!itemNumber) continue;
  const coNum = coNumberOf(itemNumber);
  if (!coNum) continue;
  const type = r[1] == null ? null : String(r[1]).trim();
  const description = type || coNum;
  const scheduledValue = parseMoney(r[3]);
  if (!changeOrdersByNum.has(coNum)) {
    changeOrdersByNum.set(coNum, {
      co_number: coNum,
      description,
      co_value: scheduledValue,
      status: "approved",
    });
  }
  // Only add the SOV-sheet billing_line if Cash-In didn't already have one
  if (!billingLines.find((b) => b.item_number === itemNumber)) {
    billingLines.push({
      item_number: itemNumber,
      type,
      description,
      scheduled_value: scheduledValue,
      sort_order: 1000 + i,
      _co_number: coNum,
    });
  }
}

console.log("");
console.log(`Found ${changeOrdersByNum.size} change orders: ${[...changeOrdersByNum.keys()].join(", ")}`);
console.log(`Found ${billingLines.length} billing lines`);
console.log(`Found ${billingEntries.length} billing entries`);

const totalScheduled = billingLines.reduce((s, b) => s + b.scheduled_value, 0);
const totalPlanned = billingEntries.reduce((s, e) => s + e.planned_amount, 0);
const totalActual = billingEntries.reduce((s, e) => s + e.actual_amount, 0);
console.log("");
console.log(`Totals -- scheduled: $${totalScheduled.toFixed(2)}`);
console.log(`          planned (future):  $${totalPlanned.toFixed(2)}`);
console.log(`          actual (past+now): $${totalActual.toFixed(2)}`);
console.log(`          actual + planned:  $${(totalActual + totalPlanned).toFixed(2)} (should be ~total billed across all months)`);

if (dryRun) {
  console.log("");
  console.log("Dry run - no writes performed.");
  process.exit(0);
}

// ============ WRITE TO SUPABASE ============

console.log("");
console.log(`Writing to project ${PROJECT_ID}...`);

// 1) Upsert change orders
const coRows = [...changeOrdersByNum.values()].map((co) => ({
  project_id: PROJECT_ID,
  co_number: co.co_number,
  description: co.description,
  co_value: co.co_value,
  status: co.status,
}));
{
  const { error } = await sb
    .from("change_orders")
    .upsert(coRows, { onConflict: "project_id,co_number" });
  if (error) throw new Error(`change_orders upsert: ${error.message}`);
  console.log(`  upserted ${coRows.length} change_orders`);
}

// Map CO number -> id
const { data: coAfter } = await sb
  .from("change_orders")
  .select("id, co_number")
  .eq("project_id", PROJECT_ID);
const coIdByNum = new Map((coAfter ?? []).map((c) => [c.co_number, c.id]));

// 2) Upsert billing_lines
const blRows = billingLines.map((b) => ({
  project_id: PROJECT_ID,
  item_number: b.item_number,
  type: b.type,
  description: b.description,
  scheduled_value: b.scheduled_value,
  sort_order: b.sort_order,
  change_order_id: b._co_number ? (coIdByNum.get(b._co_number) ?? null) : null,
}));
{
  const { error } = await sb
    .from("billing_lines")
    .upsert(blRows, { onConflict: "project_id,item_number" });
  if (error) throw new Error(`billing_lines upsert: ${error.message}`);
  console.log(`  upserted ${blRows.length} billing_lines`);
}

// Map item_number -> id
const { data: blAfter } = await sb
  .from("billing_lines")
  .select("id, item_number")
  .eq("project_id", PROJECT_ID);
const blIdByItem = new Map((blAfter ?? []).map((b) => [b.item_number, b.id]));

// 3) Upsert billing_entries in chunks
const beRows = billingEntries
  .map((e) => {
    const lineId = blIdByItem.get(e._item_number);
    if (!lineId) return null;
    return {
      billing_line_id: lineId,
      period_month: e.period_month,
      planned_amount: e.planned_amount,
      actual_amount: e.actual_amount,
    };
  })
  .filter(Boolean);

{
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < beRows.length; i += CHUNK) {
    const chunk = beRows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("billing_entries")
      .upsert(chunk, { onConflict: "billing_line_id,period_month" });
    if (error) throw new Error(`billing_entries upsert (chunk ${i}): ${error.message}`);
    written += chunk.length;
  }
  console.log(`  upserted ${written} billing_entries`);
}

// 4) Set projects.contract_value to the total scheduled value
{
  const { error } = await sb
    .from("projects")
    .update({ contract_value: totalScheduled })
    .eq("id", PROJECT_ID);
  if (error) throw new Error(`projects update: ${error.message}`);
  console.log(`  set projects.contract_value = $${totalScheduled.toFixed(2)}`);
}

// ============ COST FORECASTS (Cost Code sheet) ============

console.log("");
console.log("Cost forecasts from Cost Code sheet...");

const ccSheet = XLSX.utils.sheet_to_json(wb.Sheets["Cost Code"], {
  header: 1, defval: null, raw: false,
});
const ccHeader = ccSheet[0] ?? [];
const ccMonthByCol = new Map();
const ABBREV = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
for (let c = 0; c < ccHeader.length; c++) {
  const h = ccHeader[c];
  if (!h) continue;
  const trimmed = String(h).trim();
  const m = trimmed.match(/^([A-Za-z]{3})-(\d{2})$/);
  if (!m) continue;
  const mo = ABBREV[m[1].toLowerCase()];
  if (mo == null) continue;
  const yr = 2000 + Number(m[2]);
  ccMonthByCol.set(c, isoMonth({ year: yr, month: mo }));
}
console.log(`  Parsed ${ccMonthByCol.size} monthly columns from Cost Code header`);

// Pull cost_codes for this project to map by code prefix
const { data: codesNow } = await sb
  .from("cost_codes")
  .select("id, code, name")
  .eq("project_id", PROJECT_ID);
const codeIdByPrefix = new Map();
for (const c of codesNow ?? []) {
  codeIdByPrefix.set(String(c.code).trim().toUpperCase(), c.id);
}

const costEntries = [];
let costRowsParsed = 0;
let costRowsMatched = 0;
for (let i = 1; i < ccSheet.length; i++) {
  const r = ccSheet[i] ?? [];
  const cellLabel = r[1];
  if (!cellLabel) continue;
  const label = String(cellLabel).trim();
  // Skip total rows
  if (/^total/i.test(label) || /^final/i.test(label)) continue;
  // Extract code prefix - "SSC A-AHC Labor" -> "SSC A"; "CO-01" -> "CO-01"
  let prefix = null;
  const sscMatch = label.match(/^(SSC\s+[A-Z]+)/i);
  const coMatch = label.match(/^(CO-\d+)/i);
  if (sscMatch) prefix = sscMatch[1].toUpperCase().replace(/\s+/g, " ");
  else if (coMatch) prefix = coMatch[1].toUpperCase();
  if (!prefix) continue;
  costRowsParsed += 1;
  const codeId = codeIdByPrefix.get(prefix);
  if (!codeId) {
    console.log(`    skip: no cost_code match for prefix "${prefix}" (row ${i}: "${label}")`);
    continue;
  }
  costRowsMatched += 1;
  for (const [col, iso] of ccMonthByCol) {
    const amount = parseMoney(r[col]);
    if (amount === 0) continue;
    const isActual = iso <= todayMonth;
    costEntries.push({
      cost_code_id: codeId,
      period_month: iso,
      planned_amount: isActual ? 0 : amount,
      actual_amount: isActual ? amount : 0,
    });
  }
}
console.log(`  Parsed ${costRowsParsed} cost rows, matched ${costRowsMatched} to existing cost_codes`);

if (costEntries.length > 0) {
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < costEntries.length; i += CHUNK) {
    const chunk = costEntries.slice(i, i + CHUNK);
    const { error } = await sb
      .from("cost_forecasts")
      .upsert(chunk, { onConflict: "cost_code_id,period_month" });
    if (error) throw new Error(`cost_forecasts upsert: ${error.message}`);
    written += chunk.length;
  }
  console.log(`  upserted ${written} cost_forecasts`);
}

console.log("");
console.log("Done.");
