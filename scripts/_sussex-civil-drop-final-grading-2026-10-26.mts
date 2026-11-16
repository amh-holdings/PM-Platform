// Sussex: drop 4.2.14 Final grading and restoration - restoration is the
// permanent seeding on this job. Seeding absorbs rut and trench repair, and
// 4.2.15-4.2.19 renumber up to 4.2.14-4.2.18 so the branch has no gap.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parsePredecessors, serializeLinks } from "@/lib/schedule-cpm";
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
const RENUMBER: Record<string, string> = {
  "4.2.15": "4.2.14", "4.2.16": "4.2.15", "4.2.17": "4.2.16", "4.2.18": "4.2.17", "4.2.19": "4.2.18",
};

const { data: before } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
writeFileSync(
  "db/snapshots/schedule_tasks_sussex_pre-drop-final-grading_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
const target = before!.find((r) => r.wbs_code === "4.2.14")!;
if (target.task_name !== "Final grading and restoration") throw new Error("4.2.14 is not the row expected");

// Anything outside the renumbered rows that names a code being dropped or moved?
const touched = new Set(["4.2.14", ...Object.keys(RENUMBER)]);
for (const r of before!) {
  const hits = parsePredecessors(r.predecessors).filter((l) => touched.has(l.pred));
  if (hits.length && !(r.wbs_code in RENUMBER)) throw new Error(`${r.wbs_code} references ${hits.map((h) => h.pred)}`);
}
const { data: bl } = await sb.from("billing_lines").select("item_number, linked_task_wbs_codes").eq("project_id", pid);
const { data: ss } = await sb.from("sub_sov_lines").select("item_number, linked_task_wbs_codes").eq("project_id", pid);
for (const b of [...(bl ?? []), ...(ss ?? [])])
  if (((b.linked_task_wbs_codes ?? []) as string[]).some((c) => touched.has(c))) throw new Error(`SOV ${b.item_number} links in`);
for (const tbl of ["dpr_task_updates", "inspections", "schedule_task_documents"] as const) {
  const { count } = await sb.from(tbl).select("*", { count: "exact", head: true }).eq("schedule_task_id", target.id);
  if (count) throw new Error(`${tbl} has ${count} rows on 4.2.14`);
}

const { error: delErr } = await sb.from("schedule_tasks").delete().eq("id", target.id);
if (delErr) throw delErr;

// Ascending, so each new code is already free when it is taken.
for (const old of Object.keys(RENUMBER)) {
  const row = before!.find((r) => r.wbs_code === old)!;
  const links = parsePredecessors(row.predecessors)
    .filter((l) => l.pred !== "4.2.14")
    .map((l) => ({ ...l, pred: RENUMBER[l.pred] ?? l.pred }));
  const patch: Record<string, unknown> = {
    wbs_code: RENUMBER[old],
    predecessors: serializeLinks(links),
    sort_order: row.sort_order! - 1,
  };
  if (old === "4.2.15") patch.task_name = "Restoration and permanent seeding (incl rut and trench repair)";
  const { error } = await sb.from("schedule_tasks").update(patch).eq("id", row.id);
  if (error) throw error;
}

console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");
const { data: after } = await sb
  .from("schedule_tasks")
  .select("sort_order, wbs_code, task_name, duration_days, start_date, end_date, predecessors, unit_of_measure, target_quantity")
  .eq("project_id", pid)
  .gte("sort_order", 1590).lte("sort_order", 1620)
  .order("sort_order");
for (const r of after!)
  console.log(
    `${r.sort_order} ${r.wbs_code.padEnd(7)} ${r.task_name.slice(0, 50).padEnd(50)} ${String(r.duration_days).padStart(3)}d ${r.start_date}->${r.end_date} ${r.unit_of_measure ?? ""} ${r.target_quantity ?? ""} <- ${r.predecessors ?? "-"}`,
  );
