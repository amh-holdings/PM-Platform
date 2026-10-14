// Sussex contractor permits into the schedule, 2026-10-14.
//
// Phil: "All we want to add in Contractor permits." Source: Drive, Mac Mini/
// Sussex CSG Schedule - Eng_Perm_Proc (4).xlsx, section 2.2 - names, owners
// and durations as written there. Durations are WORKING days (Phil). The
// workbook is an older Smartsheet export, so only its permit rows come in; the
// app's engineering dates stand (Phil: "Keep the schedule that we have in the
// app for those dates").
//
// Links. The sheet ties every permit to the Civil IFP, which only worked when
// all three IFPs landed the same day. In the app they do not, so each permit
// follows the IFP package it is filed with:
//   Civil IFP (1.2.1.4)           land disturbance, grading, DelDOT, NPDES
//   Civil + Structural IFP        building permit
//   Electrical IFP (1.2.3.3)      electrical permit
//   Civil + Electrical IFP        fire department review
// Erosion bond follows the land disturbance permit and the surety bond follows
// the county permits, as in the sheet. Rows already complete keep their dates.
//
// 2.2.6 All Permits Received is a new zero-day milestone after every open
// permit. Linking 4.1 Mobilization to it (replacing "106", a Smartsheet row
// number that resolves to nothing) moves construction about 7 weeks, so it is
// opt-in: --link-mobilization. Phil first wanted the permits in to review
// (2026-10-14). Exhibit E 4.00 is not relinked here either.
//
// Rows from 3 Procurement down are moved 300 sort places to make room; WBS
// codes are not touched. Skips any code that already exists. Dry run by
// default; --apply writes, then syncs dates the way the schedule page does.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadScheduleContext, syncScheduleDates } from "@/lib/schedule-sync-server";
import { planScheduleSync } from "@/lib/schedule-sync";
import type { CpmInput } from "@/lib/schedule-cpm";

const APPLY = process.argv.includes("--apply");
const LINK_MOB = process.argv.includes("--link-mobilization");
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

const CIVIL = "1.2.1.4";
const STRUCT = "1.2.2.3";
const ELEC = "1.2.3.3";

type Row = {
  wbs: string;
  name: string;
  who?: string;
  days?: number;
  pred?: string;
  done?: [string, string];
  milestone?: boolean;
};
const ROWS: Row[] = [
  { wbs: "2.2", name: "Contractor Permits" },
  { wbs: "2.2.1", name: "Sussex County Permits" },
  { wbs: "2.2.1.1", name: "Building Permit - Sussex County", who: "AHC", days: 40, pred: `${CIVIL}, ${STRUCT}` },
  { wbs: "2.2.1.2", name: "Electrical Permit - Sussex County", who: "AHC", days: 40, pred: ELEC },
  { wbs: "2.2.1.3", name: "Land Disturbance Permit - Sussex County", who: "AHC", days: 15, pred: CIVIL },
  { wbs: "2.2.1.4", name: "Grading Permit - Sussex County", who: "AHC", days: 15, pred: CIVIL },
  { wbs: "2.2.2", name: "DelDOT Permits" },
  { wbs: "2.2.2.1", name: "Entrance / Driveway Permit - DelDOT", who: "AHC", days: 20, pred: CIVIL },
  { wbs: "2.2.2.2", name: "ROW / Encroachment Permit - DelDOT", who: "AHC", days: 20, pred: CIVIL },
  { wbs: "2.2.3", name: "DNREC Permits" },
  { wbs: "2.2.3.1", name: "Sediment & Stormwater Management Plan", who: "AHC", done: ["2024-01-11", "2024-11-22"] },
  { wbs: "2.2.3.2", name: "Stormwater Pollution Prevention Plan (SWPPP)", who: "AHC", done: ["2024-01-11", "2024-11-22"] },
  { wbs: "2.2.3.3", name: "NPDES Construction General Permit (CGP)", who: "AHC", days: 5, pred: CIVIL },
  { wbs: "2.2.3.4", name: "Erosion Control Bond", who: "AHC", days: 5, pred: "2.2.1.3" },
  { wbs: "2.2.3.5", name: "DNREC Meadow Branch Tax Ditch LONO", who: "AHC", done: ["2025-10-14", "2025-10-15"] },
  { wbs: "2.2.4", name: "Other Permits & Bonds" },
  { wbs: "2.2.4.1", name: "Fire Department review - Delmar Fire Dept", who: "AHC", days: 40, pred: `${CIVIL}, ${ELEC}` },
  { wbs: "2.2.4.2", name: "Surety bond - Delaware 6% non-resident", who: "AHC", days: 5, pred: "2.2.1" },
  { wbs: "2.2.5", name: "CUP Compliance / Final Site Plan Approval - Sussex County", who: "Dimension / Pennoni", done: ["2025-11-03", "2025-11-03"] },
  {
    wbs: "2.2.6",
    name: "All Permits Received",
    who: "AHC",
    milestone: true,
    pred: "2.2.1.1, 2.2.1.2, 2.2.1.3, 2.2.1.4, 2.2.2.1, 2.2.2.2, 2.2.3.3, 2.2.3.4, 2.2.4.1, 2.2.4.2",
  },
];
const MOBILIZATION_PRED = "2.2.6";
const SORT_SHIFT = 300;

