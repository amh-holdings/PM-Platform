// Sussex: perimeter fence follows the District initial inspection, so no work
// starts before the District signs off (Phil, 2026-10-26).
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
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

const { data: before } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
writeFileSync(
  "db/snapshots/schedule_tasks_sussex_pre-fence-after-inspection_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
const fence = before!.find((r) => r.wbs_code === "4.2.3.01")!;
if (!fence.task_name.startsWith("Perimeter fence") || fence.predecessors !== "4.2.1.04")
  throw new Error(`unexpected 4.2.3.01: ${fence.task_name} <- ${fence.predecessors}`);
const { error } = await sb.from("schedule_tasks").update({ predecessors: "4.2.1.05" }).eq("id", fence.id);
if (error) throw error;

console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");
const { data: after } = await sb
  .from("schedule_tasks")
  .select("level_code, wbs_code, task_name, start_date, end_date, predecessors")
  .eq("project_id", pid).gte("sort_order", 1590).lte("sort_order", 1612).order("sort_order");
for (const r of after!)
  console.log(`${"  ".repeat((r.level_code ?? 2) - 2)}${r.wbs_code.padEnd(9)} ${r.task_name.slice(0, 46).padEnd(46)} ${r.start_date}->${r.end_date} <- ${r.predecessors ?? "-"}`);
