// Import the Cash-Out sheet from db/reference/cash-flow.xlsx into the
// cost_forecasts table. The sheet has a hybrid column layout:
//
//   Apr 2024 - June 2025 (cols 3-17): one column per month, all Actual
//   July 2025 - Dec 2026 (cols 18-53): paired columns per month
//                                       (Projected has the month label,
//                                        Actual sits in the next column
//                                        with a null header)
//
// This script clears existing cost_forecasts for the project and re-imports
// from Cash-Out so historical actuals + future projections are both present.
//
// Usage:
//   node scripts/import-cash-out.mjs [--project-id <uuid>] [--dry-run]

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) {
  const t = l.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1);
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectIdIdx = args.indexOf("--project-id");
const PROJECT_ID =
  projectIdIdx >= 0 ? args[projectIdIdx + 1] : "53cff193-21e4-45ff-833d-43813e8578a0";

const sb = createClient(SB_URL, SB_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};
function parseMonthHeader(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (mo == null) return null;
  return { year: Number(m[2]), month: mo };
}
function isoMonth({ year, month }) {
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
}

// ============ READ ============

const buf = readFileSync("db/reference/cash-flow.xlsx");
const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
const ws = wb.Sheets["Cash - Out"];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

const hdr = rows[0] ?? [];
const sub = rows[1] ?? [];

// Build column -> { iso, kind: "actual" | "planned" }
const colMap = new Map();
let lastMonthIso = null;
for (let c = 0; c < hdr.length; c++) {
  const monthParsed = parseMonthHeader(hdr[c]);
  if (monthParsed) {
    lastMonthIso = isoMonth(monthParsed);
  }
  const subLabel = (sub[c] ?? "").toString().trim().toLowerCase();
  if (!lastMonthIso || !subLabel) continue;
  if (subLabel === "actual") {
    colMap.set(c, { iso: lastMonthIso, kind: "actual" });
  } else if (subLabel === "projected") {
    colMap.set(c, { iso: lastMonthIso, kind: "planned" });
  }
}
console.log(`Parsed ${colMap.size} month-cells from Cash-Out header`);

// ============ MATCH COST CODES ============

const { data: codesNow } = await sb
  .from("cost_codes")
  .select("id, code, name")
  .eq("project_id", PROJECT_ID);
const codeIdByPrefix = new Map();
for (const c of codesNow ?? []) {
  codeIdByPrefix.set(String(c.code).trim().toUpperCase(), c.id);
}
console.log(`Have ${codeIdByPrefix.size} cost codes in Supabase to match against`);

// ============ PARSE DATA ============

// Map of cost_code_id -> month_iso -> { planned, actual }
const byCode = new Map();
let unmatchedRows = 0;
for (let i = 2; i < rows.length; i++) {
  const r = rows[i] ?? [];
  const label = (r[1] ?? "").toString().trim();
  if (!label) continue;
  if (/^total/i.test(label) || /^final/i.test(label)) continue;
  // Extract prefix: SSC A, SSC B, ... or CO-01, etc.
  let prefix = null;
  const sscMatch = label.match(/^(SSC\s+[A-Z]+)/i);
  const coMatch = label.match(/^(CO-\d+)/i);
  if (sscMatch) prefix = sscMatch[1].toUpperCase().replace(/\s+/g, " ");
  else if (coMatch) prefix = coMatch[1].toUpperCase();
  if (!prefix) continue;
  const codeId = codeIdByPrefix.get(prefix);
  if (!codeId) {
    console.log(`  skip: no cost_code match for "${prefix}" (row ${i}: "${label}")`);
    unmatchedRows += 1;
    continue;
  }
  if (!byCode.has(codeId)) byCode.set(codeId, new Map());
  const months = byCode.get(codeId);
  for (const [col, { iso, kind }] of colMap) {
    const v = parseMoney(r[col]);
    if (v === 0) continue;
    if (!months.has(iso)) months.set(iso, { planned: 0, actual: 0 });
    months.get(iso)[kind] += v;
  }
}

// ============ ASSEMBLE ROWS ============

const newRows = [];
let plannedSum = 0, actualSum = 0;
for (const [codeId, months] of byCode) {
  for (const [iso, v] of months) {
    if (v.planned === 0 && v.actual === 0) continue;
    newRows.push({
      cost_code_id: codeId,
      period_month: iso,
      planned_amount: v.planned,
      actual_amount: v.actual,
    });
    plannedSum += v.planned;
    actualSum += v.actual;
  }
}

// Per-month totals for sanity check
const monthTotals = new Map();
for (const [, months] of byCode) {
  for (const [iso, v] of months) {
    if (!monthTotals.has(iso)) monthTotals.set(iso, { planned: 0, actual: 0 });
    monthTotals.get(iso).planned += v.planned;
    monthTotals.get(iso).actual += v.actual;
  }
}
console.log("");
console.log("Per-month totals from Cash-Out sheet:");
for (const m of [...monthTotals.keys()].sort()) {
  const t = monthTotals.get(m);
  console.log(`  ${m}  planned=$${t.planned.toFixed(2).padStart(12)}  actual=$${t.actual.toFixed(2).padStart(12)}`);
}
console.log("");
console.log(`Total rows to upsert: ${newRows.length}`);
console.log(`Total planned: $${plannedSum.toFixed(2)}`);
console.log(`Total actual:  $${actualSum.toFixed(2)}`);
console.log(`Unmatched rows (label prefix not in cost_codes): ${unmatchedRows}`);

if (dryRun) {
  console.log("");
  console.log("Dry run - no writes performed.");
  process.exit(0);
}

// ============ WRITE ============

// Delete existing cost_forecasts for this project's cost codes first to avoid
// stale rows from previous imports
const codeIds = [...codeIdByPrefix.values()];
{
  const { error, count } = await sb
    .from("cost_forecasts")
    .delete({ count: "exact" })
    .in("cost_code_id", codeIds);
  if (error) throw new Error(`delete cost_forecasts: ${error.message}`);
  console.log("");
  console.log(`Deleted ${count} existing cost_forecasts rows`);
}

const CHUNK = 200;
let written = 0;
for (let i = 0; i < newRows.length; i += CHUNK) {
  const chunk = newRows.slice(i, i + CHUNK);
  const { error } = await sb
    .from("cost_forecasts")
    .upsert(chunk, { onConflict: "cost_code_id,period_month" });
  if (error) throw new Error(`upsert cost_forecasts: ${error.message}`);
  written += chunk.length;
}
console.log(`Wrote ${written} cost_forecasts rows`);
console.log("Done.");
