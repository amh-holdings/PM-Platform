// Re-attach the four misfiled August pins to the leaf tasks that describe the
// work, then recompute the affected schedule_tasks the same way
// applyPinProgressToSchedule does.
//
// WHY. The pin -> schedule_task link is the first hop in the chain that ends at
// a dollar on the owner's G702, and four of August's thirteen pins never made
// it onto a real task:
//
//   2026-08-14  "Grubbing basin 1 and grubbing diversion ditch"
//               2 pins titled "1.2.2 Civil", schedule_task_id NULL. They carry
//               task_new_pct (10 and 5), which is only written when a task WAS
//               picked - so task "1.2.2 Civil" existed on 8/14 and has since
//               been deleted. inspections.schedule_task_id is ON DELETE SET
//               NULL (0023_inspection_wbs.sql:7), so the link was severed
//               silently and the progress never reached billing.
//
//   2026-08-18  "Crew worked on grubbing basins"
//               2 pins on 5.1 "Civil Construction", which is a SUMMARY row.
//               A parent's percent is a rollup; pinning to one wrote 75% onto
//               the summary and would have billed ~$230k of SOV 6.02 for a
//               month of clearing and grubbing.
//
// Phil confirmed 2026-08-19 that these percentages belong on the basin tasks.
//
// ASSUMPTIONS, stated because they are judgement calls, not data:
//   - 8/18's two pins are Basin 1 and Basin 2. The higher percentage (90) goes
//     to Basin 1, which started on 8/14; the lower (75) to Basin 2.
//   - 8/14's "diversion ditch" pin goes to 5.1.1.7 Construct ESC measures.
//     There is no diversion-ditch task and a diversion ditch is an ESC measure.
//     This is the only change that touches SOV 6.03.
//
// A MOVED PIN DOES NOT KEEP ITS PERCENTAGE. task_new_pct is a percentage OF THE
// TASK THE SUB HAD SELECTED. Carrying it to a different task restates a
// fraction of one scope as a fraction of another - the same error that let a
// pin on the 5.1 summary claim 75% of all Civil Construction. Every entry in
// PLAN therefore states `newPct` explicitly, and the script refuses to run if
// one is missing.
//
//   node scripts/fix-august-pin-tasks.mjs --dry-run
//   node scripts/fix-august-pin-tasks.mjs

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

const { data: tasks } = await sb
  .from("schedule_tasks")
  .select("id, wbs_code, task_name, status, pct_complete")
  .eq("project_id", PID);
const byCode = Object.fromEntries(tasks.map((t) => [t.wbs_code, t]));
const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

const { data: dprs } = await sb
  .from("dprs")
  .select("id, report_date")
  .eq("project_id", PID);
const dateOf = Object.fromEntries(dprs.map((d) => [d.id, d.report_date]));

const { data: pins } = await sb
  .from("inspections")
  .select("id, title, schedule_task_id, task_new_pct, task_new_status, quantity, dpr_id, origin, status, decided_at")
  .eq("project_id", PID);

// `date` + `pct` identify the existing pin (stable and unambiguous for these
// four). `to` is the task it should have been filed against. `newPct` is that
// pin's percent complete OF THE TARGET TASK - set deliberately, never carried
// over from `pct`.
// Phil confirmed 2026-08-19 that the perimeter silt fence is 5.1.1.7 Construct
// ESC measures, and that Basin 1/2 ESC (5.1.1.8, 5.1.1.9) are separate tasks
// still ahead - so 5.1.1.7's remaining scope after the fence is the diversion
// ditch, which was still being grubbed on 8/14.
const PLAN = [
  { date: "2026-08-12", pct: 80, to: "5.1.1.7", newPct: 80, note: "Silt fence finished" },
  { date: "2026-08-14", pct: 10, to: "5.1.2.1", newPct: 10, note: "Grubbing basin 1" },
  { date: "2026-08-14", pct: 5,  to: "5.1.1.7", newPct: 85, note: "Diversion ditch grubbing, after the fence was complete" },
  { date: "2026-08-18", pct: 90, to: "5.1.2.1", newPct: 90, note: "Grubbing basins - Basin 1" },
  { date: "2026-08-18", pct: 75, to: "5.1.2.3", newPct: 75, note: "Grubbing basins - Basin 2" },
];

// Tasks set by hand rather than from a pin.
//
// 5.1.1.1 loses its only pin to 5.1.1.7 above (that pin reported the silt
// fence, and Phil confirmed the fence is 5.1.1.7). The task is nonetheless
// complete - Phil confirmed 2026-08-19 that the limits of disturbance are
// partitioned off. There is no field report saying so, so this is recorded as
// status_source='manual', NOT 'dpr': it is the PM's assertion, not something a
// crew pinned and a CM verified, and the G703 evidence trail should say which.
const MANUAL_OVERRIDES = [
  {
    code: "5.1.1.1",
    pct: 100,
    status: "Complete",
    why: "Limits of disturbance partitioned off - confirmed by Phil 2026-08-19, no field pin",
  },
];

const missing = PLAN.filter((p) => p.newPct == null);
if (missing.length > 0) {
  console.error("Refusing to run - these moves have no percent set for the target task:\n");
  for (const p of missing) {
    console.error(`  ${p.date}  -> ${p.to}   ${p.note}`);
  }
  console.error(
    "\nA pin's task_new_pct is a percentage of the task the sub selected, not of the\n" +
    "task it is being moved to. Set newPct on each entry above and re-run.",
  );
  process.exit(1);
}

