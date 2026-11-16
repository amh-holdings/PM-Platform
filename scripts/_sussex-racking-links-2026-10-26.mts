// Sussex 4.3: copy Sweet Springs 5.2 internal logic onto 4.3.02-4.3.19
// (Phil, 2026-10-26). 4.3.01 stays unlinked. Links that leave the Sweet
// Springs mechanical branch (site grading, pile/CAB/racking deliveries) have no
// Sussex twin yet and are dropped, not guessed.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parsePredecessors, serializeLinks } from "@/lib/schedule-cpm";
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
const { data: srcAll } = await sb.from("schedule_tasks").select("*").eq("project_id", ssp!.id);
const src = (scheduleOrder(srcAll as never) as any[]).filter(
  (t) => t.wbs_code.startsWith("5.2.") && t.wbs_code.split(".").length === 3,
);
const toSussex = new Map(src.map((t, i) => [t.wbs_code, `4.3.${String(i + 1).padStart(2, "0")}`]));

const { data: before } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
writeFileSync(
  "db/snapshots/schedule_tasks_sussex_pre-racking-links_2026-10-26.json",
  JSON.stringify(before, null, 2),
);

const dropped: string[] = [];
for (const t of src) {
  const code = toSussex.get(t.wbs_code)!;
  if (code === "4.3.01") {
    dropped.push(...parsePredecessors(t.predecessors).map((l) => `${code} <- ${l.pred} (first task, left unset)`));
    continue;
  }
  const row = before!.find((r) => r.wbs_code === code)!;
  if (row.task_name !== t.task_name || row.predecessors) throw new Error(`${code} mismatch or already linked`);
  const links = parsePredecessors(t.predecessors).flatMap((l) => {
    const to = toSussex.get(l.pred);
    if (!to) {
      dropped.push(`${code} <- ${l.pred} ${srcAll!.find((s) => s.wbs_code === l.pred)?.task_name}`);
      return [];
    }
    return [{ ...l, pred: to }];
  });
  const { error } = await sb.from("schedule_tasks").update({ predecessors: serializeLinks(links) }).eq("id", row.id);
  if (error) throw error;
}
console.log("not copied:\n  " + dropped.join("\n  "));
console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");

const { data: after } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
for (const r of (scheduleOrder(after as never) as any[]).filter((r) => r.wbs_code === "4.3" || r.wbs_code.startsWith("4.3.") || /^4\.[4-8]$/.test(r.wbs_code)))
  console.log(`${r.wbs_code.padEnd(7)} ${r.task_name.slice(0, 34).padEnd(34)} ${String(r.duration_days ?? "-").padStart(2)}d ${r.start_date}->${r.end_date} <- ${r.predecessors ?? "-"}`);
