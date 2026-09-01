// Runs the CEO report derivation against the LIVE project data and prints it.
// Read-only. Used to sanity-check the numbers against the source documents.
//
// Run: npx tsx scripts/ceo-report/dry-run.ts [projectId] [asOf]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { buildCeoReport, longDate, type CeoReportInput, type CeoTaskRow } from "@/lib/ceo-report";

const raw = readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}

async function main() {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const PID = process.argv[2] ?? "53cff193-21e4-45ff-833d-43813e8578a0";
  const asOf = process.argv[3] ?? new Date().toISOString().slice(0, 10);

  const project = (await sb.from("projects").select("*").eq("id", PID).single()).data;
  const tasks = ((await sb
    .from("schedule_tasks")
    .select(
      "wbs_code,task_name,parent_wbs_code,phase,status,pct_complete,duration_days,start_date,end_date,baseline_start,baseline_end,is_milestone",
    )
    .eq("project_id", PID)).data ?? []) as CeoTaskRow[];

  const r = buildCeoReport({ asOf, project, tasks, photos: [] } as unknown as CeoReportInput);
  const pct = (n: number | null) => (n == null ? "n/a" : `${n.toFixed(2)}%`);

  console.log(`\n=== CEO REPORT | ${r.project.name} | as of ${r.asOf} ===\n`);
  console.log("HEADLINE:", r.headline, "\n");
  console.log("PROGRESS");
  console.log("  complete         ", pct(r.progress.actualPct), r.progress.weightedByDuration ? "(duration-weighted)" : "(unweighted)");
  console.log("  should be        ", pct(r.progress.plannedPct), r.progress.againstBaseline ? "(vs baseline)" : "(vs current schedule)");
  console.log("  against plan     ", r.progress.variance == null ? "n/a" : `${r.progress.variance.toFixed(1)} pts`);
  console.log("  off the pace by  ", r.progress.daysOffPlan == null ? "n/a" : `${r.progress.daysOffPlan} days`, "| plan hit this on", r.progress.planReachedActualOn ?? "n/a");
  console.log("  tasks            ", `${r.progress.complete}/${r.progress.leafCount} complete, ${r.progress.inProgress} under way, ${r.progress.notStarted} not started`);
  console.log("\nAREAS");
  for (const a of r.progress.areas)
    console.log(`  ${a.area.padEnd(22)} ${pct(a.actualPct).padStart(8)} vs ${pct(a.plannedPct).padStart(8)} = ${(a.variance == null ? "n/a" : a.variance.toFixed(1)).padStart(7)} pts | ${a.complete}/${a.taskCount} | ends ${a.finish}`);
  console.log("\nDATES");
  console.log("  start            ", longDate(r.dates.start));
  console.log("  finish           ", longDate(r.dates.finish), r.dates.daysRemaining == null ? "" : `(${r.dates.daysRemaining} days away)`);
  console.log("  time elapsed     ", pct(r.dates.timeElapsedPct));
  console.log("  finish vs base   ", r.dates.finishSlipDays == null ? "no baseline" : `${r.dates.finishSlipDays} days`);
  console.log("  milestones       ", r.dates.milestones.length, "| contract dates", r.dates.contract.length);
  for (const k of [...r.dates.contract, ...r.dates.milestones])
    console.log(`     ${k.label.padEnd(28)} ${longDate(k.date)} (${k.daysAway} days) ${k.done ? "done" : ""}`);
  console.log("\nLATE (", r.progress.late.length, ")");
  for (const t of r.progress.late)
    console.log(`  ${t.wbs.padEnd(9)} ${t.name.slice(0, 34).padEnd(34)} ${String(t.actualPct).padStart(3)}% (plan wanted ${t.plannedPct}%) due ${t.finish} - ${t.daysLate}d late`);
  console.log("\nCHECKS");
  for (const c of r.checks) console.log(`  [${c.severity.toUpperCase()}] ${c.label}\n      ${c.detail}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
