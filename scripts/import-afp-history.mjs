// Backfill the AFPs that went out between AFP 8 (Dec 2025) and the current
// application, so a new AFP's "previous billings" and G703 column D are right.
//
// WHY THIS EXISTS
// AFP 1-8 were loaded by scripts/import-collections.mjs and reconcile cleanly.
// Everything after that drifted: pay_applications holds a single "AFP 9" draft
// with stale header totals and zero stamped entries, and the 2026-06 / 2026-07
// billing_entries still sit at status='forecast' with July carrying only a
// planned amount. createPayApplication (post-fix) counts a prior-month row as
// previously billed only when actual_amount > 0 or the row shows billing
// evidence, so those months contribute $0 until they are corrected here.
//
// HOW TO USE
//   1. Fill in HISTORY below from the real submitted AFPs, one row per
//      (afp, period_month, SOV item_number, amount).
//   2. node scripts/import-afp-history.mjs --dry-run
//      Reconciles each AFP against its EXPECTED_TOTALS entry and prints every
//      write it would make. Nothing is written.
//   3. node scripts/import-afp-history.mjs
//      Backs up billing_entries, then applies.
//   4. Add --create-records to also create pay_applications rows for the
//      backfilled AFPs (audit trail). Safe to run separately, later.
//
// Amounts are the WORK COMPLETED THIS PERIOD for that SOV line on that AFP -
// gross, before retainage. Retainage is derived, not entered.

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
const CREATE_RECORDS = process.argv.includes("--create-records");

// ---------------------------------------------------------------------------
// FILL THIS IN. One entry per AFP.
//
//   afp        - label exactly as submitted ("AFP 10", "AFP 11R", ...)
//   periodMonth- YYYY-MM the work was performed (drives billing_entries)
//   submittedAt- YYYY-MM-DD, or null
//   paidAt     - YYYY-MM-DD if collected, else null
//   retainagePct - the rate on that application (Sweet Springs default is 10)
//   lines      - { "<SOV item_number>": <gross amount this period> }
//   expectedTotal - the gross total on the submitted AFP, used as a checksum
// ---------------------------------------------------------------------------
const HISTORY = [
  // {
  //   afp: "AFP 9",
  //   periodMonth: "2026-05",
  //   submittedAt: "2026-06-05",
  //   paidAt: "2026-07-05",
  //   retainagePct: 10,
  //   expectedTotal: 79160.0,
  //   lines: { "6.01": 79160.0 },
  // },
  // {
  //   afp: "AFP 10",
  //   periodMonth: "2026-06",
  //   submittedAt: null,
  //   paidAt: null,
  //   retainagePct: 10,
  //   expectedTotal: 280381.0,
  //   lines: { "6.01": 160381.0, "6.02": 80000.0, "6.03": 40000.0 },
  // },
  // {
  //   afp: "AFP 11",
  //   periodMonth: "2026-07",
  //   submittedAt: null,
  //   paidAt: null,
  //   retainagePct: 10,
  //   expectedTotal: 255088.0,
  //   lines: { "5.05": 168335.0, "5.07": 10000.0, "6.02": 35218.0, "6.03": 41534.0 },
  // },
];

// ---------------------------------------------------------------------------

const money = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fail = (msg) => {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
};

if (HISTORY.length === 0) {
  fail(
    "HISTORY is empty. Fill in the AFPs to backfill (see the header comment) before running.",
  );
}

// --- Load the SOV so item_number -> billing_line_id, and validate ------------
const { data: lines, error: linesErr } = await sb
  .from("billing_lines")
  .select("id, item_number, description, scheduled_value")
  .eq("project_id", PID);
if (linesErr) fail(`Could not read billing_lines: ${linesErr.message}`);

const lineByItem = new Map(lines.map((l) => [String(l.item_number).trim(), l]));

