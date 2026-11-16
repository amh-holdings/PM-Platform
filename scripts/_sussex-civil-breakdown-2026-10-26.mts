// Sussex 4.2 Civil / Grading broken into 19 children (2026-10-26).
// External logic: only the civil permits (2.2.1.3, 2.2.1.4) on 4.2.01/4.2.02.
// 4.2.14's M&E link, the pile link, 4.1 and 4.3's 4.2SS+25 are left for Phil.
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
const PERMITS = "2.2.1.3, 2.2.1.4";
const PHOTO = "Quantity + photo: a photo must be attached in the daily report.";

// [code, name, unit, qty (null = TBD / none), track, duration, preds, milestone]
type Row = [string, string, string | null, number | null, "Q" | "P" | "M", number, string | null];
const rows: Row[] = [
  ["4.2.01", "Construction entrance, widened temp drive", "EA", 1, "P", 5, PERMITS],
  ["4.2.02", "Silt fence", "LF", null, "Q", 5, PERMITS],
  ["4.2.03", "Sensitive area protection, stockpile, washout", "LS", 1, "P", 3, "4.2.02SS+2"],
  ["4.2.04", "District initial inspection", null, null, "M", 0, "4.2.01, 4.2.02, 4.2.03"],
  ["4.2.05", "Clear and grub (incl 0.65 ac trees)", "AC", 16.9, "Q", 7, "4.2.04"],
  ["4.2.06", "Culvert crossing 1, 36 in HDPE with riprap", "LF", 48, "Q", 3, "4.2.05SS+3"],
  ["4.2.07", "Culvert crossing 2, 12 in HDPE with riprap", "LF", 50, "Q", 2, "4.2.05SS+3"],
  ["4.2.08", "Access roads", "LF", 1400, "Q", 10, "4.2.06, 4.2.07"],
  ["4.2.09", "Laydown yard", "SF", null, "Q", 4, "4.2.08SS+3"],
  ["4.2.10", "Swales and channel matting", "LF", null, "Q", 4, "4.2.05"],
  ["4.2.11", "Site released for pile install", null, null, "M", 0, "4.2.08, 4.2.09, 4.2.10"],
  ["4.2.12", "Perimeter fence with screen", "LF", null, "Q", 15, "4.2.05"],
  ["4.2.13", "Gates, incl emergency gate with Knox box", "EA", null, "Q", 2, "4.2.12"],
  ["4.2.14", "Final grading and restoration", "AC", 16.9, "Q", 8, null],
  ["4.2.15", "Permanent seeding", "AC", 16.9, "Q", 8, "4.2.14"],
  ["4.2.16", "Vegetation establishment, 70 percent cover", "Percent cover", null, "P", 30, "4.2.15"],
  ["4.2.17", "Remove temp controls, laydown, temp entrance", "LS", 1, "P", 7, "4.2.16"],
  ["4.2.18", "As-builts and closeout", "LS", 1, "P", 26, "4.2.17"],
  ["4.2.19", "Civil complete", null, null, "M", 0, "4.2.18, 4.2.13"],
];

const { data: before } = await sb.from("schedule_tasks").select("*").eq("project_id", pid);
if (before!.some((r) => r.wbs_code.startsWith("4.2."))) throw new Error("4.2 already has children - aborting");
writeFileSync(
  "db/snapshots/schedule_tasks_sussex_pre-civil-breakdown_2026-10-26.json",
  JSON.stringify(before, null, 2),
);

const insert = rows.map(([code, name, unit, qty, track, dur, preds], i) => ({
  project_id: pid,
  wbs_code: code,
  task_name: name,
  parent_wbs_code: "4.2",
  level_code: 3,
  sort_order: 1591 + i,
  duration_days: dur,
  is_milestone: track === "M",
  task_type: "construction",
  predecessors: preds,
  unit_of_measure: unit,
  // Percent lines carry a unit only: a target quantity would switch them to
  // quantity tracking. TBD stays null, never 0.
  target_quantity: track === "Q" ? qty : null,
  description:
    code === "4.2.06" || code === "4.2.07"
      ? PHOTO
      : track === "P"
        ? `Track by percent complete from daily reports (scope: ${qty ?? 70} ${unit}).`
        : track === "M"
          ? "Milestone, tracked Done / Not Done."
          : null,
}));
const { error } = await sb.from("schedule_tasks").insert(insert);
if (error) throw error;
console.log(`inserted ${insert.length}`);

console.log("sync changed", await syncScheduleDates(sb as never, pid), "rows");

const { data: after } = await sb
  .from("schedule_tasks")
  .select("wbs_code, task_name, duration_days, start_date, end_date, predecessors, unit_of_measure, target_quantity")
  .eq("project_id", pid)
  .or("wbs_code.eq.4.2,wbs_code.like.4.2.%,wbs_code.eq.4.3")
  .order("sort_order");
for (const r of after!)
  console.log(
    `${r.wbs_code.padEnd(7)} ${r.task_name.slice(0, 44).padEnd(44)} ${String(r.duration_days).padStart(3)}d ${r.start_date}->${r.end_date}  ${r.unit_of_measure ?? ""} ${r.target_quantity ?? ""}  <- ${r.predecessors ?? "-"}`,
  );
