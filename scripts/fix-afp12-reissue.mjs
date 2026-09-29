/**
 * Bring AFP 12 into line with the version actually issued to the owner.
 *
 * AFP 12 was submitted 2026-08-20. Dimension commented on it 2026-08-21, and a
 * revised application was reissued 2026-09-01. The platform still carries the
 * ORIGINAL submission, so two site-work lines are wrong, and those numbers are
 * what AFP 13 will read as "from previous application".
 *
 *   6.02 Civil, Roads      $88,963.74 -> $93,018.00   (22.52%)
 *   6.03 Fencing/SWPPP     $93,000.08 -> $79,936.00   (39.22%)
 *   this period total     $390,459.71 -> $381,449.89
 *
 * Verified against the reissued G703: eighteen of twenty lines already tie to
 * the penny, and the sheet's "from previous application" total of
 * $1,497,104.01 matches this project's cumulative through AFP 11 exactly, which
 * is what identifies the document as AFP 12 despite its header cells reading
 * "Application No. 10 / Period to 31-Jul-26".
 *
 * WHAT IS NOT TOUCHED
 * total_retainage and amount_due. The reissued sheet's column I totals
 * $28,547.77, which is cumulative retainage held through AFP 11 and contains
 * nothing for AFP 12's own period. Whether $19,072.49 should have been held is
 * a question for the G702, and a money field is not the place to guess.
 * status and approved_at likewise wait on the approval date.
 *
 * Every write asserts the current value first, so a second run is a no-op
 * rather than a double correction.
 *
 * Dry run by default. Pass --apply to write.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0,i)] = t.slice(i+1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const usd = (n) => "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// item -> [was, now, pct, balance]
const FIX = {
  "6.02": [88963.74, 93018.00, 22.52, 320027.92],
  "6.03": [93000.08, 79936.00, 39.22, 123899.79],
};
const PERIOD = "2026-08-01";
const TOTAL_WAS = 390459.71, TOTAL_NOW = 381449.89;
const NOTE_ADD =
  " Reissued 2026-09-01 after owner comments of 2026-08-21: 6.02 raised from $88,963.74 to $93,018.00 and 6.03 reduced from $93,000.08 to $79,936.00. Figures above are the original submission.";

const { data: app } = await sb.from("pay_applications").select("id, app_number, total_completed, notes").eq("project_id", PID).eq("app_number", "AFP 12").maybeSingle();
if (!app) throw new Error("AFP 12 not found");
const { data: lines } = await sb.from("billing_lines").select("id, item_number").eq("project_id", PID).in("item_number", Object.keys(FIX));
const { data: pals } = await sb.from("pay_application_lines").select("id, item_number, work_completed_this_period, total_completed_and_stored, pct_complete, balance_to_finish").eq("pay_application_id", app.id).in("item_number", Object.keys(FIX));

const writes = [];
for (const [item, [was, now, pct, bal]] of Object.entries(FIX)) {
  const line = lines.find((l) => l.item_number === item);
  if (!line) throw new Error(`billing line ${item} not found`);
  const { data: entries } = await sb.from("billing_entries").select("id, actual_amount, period_month").eq("billing_line_id", line.id).eq("period_month", PERIOD);
  if (entries.length !== 1) throw new Error(`${item}: expected exactly 1 entry for ${PERIOD}, found ${entries.length}`);
  const e = entries[0];
  if (eq(e.actual_amount, now)) { console.log(`  ${item} entry already ${usd(now)} - skipping`); }
  else if (!eq(e.actual_amount, was)) throw new Error(`${item}: entry reads ${usd(e.actual_amount)}, expected ${usd(was)}. Aborting.`);
  else writes.push({ what: `billing_entries ${item} ${PERIOD}`, table: "billing_entries", id: e.id, from: usd(was), to: usd(now), patch: { actual_amount: now } });

  const pal = pals.find((p) => p.item_number === item);
  if (!pal) throw new Error(`AFP 12 snapshot line ${item} not found`);
  if (eq(pal.work_completed_this_period, now)) { console.log(`  ${item} snapshot already ${usd(now)} - skipping`); }
  else if (!eq(pal.work_completed_this_period, was)) throw new Error(`${item}: snapshot reads ${usd(pal.work_completed_this_period)}, expected ${usd(was)}. Aborting.`);
  else writes.push({ what: `pay_application_lines ${item}`, table: "pay_application_lines", id: pal.id, from: `${usd(was)} / ${pal.pct_complete}%`, to: `${usd(now)} / ${pct}%`,
    patch: { work_completed_this_period: now, total_completed_and_stored: now, pct_complete: pct, balance_to_finish: bal } });
}

if (eq(app.total_completed, TOTAL_NOW)) console.log(`  header total already ${usd(TOTAL_NOW)} - skipping`);
else if (!eq(app.total_completed, TOTAL_WAS)) throw new Error(`header reads ${usd(app.total_completed)}, expected ${usd(TOTAL_WAS)}. Aborting.`);
else writes.push({ what: "pay_applications AFP 12 header", table: "pay_applications", id: app.id, from: usd(TOTAL_WAS), to: usd(TOTAL_NOW),
  patch: { total_completed: TOTAL_NOW, notes: (app.notes ?? "").trim() + NOTE_ADD } });

console.log(`\n${writes.length} write(s):\n`);
for (const w of writes) console.log(`  ${w.what.padEnd(40)} ${w.from}  ->  ${w.to}`);

if (!APPLY) { console.log("\nDRY RUN - re-run with --apply to write."); process.exit(0); }
for (const w of writes) {
  const { error } = await sb.from(w.table).update(w.patch).eq("id", w.id);
  if (error) throw new Error(`${w.what}: ${error.message}`);
  console.log(`  applied: ${w.what}`);
}
console.log("\ndone. total_retainage, amount_due, status and approved_at left untouched.");
