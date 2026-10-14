// Three procurement milestones on Sussex, so Exhibit E's procurement lines
// have something to earn on.
//
// A billing line earns in the month its linked task FINISHES. Phil placed
// these at the START of install (2026-10-08), and linking to 4.3 or 4.4
// itself would bill them at the end. So each is a zero-day milestone tied
// start-to-start to its install task: it sits on the install start and moves
// whenever the install moves.
//
//   3.1 Switchgear PO Issued     4.4SS  (Exhibit E 5.06)
//   3.2 Pile & Racking Delivered 4.3SS  (Exhibit E 5.05, and 200-1030 racking cost)
//   3.3 Modules Delivered        4.4SS  (Exhibit E 5.02)
//
// 3 Procurement had no children. WBS codes are new, so nothing points at them
// yet. Skips any code that already exists. Dry run by default; --apply writes.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
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
  { wbs: "3.1", name: "Switchgear PO Issued", pred: "4.4" },
  { wbs: "3.2", name: "Pile & Racking Delivered", pred: "4.3" },
  { wbs: "3.3", name: "Modules Delivered", pred: "4.4" },
];

const { data: tasks, error } = await sb
  .from("schedule_tasks")
  .select("wbs_code, start_date, sort_order")
  .eq("project_id", PID);
if (error) throw error;
const by = new Map((tasks ?? []).map((t) => [t.wbs_code, t]));
const parent = by.get("3");
if (!parent) throw new Error("no 3 Procurement");

const rows = NEW.filter((n) => !by.has(n.wbs)).map((n, i) => {
  const pred = by.get(n.pred);
  if (!pred?.start_date) throw new Error(`${n.pred} has no start date`);
  return {
    project_id: PID,
    wbs_code: n.wbs,
    task_name: n.name,
    parent_wbs_code: "3",
    level_code: 2,
    sort_order: Number(parent.sort_order) + 2 * (i + 1),
    predecessors: `${n.pred}SS`,
    duration_days: 0,
    is_milestone: true,
    start_date: pred.start_date,
    end_date: pred.start_date,
    status: "Not Started",
    task_type: "deliverable",
  };
});

console.table(rows.map((r) => ({ wbs: r.wbs_code, name: r.task_name, pred: r.predecessors, date: r.start_date })));
if (!rows.length) console.log("All three already exist.");
if (!APPLY) {
  console.log("Dry run. Pass --apply to write.");
  process.exit(0);
}
if (rows.length) {
  const { error: iErr } = await sb.from("schedule_tasks").insert(rows);
  if (iErr) throw iErr;
}
console.log(`Inserted ${rows.length}.`);
