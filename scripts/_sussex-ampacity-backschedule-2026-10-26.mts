// Sussex: the Ampacity trackers / racking PO is not placed yet and can go out
// whenever needed, so it back-schedules from construction (Phil, 2026-10-26).
// Pile Unloading drops its link to the PO; 3.4.3 Delivery must finish by Pile
// Unloading's start (SF), replacing the dead 4.3SF link to the summary.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { findCycleWith, parsePredecessors } from "@/lib/schedule-cpm";
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

const { data: before } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
writeFileSync(
  "db/snapshots/schedule_tasks_sussex_pre-ampacity-backschedule_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
const get = (c: string) => before!.find((r) => r.wbs_code === c)!;
if (get("4.3.02").predecessors !== "4.2.1.04, 3.4") throw new Error(`4.3.02 is ${get("4.3.02").predecessors}`);
if (get("3.4.3").predecessors !== "4.3SF") throw new Error(`3.4.3 is ${get("3.4.3").predecessors}`);

const staged = before!.map((r) => (r.wbs_code === "4.3.02" ? { ...r, predecessors: "4.2.1.04" } : r));
const cycle = findCycleWith(staged as never, "3.4.3", parsePredecessors("4.3.02SF"));
if (cycle) throw new Error(`cycle: ${cycle.join(" -> ")}`);

for (const [code, preds] of [["4.3.02", "4.2.1.04"], ["3.4.3", "4.3.02SF"]] as const) {
  const { error } = await sb.from("schedule_tasks").update({ predecessors: preds }).eq("id", get(code).id);
  if (error) throw error;
}
console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");

const { data: after } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
for (const r of (scheduleOrder(after as never) as any[]).filter((r) =>
  /^(3\.4(\.\d)?|4\.2\.1\.04|4\.2\.2\.06|4\.3|4\.3\.0[1-4]|4\.3\.1[0569]|4\.[4-8])$/.test(r.wbs_code)))
  console.log(`${r.wbs_code.padEnd(8)} ${r.task_name.slice(0, 34).padEnd(34)} ${r.start_date}->${r.end_date} <- ${r.predecessors ?? "-"}`);
