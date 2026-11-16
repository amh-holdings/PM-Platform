// Sussex: no pile driving until the Sussex County Building Permit is received
// (Phil, 2026-10-26). Unloading and the Ampacity PO stay tied to Phase 2.
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
const PREDS = "4.3.03, 2.2.1.1";

const { data: before } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
writeFileSync(
  "db/snapshots/schedule_tasks_sussex_pre-pile-driving-permit_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
const driving = before!.find((r) => r.wbs_code === "4.3.04")!;
const permit = before!.find((r) => r.wbs_code === "2.2.1.1")!;
if (driving.task_name !== "Pile Driving" || driving.predecessors !== "4.3.03") throw new Error(`4.3.04 unexpected: ${driving.predecessors}`);
if (!permit.task_name.startsWith("Building Permit")) throw new Error(`2.2.1.1 is ${permit.task_name}`);
const cycle = findCycleWith(before as never, "4.3.04", parsePredecessors(PREDS));
if (cycle) throw new Error(`cycle: ${cycle.join(" -> ")}`);

const { error } = await sb.from("schedule_tasks").update({ predecessors: PREDS }).eq("id", driving.id);
if (error) throw error;
console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");

const { data: after } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
for (const r of (scheduleOrder(after as never) as any[]).filter((r) =>
  /^(2\.2\.1\.1|3\.4\.[13]|4\.2\.2|4\.3(\.\d\d)?)$/.test(r.wbs_code)))
  console.log(`${r.wbs_code.padEnd(8)} ${r.task_name.slice(0, 34).padEnd(34)} ${r.start_date}->${r.end_date} <- ${r.predecessors ?? "-"}`);
