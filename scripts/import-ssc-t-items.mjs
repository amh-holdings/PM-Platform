// One-shot: imports SSC T.1 through SSC T.15 (16 lines including the
// duplicate-labeled T.12) from the Sweet Springs Cash Flow sheet into
// cost_codes for the Sweet Springs project.
//
// Per Phil 2026-06-11: don't adjust anything else, just add these lines
// until Main Components.

import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SSS_PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
const SHEET_PATH = "db/reference/cash-flow-20260529.xlsx";
const SHEET_NAME = "Sweet Springs Cash Flow";

const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const fmt = (n) =>
  "$" +
  Number(n ?? 0).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

const buf = readFileSync(SHEET_PATH);
const wb = XLSX.read(buf, { type: "buffer" });
const ws = wb.Sheets[SHEET_NAME];
if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found`);
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

// Find rows that match "SSC T.<digit>" - these are the equipment items.
function parseSscT(label) {
  if (!label) return null;
  const m = String(label).match(/SSC\s+T\.(\d+)\s*(.*)/i);
  if (!m) return null;
  return { num: Number(m[1]), name: m[2].trim() };
}

const items = [];
let seenCodes = new Map(); // code -> count for dedup
for (let i = 0; i < rows.length; i++) {
  const row = rows[i] ?? [];
  // col 0 = actuals to date, col 1 = label, col 2 = budgeted, col 3 = actuals+proj
  const parsed = parseSscT(row[1]);
  if (!parsed) continue;
  const actuals = Number(row[0] ?? 0);
  const budgeted = row[2] == null ? null : Number(row[2]);
  const actualsPlusProjections = row[3] == null ? null : Number(row[3]);

  // Resolve duplicate codes by appending a letter (T.12 + T.12 -> T.12 + T.12b).
  let code = `SSC T.${parsed.num}`;
  const prevCount = seenCodes.get(code) ?? 0;
  if (prevCount > 0) {
    code = `${code}${String.fromCharCode(97 + prevCount)}`; // b, c, ...
  }
  seenCodes.set(`SSC T.${parsed.num}`, prevCount + 1);

  items.push({
    sourceRow: i,
    code,
    name: parsed.name || `Equipment item ${parsed.num}`,
    description: `SSC T.${parsed.num}${prevCount > 0 ? " (duplicate label in source)" : ""}`,
    estimated_cost: budgeted,
    actual_cost: actuals,
    actuals_plus_projections: actualsPlusProjections,
  });
}

console.log(`Found ${items.length} SSC T.x lines in the sheet:\n`);
console.log("Code         Name                                    Budget        Actuals       Act+Proj");
console.log("-".repeat(115));
for (const it of items) {
  console.log(
    `${it.code.padEnd(13)}${it.name.slice(0, 40).padEnd(42)}${fmt(it.estimated_cost).padStart(12)}  ${fmt(it.actual_cost).padStart(12)}  ${fmt(it.actuals_plus_projections).padStart(12)}`,
  );
}

const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
  console.log("\n--dry-run: no inserts performed");
  process.exit(0);
}

// Pull existing codes to skip duplicates (safe to re-run).
const { data: existing } = await sb
  .from("cost_codes")
  .select("code")
  .eq("project_id", SSS_PROJECT_ID);
const existingSet = new Set((existing ?? []).map((r) => r.code));

let inserted = 0,
  skipped = 0;

// Find highest existing sort_order so the new items don't collide.
const { data: maxSort } = await sb
  .from("cost_codes")
  .select("sort_order")
  .eq("project_id", SSS_PROJECT_ID)
  .order("sort_order", { ascending: false, nullsFirst: false })
  .limit(1);
let nextSort = Number(maxSort?.[0]?.sort_order ?? 0) + 1;

for (const it of items) {
  if (existingSet.has(it.code)) {
    console.log(`  skip ${it.code} (already exists)`);
    skipped++;
    continue;
  }
  const { error } = await sb.from("cost_codes").insert({
    project_id: SSS_PROJECT_ID,
    code: it.code,
    name: it.name,
    description: it.description,
    estimated_cost: it.estimated_cost,
    actual_cost: it.actual_cost,
    sort_order: nextSort++,
  });
  if (error) {
    console.error(`  FAILED ${it.code}: ${error.message}`);
    continue;
  }
  console.log(`  + ${it.code}`);
  inserted++;
}

console.log(`\nDone. Inserted ${inserted}, skipped ${skipped}.`);
