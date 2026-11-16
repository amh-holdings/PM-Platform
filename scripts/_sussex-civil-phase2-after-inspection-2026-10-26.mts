// Sussex: Phase 2 starts after the District initial inspection (Phil,
// 2026-10-26). The Phase 2 entry rows that hung off clear and grub now follow
// the inspection, finish-to-start.
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
  "db/snapshots/schedule_tasks_sussex_pre-phase2-after-inspection_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
if (!before!.find((r) => r.wbs_code === "4.2.1.05")?.task_name.startsWith("District initial inspection"))
  throw new Error("4.2.1.05 is not the inspection");

const EXPECT: Record<string, string> = {
  "4.2.2.01": "4.2.1.04SS+3",
  "4.2.2.02": "4.2.1.04SS+3",
  "4.2.2.05": "4.2.1.04",
};
for (const [code, was] of Object.entries(EXPECT)) {
  const r = before!.find((x) => x.wbs_code === code)!;
  if (r.predecessors !== was) throw new Error(`${code} preds are ${r.predecessors}, expected ${was}`);
  const { error } = await sb.from("schedule_tasks").update({ predecessors: "4.2.1.05" }).eq("id", r.id);
  if (error) throw error;
  console.log(`${code}: ${was} -> 4.2.1.05`);
}

console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");
const { data: after } = await sb
  .from("schedule_tasks")
  .select("level_code, wbs_code, task_name, duration_days, start_date, end_date, predecessors")
  .eq("project_id", pid).gte("sort_order", 1590).lte("sort_order", 1620).order("sort_order");
for (const r of after!)
  console.log(
    `${"  ".repeat((r.level_code ?? 2) - 2)}${r.wbs_code.padEnd(9)} ${r.task_name.slice(0, 50).padEnd(50)} ${String(r.duration_days ?? "-").padStart(3)}d ${r.start_date}->${r.end_date} <- ${r.predecessors ?? "-"}`,
  );
