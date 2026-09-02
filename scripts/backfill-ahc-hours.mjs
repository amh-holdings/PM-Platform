/**
 * Backfill AHC staff hours onto CM daily logs that were finalized before the
 * hours were required.
 *
 * Phil's instruction (2026-09-02): one AHC person on site, 6:30 AM to 5:00 PM,
 * for every finalized log that has none recorded. That is 10.5 hours elapsed.
 *
 * This is a STATED figure, not a counted one. It is being written because a
 * null blocks the owner's monthly report entirely and an honest standing
 * assumption beats a permanent gap - but nothing downstream can tell it apart
 * from a day somebody actually counted, so the provenance belongs in the
 * monthly report's backup-sheet note as well as here.
 *
 * Only touches rows where ahc_man_hours IS NULL. Never overwrites a real entry.
 * Only touches status='final'. Drafts are still reachable by the finalize gate.
 *
 *   node scripts/backfill-ahc-hours.mjs           # dry run
 *   node scripts/backfill-ahc-hours.mjs --apply   # write
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const raw = readFileSync(".env.local", "utf8"); const env = {};
for (const l of raw.split("\n")) { const t=l.trim(); if(!t||t.startsWith("#"))continue; const i=t.indexOf("="); env[t.slice(0,i)]=t.slice(i+1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });

const PROJECT = process.argv.find(a => a.startsWith("--project="))?.split("=")[1]
  ?? "53cff193-21e4-45ff-833d-43813e8578a0"; // Sweet Springs Solar
const HEADCOUNT = 1;
const HOURS = 10.5; // 06:30 -> 17:00
const APPLY = process.argv.includes("--apply");

const { data: rows, error } = await sb
  .from("cm_daily_logs")
  .select("id, log_date, status, ahc_headcount, ahc_man_hours")
  .eq("project_id", PROJECT)
  .order("log_date");
if (error) { console.error(error.message); process.exit(1); }

const finalized = rows.filter(r => r.status === "final");
const targets   = finalized.filter(r => r.ahc_man_hours == null || r.ahc_headcount == null);
const already   = finalized.filter(r => r.ahc_man_hours != null && r.ahc_headcount != null);
const drafts    = rows.filter(r => r.status !== "final");

console.log(`${rows.length} CM logs: ${finalized.length} finalized, ${drafts.length} draft`);
console.log(`  ${targets.length} finalized logs to backfill at ${HEADCOUNT} person x ${HOURS} hrs`);
console.log(`  ${already.length} finalized logs already have hours - left alone`);
if (drafts.length) {
  console.log(`  drafts NOT touched (the finalize gate still applies to them): ${drafts.map(d => d.log_date).join(", ")}`);
}

// What each month's total gains, so the change to the owner's number is visible
// before it is made rather than discovered on the report afterwards.
const byMonth = new Map();
for (const t of targets) {
  const m = t.log_date.slice(0, 7);
  byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
}
console.log("\nEffect on each month's reported man-hours:");
for (const [m, n] of [...byMonth].sort()) {
  console.log(`  ${m}: +${n} day${n === 1 ? "" : "s"} = +${(n * HOURS).toFixed(1)} hours`);
}

if (!APPLY) {
  console.log(`\nDRY RUN - nothing written. Re-run with --apply.`);
  console.log(`Dates: ${targets.map(t => t.log_date).join(", ")}`);
  process.exit(0);
}

let done = 0;
for (const t of targets) {
  const { error: e } = await sb
    .from("cm_daily_logs")
    .update({ ahc_headcount: HEADCOUNT, ahc_man_hours: HOURS, updated_at: new Date().toISOString() })
    .eq("id", t.id);
  if (e) { console.error(`  ${t.log_date}: ${e.message}`); continue; }
  done++;
}
console.log(`\nWrote ${done} of ${targets.length}.`);

const { data: after } = await sb
  .from("cm_daily_logs")
  .select("log_date, status, ahc_headcount, ahc_man_hours")
  .eq("project_id", PROJECT)
  .eq("status", "final")
  .is("ahc_man_hours", null);
console.log(`Finalized logs still missing hours: ${after?.length ?? "?"}`);
