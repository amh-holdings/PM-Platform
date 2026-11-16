// Sussex 4.2 Civil / Grading regrouped into the three EPSC phases of the civil
// plan set (C03.0 / C03.1 / C04). Rows are re-parented and re-coded in place,
// matched by activity id, so progress, links and history follow them.
// Final grading and restoration was deleted earlier the same day and is
// recreated with its original values, as Phil's list includes it.
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

const PHASES = [
  ["4.2.1", "Phase 1: Initial erosion and sediment control (C03.0)"],
  ["4.2.2", "Phase 2: Access, drainage, laydown (C03.1)"],
  ["4.2.3", "Phase 3: Fence, final stabilization, closeout (C04)"],
] as const;

// current code -> [new code, name]. null current = recreate.
const MAP: [string | null, string, string][] = [
  ["4.2.01", "4.2.1.01", "Construction entrance, widened temp drive"],
  ["4.2.02", "4.2.1.02", "Silt fence"],
  ["4.2.03", "4.2.1.03", "Sensitive area protection, stockpile, washout"],
  ["4.2.04", "4.2.1.04", "District initial inspection"],
  ["4.2.05", "4.2.1.05", "Clear and grub (incl 0.65 ac trees)"],
  ["4.2.06", "4.2.2.01", "Culvert crossing 1, 36 in HDPE with riprap"],
  ["4.2.07", "4.2.2.02", "Culvert crossing 2, 12 in HDPE with riprap"],
  ["4.2.08", "4.2.2.03", "Access roads"],
  ["4.2.09", "4.2.2.04", "Laydown yard"],
  ["4.2.10", "4.2.2.05", "Swales and channel matting"],
  ["4.2.11", "4.2.2.06", "Site released for pile install"],
  ["4.2.12", "4.2.3.01", "Perimeter fence with screen"],
  ["4.2.13", "4.2.3.02", "Gates, incl emergency gate with Knox box"],
  [null, "4.2.3.03", "Final grading and restoration"],
  ["4.2.14", "4.2.3.04", "Permanent seeding"],
  ["4.2.15", "4.2.3.05", "Vegetation establishment, 70 percent cover"],
  ["4.2.16", "4.2.3.06", "Remove temp controls, laydown, temp entrance"],
  ["4.2.17", "4.2.3.07", "As-builts and closeout"],
  ["4.2.18", "4.2.3.08", "Civil complete"],
];

const { data: before } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
writeFileSync(
  "db/snapshots/schedule_tasks_sussex_pre-three-phases_2026-10-26.json",
  JSON.stringify(before, null, 2),
);
const byCode = new Map(before!.map((r) => [r.wbs_code, r]));
for (const [cur, , name] of MAP) {
  if (!cur) continue;
  const r = byCode.get(cur);
  const want = name.split(" ")[0].toLowerCase();
  if (!r || !r.task_name.toLowerCase().includes(want)) throw new Error(`${cur} is not ${name}: ${r?.task_name}`);
}
const pre = {
  pile: byCode.get("4.2.11")!,
  done: byCode.get("4.2.18")!,
};
const recode = new Map(MAP.filter(([c]) => c).map(([c, n]) => [c!, n]));

// Summaries first.
const { error: sErr } = await sb.from("schedule_tasks").insert(
  PHASES.map(([code, name]) => ({
    project_id: pid, wbs_code: code, task_name: name, parent_wbs_code: "4.2", level_code: 3,
    task_type: "construction", is_milestone: false,
  })),
);
if (sErr) throw sErr;

// Re-code in place. New codes never collide with old ones (4.2.N.NN vs 4.2.NN).
let sort = 1590;
let phase = "";
const brokenLinks: string[] = [];
for (const [cur, code, name] of MAP) {
  const ph = code.slice(0, 5);
  if (ph !== phase) {
    phase = ph;
    sort += 1;
    await sb.from("schedule_tasks").update({ sort_order: sort }).eq("project_id", pid).eq("wbs_code", ph);
  }
  sort += 1;
  if (!cur) {
    const { error } = await sb.from("schedule_tasks").insert({
      project_id: pid, wbs_code: code, task_name: name, parent_wbs_code: ph, level_code: 4,
      sort_order: sort, duration_days: 8, is_milestone: false, task_type: "construction",
      unit_of_measure: "AC", target_quantity: 16.9, predecessors: null,
    });
    if (error) throw error;
    continue;
  }
  const row = byCode.get(cur)!;
  const links = parsePredecessors(row.predecessors).map((l) => {
    if (!l.pred.startsWith("4.2.")) return l;
    const to = recode.get(l.pred);
    if (!to) brokenLinks.push(`${cur} -> ${l.pred}`);
    return { ...l, pred: to ?? l.pred };
  });
  // Seeding followed final grading in the original logic; restore that link.
  if (code === "4.2.3.04") links.push({ pred: "4.2.3.03", type: "FS", lag: 0 });
  const { error } = await sb
    .from("schedule_tasks")
    .update({
      wbs_code: code, task_name: name, parent_wbs_code: ph, level_code: 4,
      sort_order: sort, predecessors: serializeLinks(links),
    })
    .eq("id", row.id);
  if (error) throw error;
}
console.log("broken internal links:", brokenLinks.length ? brokenLinks : "none");

// Anything left pointing at an old 4.2.NN code?
const { data: mid } = await sb.from("schedule_tasks").select("wbs_code, predecessors").eq("project_id", pid);
const codes = new Set(mid!.map((r) => r.wbs_code));
for (const r of mid!)
  for (const l of parsePredecessors(r.predecessors))
    if (!codes.has(l.pred)) console.log(`DANGLING ${r.wbs_code} -> ${l.pred}`);

console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");

const { data: after } = await sb
  .from("schedule_tasks")
  .select("id, sort_order, level_code, wbs_code, task_name, duration_days, start_date, end_date, predecessors, unit_of_measure, target_quantity")
  .eq("project_id", pid).gte("sort_order", 1580).lte("sort_order", 1630).order("sort_order");
for (const r of after!)
  console.log(
    `${r.sort_order} ${"  ".repeat((r.level_code ?? 2) - 2)}${r.wbs_code.padEnd(9)} ${r.task_name.slice(0, 52).padEnd(52)} ${String(r.duration_days ?? "-").padStart(3)}d ${r.start_date}->${r.end_date} ${r.unit_of_measure ?? ""} ${r.target_quantity ?? ""} <- ${r.predecessors ?? "-"}`,
  );
const pile = after!.find((r) => r.id === pre.pile.id)!;
const done = after!.find((r) => r.id === pre.done.id)!;
console.log(`\npile release  before ${pre.pile.start_date}/${pre.pile.end_date}  after ${pile.wbs_code} ${pile.start_date}/${pile.end_date}`);
console.log(`civil complete before ${pre.done.start_date}/${pre.done.end_date}  after ${done.wbs_code} ${done.start_date}/${done.end_date}`);
