// Spread the REMAINING budget (estimated_cost minus past actuals) for each
// AHC overhead cost code evenly across remaining future months as a flat
// monthly run rate.
//
// Default codes: SSC A through G (AHC Labor, General Conditions, Per Diem,
// Travel, Site Vehicles, Communication, Reimbursements). Per Phil 2026-05-29
// these are continuous "we're on site" costs, not schedule-driven.
//
// Behavior:
//   1. For each target cost code, compute past_actual = sum(actual_amount)
//      where period_month < current month.
//   2. remaining = estimated_cost - past_actual.
//   3. Determine future-month range:
//        start = first day of next month
//        end   = latest period_month already present anywhere in
//                cost_forecasts for this project (default end of project)
//   4. monthly_rate = remaining / num_months_in_range.
//   5. Upsert cost_forecasts.planned_amount = monthly_rate for each month
//      in the range. Leaves actual_amount alone.
//
// Usage:
//   node scripts/spread-overhead.mjs [--project-id <uuid>]
//                                    [--codes "SSC A,SSC B,..."]
//                                    [--end YYYY-MM-01]
//                                    [--dry-run]

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) {
  const t = l.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1);
}
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const PID = (() => {
  const i = args.indexOf("--project-id");
  return i >= 0 ? args[i + 1] : "53cff193-21e4-45ff-833d-43813e8578a0";
})();
const codesArg = (() => {
  const i = args.indexOf("--codes");
  return i >= 0 ? args[i + 1] : "SSC A,SSC B,SSC C,SSC D,SSC E,SSC F,SSC G";
})();
const endArg = (() => {
  const i = args.indexOf("--end");
  return i >= 0 ? args[i + 1] : null;
})();
const TARGET_CODES = codesArg.split(",").map((s) => s.trim().toUpperCase());

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ============ HELPERS ============

const today = new Date();
const todayMonthIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
const nextMonthIso = (() => {
  const d = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
})();

function addMonths(iso, n) {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function monthsBetween(startIso, endIso) {
  const months = [];
  let cur = startIso;
  while (cur <= endIso) {
    months.push(cur);
    cur = addMonths(cur, 1);
  }
  return months;
}

function fmt(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

// ============ FETCH ============

const { data: allCodes } = await sb
  .from("cost_codes")
  .select("id, code, name, estimated_cost")
  .eq("project_id", PID);

const targets = (allCodes ?? []).filter((c) =>
  TARGET_CODES.includes(String(c.code).trim().toUpperCase()),
);
if (targets.length === 0) {
  console.error(`No cost codes matched: ${TARGET_CODES.join(", ")}`);
  process.exit(1);
}
console.log(`Targeting ${targets.length} codes: ${targets.map((c) => c.code).join(", ")}`);

// Determine end month: max(period_month) across the whole project's
// cost_forecasts (or use --end override).
let endIso = endArg;
if (!endIso) {
  const { data: maxRow } = await sb
    .from("cost_forecasts")
    .select("period_month, cost_codes!inner(project_id)")
    .eq("cost_codes.project_id", PID)
    .order("period_month", { ascending: false })
    .limit(1)
    .maybeSingle();
  endIso = maxRow?.period_month ?? null;
}
if (!endIso) {
  console.error("Could not determine project end month. Pass --end YYYY-MM-01.");
  process.exit(1);
}
console.log(`Range: ${nextMonthIso} -> ${endIso}`);

const range = monthsBetween(nextMonthIso, endIso);
if (range.length === 0) {
  console.error(`No months in range (next=${nextMonthIso}, end=${endIso}).`);
  process.exit(1);
}
console.log(`${range.length} months in the spread range`);

// Fetch existing forecasts for these codes
const targetIds = targets.map((c) => c.id);
const { data: existing } = await sb
  .from("cost_forecasts")
  .select("cost_code_id, period_month, planned_amount, actual_amount")
  .in("cost_code_id", targetIds);
const byCode = new Map();
for (const f of existing ?? []) {
  if (!byCode.has(f.cost_code_id)) byCode.set(f.cost_code_id, new Map());
  byCode.get(f.cost_code_id).set(f.period_month, f);
}

// ============ COMPUTE + WRITE ============

console.log("");
console.log("Code   | Estimated     | Past actual   | Remaining     | /mo (new)    | /mo (old)");
console.log("-------|---------------|---------------|---------------|--------------|--------------");

const writes = [];
for (const c of targets) {
  const months = byCode.get(c.id) ?? new Map();
  let pastActual = 0;
  let oldPlannedInRange = 0;
  for (const [iso, f] of months) {
    if (iso < todayMonthIso) {
      pastActual += Number(f.actual_amount ?? 0);
    } else if (range.includes(iso)) {
      oldPlannedInRange += Number(f.planned_amount ?? 0);
    }
  }
  const remaining = Number(c.estimated_cost ?? 0) - pastActual;
  const perMonthNew = remaining / range.length;
  const perMonthOld = oldPlannedInRange / range.length;
  console.log(
    `${c.code.padEnd(7)}| ${fmt(Number(c.estimated_cost ?? 0)).padStart(13)} | ${fmt(pastActual).padStart(13)} | ${fmt(remaining).padStart(13)} | ${fmt(perMonthNew).padStart(12)} | ${fmt(perMonthOld).padStart(12)}`,
  );
  if (remaining <= 0) {
    console.log(`        skipping - already spent over the estimate`);
    continue;
  }
  for (const iso of range) {
    const existingRow = months.get(iso);
    writes.push({
      cost_code_id: c.id,
      period_month: iso,
      planned_amount: Math.round(perMonthNew * 100) / 100,
      actual_amount: existingRow ? Number(existingRow.actual_amount ?? 0) : 0,
    });
  }
}

console.log("");
console.log(`Will upsert ${writes.length} cost_forecasts rows (${range.length} months x ${targets.length} codes)`);

if (dryRun) {
  console.log("");
  console.log("Dry run - no writes performed.");
  process.exit(0);
}

const CHUNK = 200;
let written = 0;
for (let i = 0; i < writes.length; i += CHUNK) {
  const chunk = writes.slice(i, i + CHUNK);
  const { error } = await sb
    .from("cost_forecasts")
    .upsert(chunk, { onConflict: "cost_code_id,period_month" });
  if (error) throw new Error(`upsert failed: ${error.message}`);
  written += chunk.length;
}
console.log(`Wrote ${written} cost_forecasts rows`);
