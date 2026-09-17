// Put Sussex back on the dates it was loaded with.
//
// The live-date sync (63fcb06) rewrote Start and Finish from a forecast that
// treated unreported design work as work still to do: 30% Civil Design moved
// 9/14 -> 10/8 and everything behind it followed. Now that those tasks are
// classified as deliverables, the engine holds a committed date instead - so
// the dates can go back, and this time they stay.
//
// The source is the weekly snapshot taken on 2026-09-17, which still carries
// the loaded dates. Restores start, finish and duration; nothing else.
//
// Prints what the live sync would do with the restored dates before writing
// anything, so the answer is visible rather than assumed.
//
// Dry run by default. Pass --apply to write.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { planScheduleSync } from "@/lib/schedule-sync";
import { computeCpm } from "@/lib/schedule-cpm";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";
const DATA_DATE = "2026-09-17";

const raw = readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: snaps, error: snapErr } = await sb
  .from("schedule_updates")
  .select("id, taken_at, data_date, tasks")
  .eq("project_id", PID)
  .order("taken_at", { ascending: true });
if (snapErr) throw snapErr;
if (!snaps?.length) throw new Error("No snapshot to restore from.");

const snap = snaps[0] as { id: string; taken_at: string; tasks: Record<string, unknown>[] };
console.log(`Snapshot ${snap.id} taken ${snap.taken_at}, ${snap.tasks.length} tasks`);

const was = new Map(snap.tasks.map((t) => [t.wbs_code as string, t]));

const { data: live, error } = await sb
  .from("schedule_tasks")
  .select("id, wbs_code, task_name, status, pct_complete, duration_days, start_date, end_date, predecessors, task_type, is_milestone, date_constraint_type, date_constraint_date")
  .eq("project_id", PID)
  .order("sort_order");
if (error) throw error;

const changes: { id: string; wbs: string; name: string; from: string; to: string; row: Record<string, unknown> }[] = [];
for (const t of live!) {
  const w = was.get(t.wbs_code);
  if (!w) {
    console.log(`  not in the snapshot, left alone: ${t.wbs_code} ${t.task_name}`);
    continue;
  }
  const row = {
    start_date: (w.start_date as string) ?? null,
    end_date: (w.end_date as string) ?? null,
    duration_days: (w.duration_days as number) ?? null,
  };
  if (
    row.start_date === t.start_date &&
    row.end_date === t.end_date &&
    row.duration_days === t.duration_days
  ) continue;
  changes.push({
    id: t.id,
    wbs: t.wbs_code,
    name: t.task_name,
    from: `${t.start_date} -> ${t.end_date} (${t.duration_days}d)`,
    to: `${row.start_date} -> ${row.end_date} (${row.duration_days}d)`,
    row,
  });
}

console.log(`\n${changes.length} tasks to restore:`);
for (const c of changes) {
  console.log(`  ${c.wbs.padEnd(10)} ${c.name.slice(0, 34).padEnd(34)} ${c.from}  =>  ${c.to}`);
}

// What the app will do on the next page load, with the restored dates in place.
const restored = live!.map((t) => {
  const c = changes.find((x) => x.id === t.id);
  return c ? { ...t, ...c.row } : t;
});
const sync = planScheduleSync(restored as never, { dataDate: DATA_DATE });
const cpm = computeCpm(restored as never, { dataDate: DATA_DATE });
console.log(`\nThe next page load would then change ${sync.length} rows:`);
for (const u of sync) {
  const t = restored.find((x) => x.wbs_code === u.wbs)!;
  console.log(`  ${u.wbs.padEnd(10)} ${t.task_name.slice(0, 34).padEnd(34)} ${t.start_date} -> ${t.end_date}  =>  ${u.start} -> ${u.end}`);
}

const overdue = restored.filter((t) => cpm.byWbs.get(t.wbs_code)?.forecastBasis === "overdue");
console.log(`\nOverdue deliverables (commitment kept, forecast rolled to ${DATA_DATE}):`);
for (const t of overdue) console.log(`  ${t.wbs_code.padEnd(10)} ${t.task_name} - committed ${t.end_date}`);
console.log(`\nProject finish: ${cpm.projectedFinish}`);

if (!APPLY) {
  console.log("\nDRY RUN - nothing written. Pass --apply to write.");
  process.exit(0);
}

mkdirSync("scripts/_backups", { recursive: true });
const backupPath = "scripts/_backups/sussex-dates-pre-restore-2026-09-17.json";
writeFileSync(backupPath, JSON.stringify(live, null, 2));

for (const c of changes) {
  const { error: upErr } = await sb.from("schedule_tasks").update(c.row).eq("id", c.id);
  if (upErr) {
    console.log(`WRITE FAILED on ${c.wbs}: ${upErr.message}`);
    process.exit(1);
  }
}
console.log(`\nRESTORED ${changes.length} tasks. Backup: ${backupPath}`);
