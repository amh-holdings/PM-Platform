// Sussex 4.3 Structural / Racking gets the Sweet Springs 5.2 Mechanical task
// list (piles, racking, modules, QA/QC) as children 4.3.01-4.3.19, in Sweet
// Springs display order. Names, durations, types and milestone flags copied;
// no predecessors yet (Phil, 2026-10-26).
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { scheduleOrder } from "@/lib/schedule-edit";
import { syncScheduleDates } from "@/lib/schedule-sync-server";

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
const pid = "39154377-bd1a-48ea-acdc-5d9b568863c9";
const { data: ssp } = await sb.from("projects").select("id").eq("name", "Sweet Springs Solar").single();

const { data: src } = await sb.from("schedule_tasks").select("*").eq("project_id", ssp!.id).like("wbs_code", "5.2.%");
const tasks = (scheduleOrder(src as never) as any[]).filter((t) => t.wbs_code.split(".").length === 3);
if (tasks.length !== 19) throw new Error(`expected 19 Sweet Springs tasks, got ${tasks.length}`);

const { data: before } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
writeFileSync(
  "db/snapshots/schedule_tasks_sussex_pre-racking-breakdown_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
const parent = before!.find((r) => r.wbs_code === "4.3")!;
if (before!.some((r) => r.wbs_code.startsWith("4.3."))) throw new Error("4.3 already has children");

// Make room: 4.3 sits at 1620 and 4.4 at 1630.
for (const r of before!.filter((r) => (r.sort_order ?? 0) > parent.sort_order!)) {
  const { error } = await sb.from("schedule_tasks").update({ sort_order: r.sort_order! + 20 }).eq("id", r.id);
  if (error) throw error;
}

const { error } = await sb.from("schedule_tasks").insert(
  tasks.map((t, i) => ({
    project_id: pid,
    wbs_code: `4.3.${String(i + 1).padStart(2, "0")}`,
    task_name: t.task_name,
    description: t.description,
    parent_wbs_code: "4.3",
    level_code: 3,
    sort_order: parent.sort_order! + 1 + i,
    duration_days: t.duration_days,
    is_milestone: t.is_milestone,
    task_type: t.task_type,
    unit_of_measure: t.unit_of_measure,
    target_quantity: t.target_quantity,
    predecessors: null,
  })),
);
if (error) throw error;
console.log(`inserted ${tasks.length}`);

const watch = (rows: any[]) =>
  Object.fromEntries(
    rows.filter((r) => /^(4\.[3-8]|3\.4(\.\d)?)$/.test(r.wbs_code)).map((r) => [r.wbs_code, `${r.start_date}->${r.end_date}`]),
  );
const pre = watch(before!);
console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");

const { data: after } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
const post = watch(after!);
console.log("\n=== linked rows, before -> after ===");
for (const k of Object.keys(pre).sort()) {
  const row = after!.find((r) => r.wbs_code === k)!;
  console.log(`${k.padEnd(6)} ${row.task_name.slice(0, 36).padEnd(36)} ${pre[k]}  ->  ${post[k]}  <- ${row.predecessors ?? "-"}`);
}
console.log("\n=== 4.3 children ===");
for (const r of (scheduleOrder(after as never) as any[]).filter((r) => r.wbs_code.startsWith("4.3.")))
  console.log(`${r.sort_order} ${r.wbs_code.padEnd(7)} ${r.task_name.padEnd(36)} ${String(r.duration_days).padStart(2)}d ${r.task_type ?? "-"} ${r.start_date}->${r.end_date}`);
