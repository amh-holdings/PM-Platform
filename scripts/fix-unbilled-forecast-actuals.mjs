// Move actual_amount -> planned_amount on billing_entries that were never
// actually billed.
//
// WHY. scripts/import-cashflow*.mjs loaded the owner cash-flow workbook into
// actual_amount for months that were only ever projections. On Sweet Springs
// that left 2026-06 carrying $160,381 (6.01), $80,000 (6.02) and $40,000 (6.03)
// with status='forecast', no afp_number, no pay_application_id and no
// submitted_at/paid_at - for civil work that had not happened. The first field
// report on the job is dated 2026-08-04, and Phil confirmed (2026-08-19) there
// was no civil work in June or July; AFP 10 and 11 were change-order
// applications against different lines.
//
// This matters because v_billing_line_totals computes
//   total_billed     = sum(actual_amount)      -- no status filter
//   remaining_to_bill = scheduled_value - sum(actual_amount)
// so those rows read as $120,000 of civil already billed. That suppresses the
// first legitimate civil billing on AFP 12 and overstates completion on the
// G703.
//
// A row is moved only when it has NO billing evidence at all. Anything carrying
// an afp_number, a pay_application_id, or a status past 'forecast' is left
// alone - so AFP 1-8 and the 2026-05 'approved' row are untouched.
//
//   node scripts/fix-unbilled-forecast-actuals.mjs --dry-run
//   node scripts/fix-unbilled-forecast-actuals.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PID = process.env.PROJECT_ID || "53cff193-21e4-45ff-833d-43813e8578a0";
const DRY = process.argv.includes("--dry-run");
const BILLED = new Set(["on_pay_app", "submitted", "approved", "paid"]);
const money = (n) => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const { data: lines } = await sb
  .from("billing_lines")
  .select("id, item_number, description")
  .eq("project_id", PID);
const byId = Object.fromEntries(lines.map((l) => [l.id, l]));

const { data: entries } = await sb
  .from("billing_entries")
  .select("*")
  .in("billing_line_id", lines.map((l) => l.id));

const evidence = (e) =>
  !!e.pay_application_id || !!e.afp_number || BILLED.has(e.status ?? "");

const targets = entries.filter(
  (e) => Number(e.actual_amount ?? 0) > 0 && !evidence(e),
);
const kept = entries.filter((e) => Number(e.actual_amount ?? 0) > 0 && evidence(e));

console.log(`Project ${PID}   mode: ${DRY ? "DRY RUN" : "APPLY"}\n`);
console.log(`=== LEFT ALONE (real billings, ${kept.length} rows) ===`);
const keptBy = {};
for (const e of kept) {
  const k = `${e.period_month.slice(0, 7)} ${e.afp_number ?? e.status}`;
  keptBy[k] = (keptBy[k] ?? 0) + Number(e.actual_amount);
}
Object.keys(keptBy).sort().forEach((k) => console.log(`  ${k.padEnd(24)} ${money(keptBy[k])}`));

console.log(`\n=== MOVED actual -> planned (no billing evidence, ${targets.length} rows) ===`);
let total = 0;
for (const e of targets.sort((a, b) => a.period_month.localeCompare(b.period_month))) {
  const l = byId[e.billing_line_id];
  const amt = Number(e.actual_amount);
  total += amt;
  const plannedAfter = Math.max(Number(e.planned_amount ?? 0), amt);
  console.log(
    `  ${e.period_month} ${String(l?.item_number).padEnd(7)} actual ${money(amt).padStart(10)} -> planned ${money(plannedAfter).padStart(10)}  (was planned ${money(e.planned_amount ?? 0)}, status=${e.status})  ${String(l?.description ?? "").slice(0, 40)}`,
  );
}
console.log(`  TOTAL reclassified: ${money(total)}`);

if (DRY) {
  console.log("\n[dry-run] Nothing written.");
  process.exit(0);
}

mkdirSync("scripts/_backups", { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const bkp = `scripts/_backups/billing_entries_${ts}.json`;
writeFileSync(bkp, JSON.stringify(entries, null, 1));
console.log(`\nBacked up ${entries.length} rows -> ${bkp}`);

let ok = 0, err = 0;
for (const e of targets) {
  const { error } = await sb
    .from("billing_entries")
    .update({
      planned_amount: Math.max(Number(e.planned_amount ?? 0), Number(e.actual_amount)),
      actual_amount: 0,
    })
    .eq("id", e.id);
  if (error) { err++; console.error(`  ERR ${e.id}: ${error.message}`); } else ok++;
}
console.log(`\nUpdated ${ok} rows (${err} errors).`);