// Validate every referenced SOV item exists before touching anything.
const unknown = [];
for (const h of HISTORY) {
  for (const item of Object.keys(h.lines)) {
    if (!lineByItem.has(item.trim())) unknown.push(`${h.afp} -> "${item}"`);
  }
}
if (unknown.length > 0) {
  console.error("\nUnknown SOV item numbers:");
  unknown.forEach((u) => console.error(`  ${u}`));
  console.error("\nValid item numbers on this project:");
  console.error("  " + [...lineByItem.keys()].join(", "));
  process.exit(1);
}

// --- Reconcile each AFP against its stated total ----------------------------
console.log(`Project ${PID}`);
console.log(`Mode: ${DRY ? "DRY RUN (no writes)" : "APPLY"}${CREATE_RECORDS ? " + create pay_applications records" : ""}\n`);
console.log("=== RECONCILIATION ===");
let reconcileFailed = false;
for (const h of HISTORY) {
  const sum = Object.values(h.lines).reduce((s, v) => s + Number(v || 0), 0);
  const delta = sum - Number(h.expectedTotal ?? sum);
  const okMark = Math.abs(delta) < 0.005 ? "OK  " : "FAIL";
  if (okMark === "FAIL") reconcileFailed = true;
  console.log(
    `  ${okMark} ${h.afp.padEnd(10)} ${h.periodMonth}  lines=${String(Object.keys(h.lines).length).padStart(2)}  sum=${money(sum).padStart(14)}  stated=${money(h.expectedTotal).padStart(14)}${okMark === "FAIL" ? `  delta=${money(delta)}` : ""}`,
  );
}
if (reconcileFailed) {
  fail("At least one AFP's line amounts do not sum to its stated total. Fix HISTORY and re-run.");
}

// --- Check for AFP numbers that already exist -------------------------------
const { data: existingApps } = await sb
  .from("pay_applications")
  .select("app_number")
  .eq("project_id", PID);
const existingAppNumbers = new Set((existingApps ?? []).map((a) => a.app_number));

// --- Build the planned writes ----------------------------------------------
const lineIds = lines.map((l) => l.id);
const { data: existingEntries, error: entriesErr } = await sb
  .from("billing_entries")
  .select("id, billing_line_id, period_month, planned_amount, actual_amount, status, afp_number, pay_application_id")
  .in("billing_line_id", lineIds);
if (entriesErr) fail(`Could not read billing_entries: ${entriesErr.message}`);

const entryKey = (lineId, month) => `${lineId}|${month}-01`;
const entryByKey = new Map(
  (existingEntries ?? []).map((e) => [entryKey(e.billing_line_id, e.period_month.slice(0, 7)), e]),
);

const writes = [];
for (const h of HISTORY) {
  for (const [item, amount] of Object.entries(h.lines)) {
    const line = lineByItem.get(item.trim());
    const periodDate = `${h.periodMonth}-01`;
    const existing = entryByKey.get(entryKey(line.id, h.periodMonth));
    const retainage = Number(amount) * (Number(h.retainagePct ?? 0) / 100);
    const patch = {
      actual_amount: Number(amount),
      retainage_amount: Math.round(retainage * 100) / 100,
      afp_number: h.afp,
      status: h.paidAt ? "paid" : h.submittedAt ? "submitted" : "approved",
      submitted_at: h.submittedAt,
      paid_at: h.paidAt,
    };
    writes.push({
      afp: h.afp,
      item,
      description: line.description,
      periodDate,
      existingId: existing?.id ?? null,
      before: existing
        ? { planned: Number(existing.planned_amount ?? 0), actual: Number(existing.actual_amount ?? 0), status: existing.status }
        : null,
      billingLineId: line.id,
      patch,
    });
  }
}

