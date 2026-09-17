// Fill schedule_tasks.task_type for Sussexx CSG 1 and Sweet Springs, exactly as
// Phil approved it on 2026-09-17. Needs migration 0051.
//
// Sussex: every section above Construction (0, 1, 2, 3) is Deliverable; the
// Construction section (4) is Construction, except 4.0 Bat Restriction Period,
// which is a no-clearing window rather than work and stays unclassified.
//
// Sweet Springs: all Construction, except County Inspection (5.1.1.11), Permit
// Closeout (5.1.4) and QA/QC Closeout (5.2.16), which are Deliverable. The three
// QC inspections (5.2.5 / 5.2.10 / 5.2.15) stay Construction - multi-day field
// work tracked on QC field reports.
//
// Summary rows take the type of the work beneath them, Construction when mixed.
//
// Guards: only writes rows that are still null, so a hand-set type is never
// overwritten; refuses to mark Deliverable any task that already carries
// approved daily-report progress. Backup of every touched row goes to
// scripts/_backups before the write.
//
// Dry run by default. Pass --apply to write.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

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

const under = (wbs, code) => wbs === code || wbs.startsWith(code + ".");

const PROJECTS = [
  {
    id: "39154377-bd1a-48ea-acdc-5d9b568863c9",
    label: "Sussexx CSG 1",
    classify(wbs) {
      if (wbs === "4.0") return null;
      if (under(wbs, "4")) return "construction";
      if (["0", "1", "2", "3"].some((s) => under(wbs, s))) return "deliverable";
      return undefined;
    },
  },
  {
    id: "53cff193-21e4-45ff-833d-43813e8578a0",
    label: "Sweet Springs",
    classify(wbs) {
      if (["5.1.1.11", "5.1.4", "5.2.16"].includes(wbs)) return "deliverable";
      if (under(wbs, "5")) return "construction";
      return undefined;
    },
  },
];

const { data: pins, error: pinErr } = await sb
  .from("inspections")
  .select("schedule_task_id")
  .eq("status", "approved")
  .not("schedule_task_id", "is", null);
if (pinErr) throw pinErr;
const reported = new Set(pins.map((p) => p.schedule_task_id));

const backup = {};
const writes = [];
let blocked = false;

for (const p of PROJECTS) {
  const { data: tasks, error } = await sb
    .from("schedule_tasks")
    .select("id, wbs_code, task_name, task_type")
    .eq("project_id", p.id)
    .order("sort_order");
  if (error) {
    console.log(`${p.label}: ${error.message}`);
    console.log("Migration 0051 has not been applied. Nothing to do yet.");
    process.exit(1);
  }

  const counts = { construction: 0, deliverable: 0, blank: 0, alreadySet: 0 };
  const lines = [];
  for (const t of tasks) {
    const type = p.classify(t.wbs_code);
    if (type === undefined) {
      console.log(`${p.label}: no rule covers ${t.wbs_code} ${t.task_name} - stopping.`);
      process.exit(1);
    }
    if (t.task_type != null) { counts.alreadySet++; continue; }
    if (type === null) { counts.blank++; lines.push(`  blank        ${t.wbs_code} ${t.task_name}`); continue; }
    if (type === "deliverable" && reported.has(t.id)) {
      console.log(`${p.label}: ${t.wbs_code} ${t.task_name} has approved report progress - refusing Deliverable.`);
      blocked = true;
      continue;
    }
    counts[type]++;
    if (type === "deliverable" || p.label === "Sweet Springs") {
      if (type === "deliverable") lines.push(`  deliverable  ${t.wbs_code} ${t.task_name}`);
    }
    writes.push({ id: t.id, task_type: type });
    (backup[p.label] ??= []).push({ id: t.id, wbs_code: t.wbs_code, task_type: t.task_type });
  }
  console.log(`\n${p.label}: ${tasks.length} tasks`);
  console.log(`  construction ${counts.construction}, deliverable ${counts.deliverable}, left blank ${counts.blank}, already set ${counts.alreadySet}`);
  if (p.label === "Sweet Springs" || counts.blank) for (const l of lines) console.log(l);
}

if (blocked) {
  console.log("\nBLOCKED - nothing written.");
  process.exit(1);
}
if (!APPLY) {
  console.log(`\nDRY RUN - ${writes.length} rows would be written. Pass --apply to write.`);
  process.exit(0);
}

mkdirSync("scripts/_backups", { recursive: true });
const backupPath = "scripts/_backups/task-types-pre-classify-2026-09-17.json";
writeFileSync(backupPath, JSON.stringify(backup, null, 2));

for (const type of ["construction", "deliverable"]) {
  const ids = writes.filter((w) => w.task_type === type).map((w) => w.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await sb
      .from("schedule_tasks")
      .update({ task_type: type })
      .in("id", ids.slice(i, i + 100))
      .is("task_type", null);
    if (error) {
      console.log(`WRITE FAILED on ${type}: ${error.message}`);
      process.exit(1);
    }
  }
}
console.log(`\nWROTE ${writes.length} rows. Backup: ${backupPath}`);
