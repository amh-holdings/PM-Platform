// Importer for the 2026-05-29 cash flow file (Zarina's restructure).
//
// Differences from the original importer:
//   - File: db/reference/cash-flow-20260529.xlsx
//   - Reads the new "Sweet Springs Cash Flow" sheet as the master billing
//     timeline (column headers are cash-in months, not billing months)
//   - Drops the CO-01, CO-02, CO-04 billing_lines (CO-02 folded into SOV
//     line items 6.01-8.02; CO-01 billing moved to new line "13.00 Incurred
//     Costs through 8-30-2025"; CO-04 removed entirely)
//   - Keeps CO-01 and CO-02 in the change_orders table (they're still real
//     COs even though their billing rolled into other lines)
//   - Removes CO-04 from change_orders (per Zarina's restructure)
//   - Populates both period_month and cash_in_month on billing_entries
//     (same value for now, since the file is cash-in-indexed; future
//     iteration can use DETAIL sheet to derive billing dates separately)
//   - Updates SOV scheduled values to match the new file (6.01 +220k,
//     6.02 +63k, 6.03 +79k, 7.01 +32k, 7.02 +96k, 7.03 +15k, 7.04 +55k,
//     8.01 +124k, 8.02 +25k)
//   - Sets projects.contract_value to $3,586,152.09
//
// Usage:
//   node scripts/import-cashflow-v2.mjs [--project-id <uuid>] [--dry-run]

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
const PID = (() => {
  const i = args.indexOf("--project-id");
  return i >= 0 ? args[i + 1] : "53cff193-21e4-45ff-833d-43813e8578a0";
})();

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
const MO_ABBREV = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
function parseShortMonth(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^([A-Za-z]{3})-(\d{2})$/);
  if (!m) return null;
  const mo = MO_ABBREV[m[1].toLowerCase()];
  if (mo == null) return null;
  return `${(2000 + Number(m[2])).toString().padStart(4, "0")}-${String(mo + 1).padStart(2, "0")}-01`;
}

// ============ READ FILE ============

const buf = readFileSync("db/reference/cash-flow-20260529.xlsx");
const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
const cf = XLSX.utils.sheet_to_json(wb.Sheets["Sweet Springs Cash Flow"], {
  header: 1, defval: null, raw: false,
});

const hdr = cf[2] ?? [];
const monthByCol = new Map();
for (let c = 5; c < hdr.length; c++) {
  const iso = parseShortMonth(hdr[c]);
  if (iso) monthByCol.set(c, iso);
}
console.log(`Parsed ${monthByCol.size} month columns from Sweet Springs Cash Flow sheet`);

// Walk rows looking for item-number patterns in col 1
const parsedLines = [];
for (let i = 0; i < cf.length; i++) {
  const r = cf[i] ?? [];
  const item = r[1] == null ? null : String(r[1]).trim();
  if (!item) continue;
  if (!/^\d+\.\d+|^CO-\d+|^\d+\.\d{2}|^\d+\.00$/.test(item)) continue;
  const type = r[2] == null ? null : String(r[2]).trim();
  const desc = r[3] == null ? null : String(r[3]).trim();
  const sched = parseMoney(r[4]);
  const months = [];
  for (const [col, iso] of monthByCol) {
    const v = parseMoney(r[col]);
    if (v !== 0) months.push({ iso, amount: v });
  }
  parsedLines.push({ item, type, desc, sched, months, sortOrder: i });
}
console.log(`Parsed ${parsedLines.length} billing line items`);

const newSchedTotal = parsedLines.reduce((s, l) => s + l.sched, 0);
console.log(`Sum of scheduled values: $${newSchedTotal.toFixed(2)}`);

// Compute today's first-of-month for actual vs planned split
const today = new Date();
const todayMonthIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;

// ============ DRY RUN REPORT ============

if (dryRun) {
  console.log("");
  console.log("Lines to upsert:");
  for (const l of parsedLines) {
    console.log(`  ${l.item.padEnd(8)} ${(l.type ?? "").padEnd(22)} | sched $${l.sched.toFixed(2).padStart(14)} | ${l.months.length} month entries | ${l.desc}`);
  }
  console.log("");
  console.log("Lines to DELETE from Supabase (CO billings rolled into other lines):");
  console.log("  CO-01, CO-02, CO-04 (billing_lines)");
  console.log("change_orders to delete: CO-04 only (CO-01 + CO-02 stay)");
  console.log("");
  console.log(`projects.contract_value will be set to $${newSchedTotal.toFixed(2)}`);
  console.log("");
  console.log("Dry run - no writes performed.");
  process.exit(0);
}

