// Sussex Phase 1 resequenced as one chain (Phil, 2026-10-26):
// Mobilization -> construction entrance -> silt fence -> sensitive area
// protection -> clear and grub -> District initial inspection.
// Clear and grub and the inspection swap codes and positions; links follow the
// activity, so everything that pointed at clear and grub is rewritten.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { rewritePredecessors } from "@/lib/schedule-edit";
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
  "db/snapshots/schedule_tasks_sussex_pre-phase1-sequence_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
const row = (code: string, name: string) => {
  const r = before!.find((x) => x.wbs_code === code);
  if (!r || !r.task_name.startsWith(name)) throw new Error(`${code} is not ${name}`);
  return r;
};
const entrance = row("4.2.1.01", "Construction entrance");
const silt = row("4.2.1.02", "Silt fence");
const sensitive = row("4.2.1.03", "Sensitive area protection");
const inspection = row("4.2.1.04", "District initial inspection");
const clear = row("4.2.1.05", "Clear and grub");

// Links elsewhere that name either swapped code follow their activity.
const renames = new Map([["4.2.1.05", "4.2.1.04"], ["4.2.1.04", "4.2.1.05"]]);
const phase1 = new Set([entrance.id, silt.id, sensitive.id, inspection.id, clear.id]);
const relinked: string[] = [];
for (const r of before!) {
  if (phase1.has(r.id)) continue;
  const next = rewritePredecessors(r.predecessors, renames);
  if (next === r.predecessors) continue;
  const { error } = await sb.from("schedule_tasks").update({ predecessors: next }).eq("id", r.id);
  if (error) throw error;
  relinked.push(`${r.wbs_code}: ${r.predecessors} -> ${next}`);
}

// Swap codes through a temporary one - (project_id, wbs_code) is unique.
const set = async (id: string, patch: Record<string, unknown>) => {
  const { error } = await sb.from("schedule_tasks").update(patch).eq("id", id);
  if (error) throw error;
};
await set(inspection.id, { wbs_code: "4.2.1.04-tmp" });
await set(clear.id, { wbs_code: "4.2.1.04", sort_order: inspection.sort_order, predecessors: "4.2.1.03" });
await set(inspection.id, { wbs_code: "4.2.1.05", sort_order: clear.sort_order, predecessors: "4.2.1.04" });
// Mobilization joins the permits, which stay as their own constraint.
await set(entrance.id, { predecessors: "4.1, 2.2.1.3, 2.2.1.4" });
await set(silt.id, { predecessors: "4.2.1.01" });
await set(sensitive.id, { predecessors: "4.2.1.02" });

console.log("relinked outside Phase 1:\n  " + (relinked.join("\n  ") || "none"));
console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");

const { data: after } = await sb
  .from("schedule_tasks")
  .select("level_code, wbs_code, task_name, duration_days, start_date, end_date, predecessors")
  .eq("project_id", pid).gte("sort_order", 1580).lte("sort_order", 1620).order("sort_order");
for (const r of after!)
  console.log(
    `${"  ".repeat((r.level_code ?? 2) - 2)}${r.wbs_code.padEnd(9)} ${r.task_name.slice(0, 50).padEnd(50)} ${String(r.duration_days ?? "-").padStart(3)}d ${r.start_date}->${r.end_date} <- ${r.predecessors ?? "-"}`,
  );
