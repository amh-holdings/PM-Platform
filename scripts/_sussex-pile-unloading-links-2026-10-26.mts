// Sussex 4.3.02 Pile Unloading follows Clear and grub and the Ampacity
// trackers / racking PO, finish-to-start (Phil, 2026-10-26). Linked to the PO
// summary, so it waits for the whole PO through delivery.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { findCycleWith, parsePredecessors } from "@/lib/schedule-cpm";
import { syncScheduleDates } from "@/lib/schedule-sync-server";
import { scheduleOrder } from "@/lib/schedule-edit";

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
const PREDS = "4.2.1.04, 3.4";

const { data: before } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
writeFileSync(
  "db/snapshots/schedule_tasks_sussex_pre-pile-unloading-links_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
const get = (c: string) => before!.find((r) => r.wbs_code === c)!;
if (!get("4.3.02").task_name.startsWith("Pile Unloading") || get("4.3.02").predecessors) throw new Error("4.3.02 unexpected");
if (!get("4.2.1.04").task_name.startsWith("Clear and grub")) throw new Error("4.2.1.04 is not clear and grub");
if (!get("3.4").task_name.includes("Ampacity")) throw new Error("3.4 is not the Ampacity PO");
const cycle = findCycleWith(before as never, "4.3.02", parsePredecessors(PREDS));
if (cycle) throw new Error(`cycle: ${cycle.join(" -> ")}`);

const { error } = await sb.from("schedule_tasks").update({ predecessors: PREDS }).eq("id", get("4.3.02").id);
if (error) throw error;
console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");

const { data: after } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
for (const r of (scheduleOrder(after as never) as any[]).filter((r) =>
  /^(3\.4(\.\d)?|4\.2\.1\.04|4\.2\.2\.06|4\.3(\.\d\d)?|4\.[4-8])$/.test(r.wbs_code)))
  console.log(`${r.wbs_code.padEnd(8)} ${r.task_name.slice(0, 34).padEnd(34)} ${r.start_date}->${r.end_date} <- ${r.predecessors ?? "-"}`);