console.log("\n=== PLANNED WRITES ===");
for (const w of writes) {
  const action = w.existingId ? "UPDATE" : "INSERT";
  const before = w.before
    ? `was planned=${money(w.before.planned)} actual=${money(w.before.actual)} status=${w.before.status}`
    : "no existing row";
  console.log(
    `  ${action} ${w.afp.padEnd(10)} ${w.periodDate}  ${String(w.item).padEnd(7)} -> actual=${money(w.patch.actual_amount).padStart(14)} ret=${money(w.patch.retainage_amount).padStart(12)} status=${w.patch.status}`,
  );
  console.log(`         ${before}  |  ${String(w.description ?? "").slice(0, 60)}`);
}

if (CREATE_RECORDS) {
  console.log("\n=== PLANNED pay_applications RECORDS ===");
  for (const h of HISTORY) {
    if (existingAppNumbers.has(h.afp)) {
      console.log(`  SKIP   ${h.afp} - a pay_applications row with this number already exists`);
    } else {
      console.log(`  CREATE ${h.afp} for ${h.periodMonth} (retainage ${h.retainagePct}%)`);
    }
  }
}

if (DRY) {
  console.log("\n[dry-run] Nothing written. Re-run without --dry-run to apply.");
  process.exit(0);
}

// --- Back up before writing -------------------------------------------------
mkdirSync("scripts/_backups", { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const bkp = `scripts/_backups/billing_entries_${ts}.json`;
writeFileSync(bkp, JSON.stringify(existingEntries, null, 1));
console.log(`\nBacked up ${existingEntries.length} billing_entries -> ${bkp}`);

// --- Apply ------------------------------------------------------------------
let updated = 0;
let inserted = 0;
let errors = 0;
for (const w of writes) {
  if (w.existingId) {
    const { error } = await sb.from("billing_entries").update(w.patch).eq("id", w.existingId);
    if (error) {
      errors++;
      console.error(`  ERR update ${w.afp} ${w.item}: ${error.message}`);
    } else updated++;
  } else {
    const { error } = await sb.from("billing_entries").insert({
      billing_line_id: w.billingLineId,
      period_month: w.periodDate,
      planned_amount: 0,
      ...w.patch,
    });
    if (error) {
      errors++;
      console.error(`  ERR insert ${w.afp} ${w.item}: ${error.message}`);
    } else inserted++;
  }
}
console.log(`\nbilling_entries: ${updated} updated, ${inserted} inserted, ${errors} errors.`);

// --- Optionally create the pay_applications audit records -------------------
if (CREATE_RECORDS) {
  for (const h of HISTORY) {
    if (existingAppNumbers.has(h.afp)) continue;
    const [y, m] = h.periodMonth.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const total = Object.values(h.lines).reduce((s, v) => s + Number(v || 0), 0);
    const retainage = total * (Number(h.retainagePct ?? 0) / 100);

    const { data: app, error: appErr } = await sb
      .from("pay_applications")
      .insert({
        project_id: PID,
        app_number: h.afp,
        period_start: `${h.periodMonth}-01`,
        period_end: `${h.periodMonth}-${String(lastDay).padStart(2, "0")}`,
        status: h.paidAt ? "paid" : h.submittedAt ? "submitted" : "approved",
        total_completed: Math.round(total * 100) / 100,
        total_retainage: Math.round(retainage * 100) / 100,
        amount_due: Math.round((total - retainage) * 100) / 100,
        submitted_at: h.submittedAt,
        paid_at: h.paidAt,
        notes: "Backfilled from the submitted AFP by scripts/import-afp-history.mjs",
      })
      .select("id")
      .single();
    if (appErr || !app) {
      console.error(`  ERR create ${h.afp}: ${appErr?.message}`);
      continue;
    }

    // Stamp this AFP's entries onto the record so the link is navigable.
    for (const item of Object.keys(h.lines)) {
      const line = lineByItem.get(item.trim());
      await sb
        .from("billing_entries")
        .update({ pay_application_id: app.id })
        .eq("billing_line_id", line.id)
        .eq("period_month", `${h.periodMonth}-01`);
    }
    console.log(`  Created ${h.afp} (${app.id})`);
  }
}

console.log("\nDone.");
