// Sussex Phase 3: Remove temp controls moves ahead of Permanent seeding (Phil,
// 2026-10-26). It takes the free 4.2.3.03 slot; seeding now follows it and
// as-builts follows vegetation establishment.
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
  "db/snapshots/schedule_tasks_sussex_pre-phase3-reorder_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
const row = (code: string, name: string) => {
  const r = before!.find((x) => x.wbs_code === code);
  if (!r || !r.task_name.startsWith(name)) throw new Error(`${code} is not ${name}`);
  return r;
};
if (before!.some((x) => x.wbs_code === "4.2.3.03")) throw new Error("4.2.3.03 is taken");
const remove = row("4.2.3.06", "Remove temp controls");
const seeding = row("4.2.3.04", "Permanent seeding");
const asbuilts = row("4.2.3.07", "As-builts");
// Nothing outside these rows may name 4.2.3.06.
for (const r of before!)
  if (r.id !== asbuilts.id && /(^|,\s*)4\.2\.3\.06(?![\d.])/.test(r.predecessors ?? ""))
    throw new Error(`${r.wbs_code} links 4.2.3.06`);

const updates: [string, Record<string, unknown>][] = [
  [remove.id, { wbs_code: "4.2.3.03", sort_order: 1607, predecessors: null }],
  [seeding.id, { predecessors: "4.2.3.03" }],
  [asbuilts.id, { predecessors: "4.2.3.05" }],
];
for (const [id, patch] of updates) {
  const { error } = await sb.from("schedule_tasks").update(patch).eq("id", id);
  if (error) throw error;
}

console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");
const { data: after } = await sb
  .from("schedule_tasks")
  .select("sort_order, level_code, wbs_code, task_name, duration_days, start_date, end_date, predecessors")
  .eq("project_id", pid).gte("sort_order", 1590).lte("sort_order", 1612).order("sort_order");
for (const r of after!)
  console.log(
    `${"  ".repeat((r.level_code ?? 2) - 2)}${r.wbs_code.padEnd(9)} ${r.task_name.slice(0, 50).padEnd(50)} ${String(r.duration_days ?? "-").padStart(3)}d ${r.start_date}->${r.end_date} <- ${r.predecessors ?? "-"}`,
  );
