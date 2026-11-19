// The percent column never caught up with the statuses, 2026-11-19.
//
// Zarina, looking at the Award branch: "Can you apply the actual percentages
// on the in progress tasks? Also I am seeing inconsistencies."
//
// The inconsistency is real and it is not cosmetic. Three whole branches -
// 0.1.1 LNTP Engineering & Design, 0.2.1 Civil, 0.2.3 Electrical - read 0%
// while every single leaf under them is Complete. Row 27 Electrical shows a
// green dot and 0% on the same line.
//
// WHY. schedule-task-type.progressFromStatus is the rule: on a deliverable,
// procurement or inspection row, status Complete writes 100. It fires in the
// server action when somebody CHANGES a status in the grid. These 17 rows
// never went through it - they arrived as Complete in an import - so the rule
// never ran and the percent stayed null. Nothing was wrong with the rule;
// it was simply never applied to rows that did not pass through the UI.
//
// This is not a guess. It writes exactly what the app itself would have
// written had each status been clicked, on exactly the types the app allows
// it on. Construction is excluded, as always: a percent there belongs to an
// approved field report, and this script will not manufacture one.
//
// Phase 2 is the ten 2027 construction rows carrying no status at all. They
// render with no dot now, which reads as broken. All ten are future-dated
// with no percent and no field report, so Not Started is a statement of fact.
// It changes no money: estimateTaskProgress already returns 0 for them by
// date interpolation, and "Not Started" returns the same 0 with more
// confidence.
//
// What this does NOT do is put numbers on In Progress rows. The app has no
// record of how far along those are, and inventing one would push it into the
// sub-billing verifier and the cash-flow forecast. Those are listed for Phil
// and Zarina to fill in by hand.
//
//   npx tsx scripts/schedule/backfill-complete-percent-2026-11-19.mts
//   npx tsx scripts/schedule/backfill-complete-percent-2026-11-19.mts --apply
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { progressCanBeSetByHand } from "../../src/lib/schedule-task-type";

const APPLY = process.argv.includes("--apply");
const TODAY = "2026-11-19";

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
try {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i)] = t.slice(i + 1);
  }
} catch {
  // Cloud session: the environment's own variables are the source.
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const norm = (s: string | null | undefined) => (s ?? "").trim();
const isDone = (s: string | null | undefined) => norm(s) === "Complete" || norm(s) === "Approved";

const { data: projects, error: pErr } = await sb.from("projects").select("id, name");
if (pErr) throw pErr;

let totalPct = 0;
let totalStatus = 0;
const wip: string[] = [];

for (const p of projects ?? []) {
  const { data, error } = await sb
    .from("schedule_tasks")
    .select("id, wbs_code, task_name, status, task_type, pct_complete, start_date, end_date")
    .eq("project_id", p.id)
    .order("wbs_code");
  if (error) throw error;
  const rows = data ?? [];
  if (!rows.length) continue;

  // A summary row has no percent of its own; it is rolled up from its leaves.
  const isSummary = (c: string) => rows.some((x) => x.wbs_code.startsWith(`${c}.`));
  const leaves = rows.filter((x) => !isSummary(x.wbs_code));

  const needsPct = leaves.filter(
    (x) => isDone(x.status) && x.pct_complete == null && progressCanBeSetByHand(x.task_type),
  );
  // Deliberately left alone, and named so nobody thinks they were missed.
  const skipped = leaves.filter(
    (x) => isDone(x.status) && x.pct_complete == null && !progressCanBeSetByHand(x.task_type),
  );
  // Only rows whose work has not begun by the calendar. A statusless row
  // whose start date has passed might be work already done that nobody
  // recorded, and writing Not Started on it would state something false.
  // Those are listed instead.
  const statusless = leaves.filter((x) => norm(x.status) === "" && x.pct_complete == null);
  const needsStatus = statusless.filter((x) => (x.start_date ?? "") > TODAY);
  const statuslessStarted = statusless.filter((x) => !((x.start_date ?? "") > TODAY));
  const inProgress = leaves.filter((x) => norm(x.status) === "In Progress" && x.pct_complete == null);

  console.log(`\n=== ${p.name} ===`);
  console.log(`  Complete with no percent, will write 100 : ${needsPct.length}`);
  for (const x of needsPct) console.log(`      ${x.wbs_code.padEnd(12)} ${String(x.task_name).slice(0, 44)}`);
  if (skipped.length) {
    console.log(`  Complete with no percent, LEFT ALONE     : ${skipped.length}  (construction or no Type - needs a field report)`);
    for (const x of skipped) console.log(`      ${x.wbs_code.padEnd(12)} ${String(x.task_name).slice(0, 44)}`);
  }
  console.log(`  No status at all, will write Not Started  : ${needsStatus.length}  (start date still ahead)`);
  for (const x of needsStatus) console.log(`      ${x.wbs_code.padEnd(12)} ${String(x.task_name).slice(0, 44)}`);
  if (statuslessStarted.length) {
    console.log(`  No status, start date PASSED, left alone : ${statuslessStarted.length}  (could be done and unrecorded - needs a person)`);
    for (const x of statuslessStarted) console.log(`      ${x.wbs_code.padEnd(12)} ${String(x.task_name).slice(0, 44).padEnd(44)} ${x.start_date} -> ${x.end_date}`);
  }
  if (inProgress.length) {
    console.log(`  In Progress with no percent, NOT TOUCHED  : ${inProgress.length}  (only you know the number)`);
    for (const x of inProgress) {
      console.log(`      ${x.wbs_code.padEnd(12)} ${String(x.task_name).slice(0, 44).padEnd(44)} ${x.start_date} -> ${x.end_date}`);
      wip.push(`${p.name} ${x.wbs_code} ${x.task_name}`);
    }
  }

  if (!APPLY) { totalPct += needsPct.length; totalStatus += needsStatus.length; continue; }

  for (const x of needsPct) {
    // Guarded on the state we read, so a row somebody edited in between is
    // left for them rather than overwritten.
    const { error: e } = await sb
      .from("schedule_tasks")
      .update({ pct_complete: 100, status_source: "manual" })
      .eq("id", x.id)
      .is("pct_complete", null);
    if (e) throw e;
    totalPct++;
  }
  for (const x of needsStatus) {
    const { error: e } = await sb
      .from("schedule_tasks")
      .update({ status: "Not Started" })
      .eq("id", x.id)
      .is("pct_complete", null);
    if (e) throw e;
    totalStatus++;
  }
}

console.log("\n" + "=".repeat(62));
if (APPLY) console.log(`Wrote 100% on ${totalPct} rows, Not Started on ${totalStatus} rows.`);
else console.log(`Dry run. Would write 100% on ${totalPct} rows and Not Started on ${totalStatus}. Pass --apply.`);
if (wip.length) {
  console.log(`\n${wip.length} In Progress rows still need a real percent typed in:`);
  for (const w of wip) console.log(`  ${w}`);
}
console.log("=".repeat(62));