const moves = [];
for (const p of PLAN) {
  const match = pins.filter(
    (i) => dateOf[i.dpr_id] === p.date && Number(i.task_new_pct) === p.pct,
  );
  if (match.length !== 1) {
    console.error(`FATAL: expected exactly 1 pin for ${p.date} @ ${p.pct}%, found ${match.length}`);
    process.exit(1);
  }
  const target = byCode[p.to];
  if (!target) {
    console.error(`FATAL: no schedule_task with wbs_code ${p.to}`);
    process.exit(1);
  }
  moves.push({ pin: match[0], target, plan: p });
}

console.log(`Project ${PID}   mode: ${DRY ? "DRY RUN" : "APPLY"}\n`);
console.log("=== PIN RE-ASSIGNMENTS ===");
for (const m of moves) {
  const from = m.pin.schedule_task_id
    ? `${byId[m.pin.schedule_task_id]?.wbs_code} ${byId[m.pin.schedule_task_id]?.task_name}`
    : `(unlinked, titled "${m.pin.title}")`;
  console.log(`  ${m.plan.date}  ${String(m.plan.pct).padStart(3)}%  ${m.plan.note}`);
  console.log(`      from: ${from}`);
  console.log(`      to:   ${m.target.wbs_code} ${m.target.task_name}`);
}

// Recompute each affected task exactly as applyPinProgressToSchedule does:
// among approved sub pins on the task, take the latest by report_date,
// tie-broken by decided_at.
const affected = new Set(moves.map((m) => m.target.id));
for (const m of moves) if (m.pin.schedule_task_id) affected.add(m.pin.schedule_task_id);

const projected = new Map(moves.map((m) => [m.pin.id, m.target.id]));
console.log("\n=== RESULTING schedule_tasks ===");
const taskPatches = [];
for (const taskId of affected) {
  const t = byId[taskId];
  const on = pins.filter((i) => {
    const tid = projected.has(i.id) ? projected.get(i.id) : i.schedule_task_id;
    return tid === taskId && i.origin === "sub" && i.status === "approved";
  });
  if (on.length === 0) {
    // Nothing measured points at this task any more. Leaving a stale percent
    // behind with status_source='dpr' claims field verification that no longer
    // exists - and on a summary row it was never meaningful to begin with.
    console.log(
      `  ${t.wbs_code.padEnd(9)} ${String(t.pct_complete ?? 0).padStart(5)}% -> CLEARED (no approved pins remain)  ${t.task_name}`,
    );
    taskPatches.push({
      id: taskId,
      patch: { pct_complete: null, status_source: "manual", last_dpr_at: null },
    });
    continue;
  }
  // Use the corrected percent for any pin this run is moving.
  const pctOf = (i) => {
    const mv = moves.find((m) => m.pin.id === i.id);
    return mv ? mv.plan.newPct : i.task_new_pct;
  };
  on.sort((a, b) => {
    const d = (dateOf[b.dpr_id] ?? "").localeCompare(dateOf[a.dpr_id] ?? "");
    if (d !== 0) return d;
    return (b.decided_at ?? "").localeCompare(a.decided_at ?? "");
  });
  const gov = on[0];
  console.log(
    `  ${t.wbs_code.padEnd(9)} ${String(t.pct_complete ?? 0).padStart(5)}% -> ${String(pctOf(gov) ?? "-").padStart(5)}%  (governing pin ${dateOf[gov.dpr_id]}, ${on.length} approved pin(s))  ${t.task_name}`,
  );
  taskPatches.push({
    id: taskId,
    patch: {
      status_source: "dpr",
      last_dpr_at: new Date().toISOString(),
      ...(gov.task_new_status ? { status: gov.task_new_status } : {}),
      ...(pctOf(gov) != null ? { pct_complete: pctOf(gov) } : {}),
      ...(gov.quantity != null ? { installed_quantity: gov.quantity } : {}),
    },
  });
}

console.log("\n=== MANUAL OVERRIDES (no field pin - status_source='manual') ===");
for (const o of MANUAL_OVERRIDES) {
  const t = byCode[o.code];
  if (!t) {
    console.error(`FATAL: no schedule_task with wbs_code ${o.code}`);
    process.exit(1);
  }
  console.log(`  ${o.code.padEnd(9)} -> ${String(o.pct).padStart(5)}%  ${t.task_name}`);
  console.log(`      ${o.why}`);
  // Overrides win over anything the pin pass computed for the same task.
  const existing = taskPatches.findIndex((tp) => tp.id === t.id);
  const patch = {
    id: t.id,
    patch: {
      pct_complete: o.pct,
      status: o.status,
      status_source: "manual",
      last_dpr_at: null,
    },
  };
  if (existing >= 0) taskPatches[existing] = patch;
  else taskPatches.push(patch);
}

if (DRY) {
  console.log("\n[dry-run] Nothing written.");
  process.exit(0);
}

mkdirSync("scripts/_backups", { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`scripts/_backups/inspections_${ts}.json`, JSON.stringify(pins, null, 1));
writeFileSync(`scripts/_backups/schedule_tasks_${ts}.json`, JSON.stringify(tasks, null, 1));
console.log(`\nBacked up inspections + schedule_tasks -> scripts/_backups/*_${ts}.json`);

for (const m of moves) {
  const { error } = await sb
    .from("inspections")
    .update({
      schedule_task_id: m.target.id,
      title: `${m.target.wbs_code} ${m.target.task_name}`,
      task_new_pct: m.plan.newPct,
    })
    .eq("id", m.pin.id);
  if (error) console.error(`  ERR pin ${m.pin.id}: ${error.message}`);
}
for (const tp of taskPatches) {
  const { error } = await sb.from("schedule_tasks").update(tp.patch).eq("id", tp.id);
  if (error) console.error(`  ERR task ${tp.id}: ${error.message}`);
}
console.log(`\nMoved ${moves.length} pins, updated ${taskPatches.length} schedule tasks.`);
