// Sussex: racking starts after civil Phase 2 is complete (Phil, 2026-10-26).
// Pile Unloading moves from Clear and grub to the Phase 2 summary; the two
// unlinked QA/QC rows follow Phase 2 too, so nothing in 4.3 starts earlier.
// The Ampacity PO back-schedules from Pile Unloading, so its order-by follows.
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
  "db/snapshots/schedule_tasks_sussex_pre-racking-after-phase2_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
const EXPECT: [string, string, string | null][] = [
  ["4.3.02", "Pile Unloading", "4.2.1.04"],
  ["4.3.17", "QA/QC Plan", null],
  ["4.3.18", "QA/QC Inspection", null],
];
let staged = before!;
for (const [code, name, preds] of EXPECT) {
  const r = before!.find((x) => x.wbs_code === code);
  if (!r || r.task_name !== name || r.predecessors !== preds) throw new Error(`${code} unexpected: ${r?.task_name} <- ${r?.predecessors}`);
  const cycle = findCycleWith(staged as never, code, parsePredecessors("4.2.2"));
  if (cycle) throw new Error(`cycle: ${cycle.join(" -> ")}`);
  staged = staged.map((x) => (x.id === r.id ? { ...x, predecessors: "4.2.2" } : x));
  const { error } = await sb.from("schedule_tasks").update({ predecessors: "4.2.2" }).eq("id", r.id);
  if (error) throw error;
}
console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");

const { data: after } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
for (const r of (scheduleOrder(after as never) as any[]).filter((r) =>
  /^(3\.4(\.\d)?|4\.2\.2|4\.2\.2\.06|4\.3(\.\d\d)?|4\.[4-8])$/.test(r.wbs_code)))
  console.log(`${r.wbs_code.padEnd(8)} ${r.task_name.slice(0, 34).padEnd(34)} ${r.start_date}->${r.end_date} <- ${r.predecessors ?? "-"}`);
