// Sweet Springs CIVIL (5.1.x): put Phase 2 back to Not Started / 0%.
//
// WHAT WENT WRONG
// Two Pyramid field reports pinned Phase 1 basin work against Phase 2 tasks:
//   DPR 2026-08-24 "Grubbed further up hill ..., stripped basin 1"
//        -> pinned 5.1.3.3 Build Basin 1   In Progress 5%
//        -> pinned 5.1.3.4 Build Basin 2   In Progress 2%
//   DPR 2026-08-25 "Stripped topsoil and started cutting road ..., grubbed basin 2"
//        -> pinned 5.1.3.4 Build Basin 2   In Progress 5%
// Grubbing and stripping a basin is Phase 1 ESC work (5.1.1.6 / 5.1.1.7), not
// Phase 2 basin construction. Phase 2 has not started.
//
// WHY RESETTING schedule_tasks ALONE IS NOT ENOUGH
// recomputeTaskProgressFromPins() (inspections/inspection-actions.ts) derives
// status/pct from every approved origin='sub' pin on a task, latest report date
// winning. It runs on any later pin decision for that task. So the 5% would
// come straight back the next time anyone approved or reopened a pin touching
// those tasks. The pins have to stop pointing at Phase 2.
//
// WHAT THIS DOES
//   1. inspections.schedule_task_id -> null on the three mis-targeted pins, with
//      the original code recorded in ahc_notes so the move is reversible and
//      auditable. The report, its narrative, and the approval all survive; the
//      pin just stops driving a Phase 2 task. The review UI already renders a
//      pin with no task link (field-reports/[dprId]/page.tsx:133).
//   2. 5.1.3.3 / 5.1.3.4 -> Not Started, pct 0, installed_quantity 0,
//      status_source 'manual', last_dpr_at null.
//
// Dry run by default.
//   node scripts/fix-phase2-not-started.mjs
//   node scripts/fix-phase2-not-started.mjs --apply

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";

const env = {};
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1).replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// The pins to detach, and the Phase 1 task each one actually described.
const DETACH = [
  { id: "c33355a8-cca9-451d-a086-80b376f80f64", from: "5.1.3.3", belongs: "5.1.1.6 Construct Basin 1 ESC" },
  { id: "c9d36fe9-6106-4ed4-a9f8-da3aa5229aa7", from: "5.1.3.4", belongs: "5.1.1.7 Construct Basin 2 ESC" },
  { id: "dd7ecd2f-eb83-45be-a547-56d1d9b8c167", from: "5.1.3.4", belongs: "5.1.1.7 Construct Basin 2 ESC" },
];

const RESET = ["5.1.3.3", "5.1.3.4"];

const { data: tasks, error: tErr } = await sb
  .from("schedule_tasks")
  .select("id, wbs_code, task_name, status, pct_complete, status_source, installed_quantity, last_dpr_at")
  .eq("project_id", PID)
  .like("wbs_code", "5.1.3%");
if (tErr) throw tErr;
const byCode = Object.fromEntries(tasks.map((t) => [t.wbs_code, t]));

console.log(APPLY ? "APPLYING\n" : "DRY RUN (pass --apply to write)\n");

console.log("Phase 2 today:");
for (const t of tasks.slice().sort((a, b) => a.wbs_code.localeCompare(b.wbs_code, undefined, { numeric: true }))) {
  console.log(`  ${t.wbs_code.padEnd(9)} ${(t.task_name ?? "").slice(0, 46).padEnd(48)} ${String(t.status).padEnd(12)} pct=${t.pct_complete}`);
}

console.log("\nDetach mis-targeted pins:");
for (const d of DETACH) {
  const { data: insp, error } = await sb
    .from("inspections")
    .select("id, title, status, origin, task_new_status, task_new_pct, ahc_notes, schedule_task_id")
    .eq("id", d.id)
    .maybeSingle();
  if (error) throw error;
  if (!insp) { console.log(`  ${d.id} - not found, skipping`); continue; }
  if (!insp.schedule_task_id) { console.log(`  ${d.id} - already detached, skipping`); continue; }
  console.log(`  ${d.from} <- pin ${insp.id} (${insp.status}/${insp.origin}, ${insp.task_new_status} ${insp.task_new_pct}%) -> detach; work belongs to ${d.belongs}`);
  if (!APPLY) continue;
  const note = `[2026-09-03] Detached from ${d.from}: report described Phase 1 grubbing/stripping, which is ${d.belongs}, not Phase 2 basin construction. Phase 2 has not started.`;
  const { error: uErr } = await sb
    .from("inspections")
    .update({ schedule_task_id: null, ahc_notes: insp.ahc_notes ? `${insp.ahc_notes}\n${note}` : note })
    .eq("id", insp.id);
  if (uErr) throw uErr;
}

console.log("\nReset tasks:");
for (const code of RESET) {
  const t = byCode[code];
  if (!t) { console.log(`  ${code} - not found, skipping`); continue; }
  console.log(`  ${code} ${t.task_name}: ${t.status}/${t.pct_complete}% -> Not Started/0%`);
  if (!APPLY) continue;
  const { error } = await sb
    .from("schedule_tasks")
    .update({
      status: "Not Started",
      pct_complete: 0,
      installed_quantity: 0,
      status_source: "manual",
      last_dpr_at: null,
    })
    .eq("id", t.id);
  if (error) throw error;
}

if (APPLY) {
  const { data: after } = await sb
    .from("schedule_tasks")
    .select("wbs_code, task_name, status, pct_complete, status_source, last_dpr_at")
    .eq("project_id", PID)
    .like("wbs_code", "5.1.3%");
  console.log("\nPhase 2 after:");
  for (const t of after.sort((a, b) => a.wbs_code.localeCompare(b.wbs_code, undefined, { numeric: true }))) {
    console.log(`  ${t.wbs_code.padEnd(9)} ${(t.task_name ?? "").slice(0, 46).padEnd(48)} ${String(t.status).padEnd(12)} pct=${t.pct_complete} src=${t.status_source}`);
  }
  const { data: leftover } = await sb
    .from("inspections")
    .select("id")
    .in("schedule_task_id", tasks.map((t) => t.id))
    .eq("origin", "sub")
    .eq("status", "approved");
  console.log(`\nApproved sub pins still attached to Phase 2 tasks: ${leftover?.length ?? 0} (want 0)`);
}