const ctx = await loadScheduleContext(sb as never, PID);
if (!ctx) throw new Error("no schedule");
const by = new Map(ctx.tasks.map((t) => [String(t.wbs_code), t]));
const permitting = by.get("2");
if (!permitting) throw new Error("no 2 Permitting");
const base = Number(permitting.sort_order);

const parentOf = (w: string) => w.split(".").slice(0, -1).join(".");
const placeholder = ctx.dataDate;
const fresh = ROWS.filter((r) => !by.has(r.wbs)).map((r, i) => ({
  project_id: PID,
  wbs_code: r.wbs,
  task_name: r.name,
  parent_wbs_code: parentOf(r.wbs),
  level_code: r.wbs.split(".").length,
  sort_order: base + 10 * (i + 1),
  predecessors: r.pred ?? null,
  duration_days: r.milestone ? 0 : r.done ? null : (r.days ?? null),
  is_milestone: !!r.milestone,
  // Open rows get a placeholder the sync replaces from their links.
  start_date: r.done ? r.done[0] : placeholder,
  end_date: r.done ? r.done[1] : placeholder,
  status: r.done ? "Complete" : "Not Started",
  pct_complete: r.done ? 100 : 0,
  assigned_to: r.who ?? null,
  task_type: "deliverable",
}));

// Preview: the same forecast the schedule page will compute.
const sim = [
  ...ctx.tasks.map((t) =>
    t.wbs_code === "4.1" && LINK_MOB ? { ...t, predecessors: MOBILIZATION_PRED } : t,
  ),
  ...fresh.map((f, i) => ({ ...f, id: `new-${i}` })),
] as unknown as CpmInput[];
const plan = new Map(
  planScheduleSync(sim, { calendar: ctx.calendar, dataDate: ctx.dataDate }).map((u) => [u.wbs, u]),
);
const dateOf = (w: string) => {
  const p = plan.get(w);
  const t = (sim as unknown as { wbs_code: string; start_date: string; end_date: string }[]).find((x) => x.wbs_code === w)!;
  return { start: p?.start ?? t.start_date, end: p?.end ?? t.end_date, moved: !!p };
};
console.log("NEW ROWS");
for (const r of ROWS) {
  const d = dateOf(r.wbs);
  console.log(`  ${r.wbs.padEnd(8)} ${r.name.slice(0, 50).padEnd(50)} ${d.start} -> ${d.end}  ${r.pred ?? (r.done ? "complete" : "")}`);
}
console.log("\nKNOCK-ON (only rows whose dates change)");
for (const t of ctx.tasks) {
  const p = plan.get(String(t.wbs_code));
  if (!p || ROWS.some((r) => r.wbs === t.wbs_code)) continue;
  console.log(`  ${String(t.wbs_code).padEnd(10)} ${String(t.task_name).slice(0, 40).padEnd(40)} ${t.start_date} -> ${t.end_date}   now ${p.start} -> ${p.end}`);
}

if (!APPLY) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}

for (const t of ctx.tasks) {
  if (Number(t.sort_order) > base && !String(t.wbs_code).startsWith("2.")) {
    const { error } = await sb
      .from("schedule_tasks")
      .update({ sort_order: Number(t.sort_order) + SORT_SHIFT })
      .eq("id", t.id);
    if (error) throw error;
  }
}
if (fresh.length) {
  const { error } = await sb.from("schedule_tasks").insert(fresh as never);
  if (error) throw error;
}
if (LINK_MOB) {
  const { error: mErr } = await sb
    .from("schedule_tasks")
    .update({ predecessors: MOBILIZATION_PRED })
    .eq("project_id", PID)
    .eq("wbs_code", "4.1");
  if (mErr) throw mErr;
}
const written = await syncScheduleDates(sb as never, PID);
console.log(`\nInserted ${fresh.length}, ${LINK_MOB ? `linked 4.1 to ${MOBILIZATION_PRED}` : "4.1 left unlinked"}, synced ${written} dates.`);
