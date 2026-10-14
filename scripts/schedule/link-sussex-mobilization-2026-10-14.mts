// Sussex 4.1 Mobilization follows the Land Disturbance Permit, 2026-10-14.
//
// Phil: "Mobilization should be linked to the Land disturbance permit." The
// permit lands Jan 14 2027 and mobilization starts the next working day. A
// Start No Earlier Than Feb 3 floor was tried first and removed the same day
// (Phil: "Mobilization should start after we get the LDP"). Replaces "106", a
// Smartsheet row number that resolved to nothing.
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

const { error } = await sb
  .from("schedule_tasks")
  .update({ predecessors: "2.2.1.3", date_constraint_type: null, date_constraint_date: null })
  .eq("project_id", PID)
  .eq("wbs_code", "4.1");
if (error) throw error;
const n = await syncScheduleDates(sb as never, PID);
const { data } = await sb
  .from("schedule_tasks")
  .select("wbs_code, task_name, start_date, end_date, predecessors, date_constraint_type, date_constraint_date")
  .eq("project_id", PID)
  .in("wbs_code", ["2.2.1.3", "4.1", "4.2", "4.3", "4.4", "4.5"])
  .order("sort_order");
console.log(`synced ${n} dates`);
console.table(data);