// ============ WRITE ============

console.log("");
console.log("Writing to Supabase...");

// 1. Update or insert each parsed billing_line
const existingLines = await sb
  .from("billing_lines")
  .select("id, item_number")
  .eq("project_id", PID);
if (existingLines.error) throw existingLines.error;
const existingByItem = new Map((existingLines.data ?? []).map((l) => [l.item_number, l.id]));

for (const pl of parsedLines) {
  const update = {
    project_id: PID,
    item_number: pl.item,
    type: pl.type,
    description: pl.desc,
    scheduled_value: pl.sched,
    sort_order: pl.sortOrder,
  };
  const { error } = await sb
    .from("billing_lines")
    .upsert(update, { onConflict: "project_id,item_number" });
  if (error) throw new Error(`upsert ${pl.item}: ${error.message}`);
}
console.log(`  upserted ${parsedLines.length} billing_lines`);

// 2. Delete CO-01, CO-02, CO-04 billing_lines (their billing rolled into other rows)
const toDeleteLines = ["CO-01", "CO-02", "CO-04"];
for (const it of toDeleteLines) {
  const id = existingByItem.get(it);
  if (!id) continue;
  const { error } = await sb.from("billing_lines").delete().eq("id", id);
  if (error) throw new Error(`delete ${it}: ${error.message}`);
  console.log(`  deleted billing_line ${it}`);
}

// 3. Delete CO-04 from change_orders (CO-01 and CO-02 stay since they're real COs)
{
  const { error, count } = await sb
    .from("change_orders")
    .delete({ count: "exact" })
    .eq("project_id", PID)
    .eq("co_number", "CO-04");
  if (error) throw error;
  if (count) console.log(`  deleted change_orders CO-04 (${count} row)`);
}

// 4. Rebuild billing_entries for the imported lines
//    Approach: delete existing entries for each parsed line's billing_line_id,
//    then insert fresh entries from the Cash Flow sheet cells.
const { data: linesNow } = await sb
  .from("billing_lines")
  .select("id, item_number")
  .eq("project_id", PID);
const idByItem = new Map((linesNow ?? []).map((l) => [l.item_number, l.id]));

const lineIds = parsedLines
  .map((pl) => idByItem.get(pl.item))
  .filter((id) => !!id);

if (lineIds.length > 0) {
  const { error: delErr } = await sb
    .from("billing_entries")
    .delete()
    .in("billing_line_id", lineIds);
  if (delErr) throw delErr;
  console.log(`  cleared existing billing_entries for ${lineIds.length} lines`);
}

const newEntries = [];
for (const pl of parsedLines) {
  const lineId = idByItem.get(pl.item);
  if (!lineId) {
    console.log(`  WARN: no billing_line for ${pl.item} - skipping its entries`);
    continue;
  }
  for (const m of pl.months) {
    const isActual = m.iso <= todayMonthIso;
    newEntries.push({
      billing_line_id: lineId,
      period_month: m.iso,
      cash_in_month: m.iso,
      planned_amount: isActual ? 0 : m.amount,
      actual_amount: isActual ? m.amount : 0,
      status: isActual ? "approved" : "forecast",
    });
  }
}

const CHUNK = 200;
let written = 0;
for (let i = 0; i < newEntries.length; i += CHUNK) {
  const chunk = newEntries.slice(i, i + CHUNK);
  const { error } = await sb
    .from("billing_entries")
    .upsert(chunk, { onConflict: "billing_line_id,period_month" });
  if (error) throw new Error(`upsert entries (chunk ${i}): ${error.message}`);
  written += chunk.length;
}
console.log(`  upserted ${written} billing_entries`);

// 5. Set projects.contract_value
{
  const { error } = await sb
    .from("projects")
    .update({ contract_value: Math.round(newSchedTotal * 100) / 100 })
    .eq("id", PID);
  if (error) throw error;
  console.log(`  set projects.contract_value = $${newSchedTotal.toFixed(2)}`);
}

// 6. Confirm via summary view
const { data: sum } = await sb
  .from("v_project_billing_summary")
  .select("*")
  .eq("project_id", PID);
console.log("");
console.log("v_project_billing_summary after import:", sum);
console.log("");
console.log("Done.");
