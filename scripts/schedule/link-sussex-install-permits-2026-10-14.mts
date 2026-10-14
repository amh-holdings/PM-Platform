// Sussex install tasks wait for their permits, 2026-10-14.
//
// Phil: "4.3 can be linked to building permit and 4.4 needs to be linked to
// electrical permits." 4.3 Structural / Racking keeps its 4.2SS+25 overlap and
// adds 2.2.1.1 Building Permit, replacing "89" (a Smartsheet row number that
// resolved to nothing). 4.4 Electrical keeps 4.3SS+26 and adds 2.2.1.2
// Electrical Permit. Each starts at whichever comes later.
//
// The three IFC packages follow 2.2 Contractor Permits (Phil: "we will do
// these after we have all the permits"), replacing "90" - another dead
// Smartsheet row number.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { syncScheduleDates } from "@/lib/schedule-sync-server";

const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";
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

for (const [wbs, preds] of [
  ["4.3", "4.2SS+25, 2.2.1.1"],
  ["4.4", "4.3SS+26, 2.2.1.2"],
  ["1.2.1.5", "2.2"],
  ["1.2.2.4", "2.2"],
  ["1.2.3.4", "2.2"],
] as const) {
  const { error } = await sb.from("schedule_tasks").update({ predecessors: preds }).eq("project_id", PID).eq("wbs_code", wbs);
  if (error) throw error;
}
const n = await syncScheduleDates(sb as never, PID);
const { data } = await sb
  .from("schedule_tasks")
  .select("wbs_code, task_name, start_date, end_date, predecessors")
  .eq("project_id", PID)
  .in("wbs_code", ["2.2.6", "1.2.1.5", "1.2.2.4", "1.2.3.4", "2.2.1.1", "2.2.1.2", "4.1", "4.2", "4.3", "4.4", "4.5", "3.1", "3.2", "3.3"])
  .order("sort_order");
console.log(`synced ${n} dates`);
console.table(data);
