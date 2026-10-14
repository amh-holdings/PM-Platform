// Sussex completion milestones, 2026-10-14.
//
// Exhibit E 9.00 / 10.00 / 11.00 ($298,629.30 each) bill on Mechanical
// Completion, COD and Substantial Completion, and retainage releases at
// Substantial Completion. None was a task, so the billing sat on stand-ins and
// the projection dropped $284K owner and $288K sub retainage a month after the
// last movement - Jan 2028. These are zero-day milestones at the same points
// the stand-ins used, so billing does not move and retainage finds its event:
//   4.6 Mechanical Completion            after 4.4 Electrical
//   4.7 Commercial Operation (COD)       after 4.5 Commissioning
//   4.8 Substantial Completion           after 4.5 Commissioning
// Skips any code that already exists, then syncs dates.
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

const NEW = [
  { wbs: "4.6", name: "Mechanical Completion", pred: "4.4" },
  { wbs: "4.7", name: "Commercial Operation (COD)", pred: "4.5" },
  { wbs: "4.8", name: "Substantial Completion", pred: "4.5" },
];
const { data: tasks, error } = await sb.from("schedule_tasks").select("wbs_code, sort_order, end_date").eq("project_id", PID);
if (error) throw error;
const by = new Map((tasks ?? []).map((t) => [t.wbs_code, t]));
const after = Number(by.get("4.5")!.sort_order);
const rows = NEW.filter((n) => !by.has(n.wbs)).map((n, i) => ({
  project_id: PID,
  wbs_code: n.wbs,
  task_name: n.name,
  parent_wbs_code: "4",
  level_code: 2,
  sort_order: after + i + 1,
  predecessors: n.pred,
  duration_days: 0,
  is_milestone: true,
  start_date: by.get(n.pred)!.end_date,
  end_date: by.get(n.pred)!.end_date,
  status: "Not Started",
  task_type: "construction",
}));
if (rows.length) {
  const { error: iErr } = await sb.from("schedule_tasks").insert(rows);
  if (iErr) throw iErr;
}
const n = await syncScheduleDates(sb as never, PID);
const { data } = await sb.from("schedule_tasks").select("wbs_code, task_name, start_date, end_date").eq("project_id", PID).in("wbs_code", ["4.4", "4.5", ...NEW.map((x) => x.wbs)]).order("sort_order");
console.log(`inserted ${rows.length}, synced ${n}`);
console.table(data);
