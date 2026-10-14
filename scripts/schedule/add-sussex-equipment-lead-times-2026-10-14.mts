// Sussex equipment POs and lead times in the schedule, 2026-10-14.
//
// Phil: "Right now we just need to know the date we need to order so
// electrical can start on time." Source: Drive, Mac Mini/Sussex CSG Schedule -
// Eng_Perm_Proc (4).xlsx, section 3.1. Its lead times are weeks (Phil) exported
// as days - 119d is 17 weeks - so they go in as weeks of five working days.
// Combiners read 40d, not a whole number of weeks; taken as 6 and flagged.
// Transit is blank everywhere: 1 week (Phil). Blank lead times stay blank and
// the row says TBD, so a missing number is visible instead of guessed.
//
// Each item counts BACK from the day it is needed on site:
//   .3 Delivery (transit)    finishes when its install starts   <install>SF
//   .2 Lead time             finishes when delivery starts      .3SF
//   .1 Order By (PO issued)  on the day the lead time starts    .2SS
// Electrical gear is needed at 4.4 Electrical; trackers and modules at 4.3
// Structural / Racking, which they feed. Move the install and every order
// date moves with it.
//
// New codes 3.4-3.18. The existing 3.1-3.3 milestones are left alone - Exhibit
// E billing and the placeholder POs point at them.
//
// Rows from 4 Construction down move 600 sort places to make room. Skips any
// code that already exists. Dry run by default; --apply writes and syncs.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadScheduleContext, syncScheduleDates } from "@/lib/schedule-sync-server";
import { planScheduleSync } from "@/lib/schedule-sync";
import type { CpmInput } from "@/lib/schedule-cpm";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";
const TRANSIT_DAYS = 5;
const SORT_SHIFT = 600;

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

// [wbs, item, who, lead weeks (null = TBD, 0 = in stock), needed at]
const ITEMS: [string, string, string, number | null, string][] = [
  // Ampacity, 16 weeks (Phil, 2026-10-14).
  ["3.4", "Trackers / Racking PO (Ampacity)", "AHC / Ampacity", 16, "4.3"],
  ["3.5", "MV Recloser / Switchgear PO (GridPower OSM AL_5)", "AHC / GridPower", 17, "4.4"],
  // 3.6 Modules and 3.7 Inverters were removed the same day: owner-furnished
  // (Phil), so there is no PO of ours to time.
  ["3.8", "LV Switchboards & Panelboards PO (GridPower ReliaGear)", "AHC / GridPower", 12, "4.4"],
  ["3.9", "SCADA / DAS PO (Power Factors)", "AHC / Power Factors", 24, "4.4"],
  ["3.10", "Met Station PO (GroundWork Renewables)", "AHC / GroundWork Renewables", 24, "4.4"],
  ["3.11", "Relay / Recloser Control PO", "AHC", 16, "4.4"],
  ["3.12", "GOAB PO (GridPower LINEBOSS 15kV)", "AHC / GridPower", 12, "4.4"],
  ["3.13", "Surge Protective Devices PO (OVRH qty 10)", "AHC", 14, "4.4"],
  ["3.14", "Mini Power Centers PO (Powertran qty 2)", "AHC / Powertran", 8, "4.4"],
  ["3.15", "AC 30A Disconnect Switch PO", "AHC", 12, "4.4"],
  ["3.16", "Fuses for Disconnect", "AHC", 0, "4.4"],
  ["3.17", "ABB-TNI66 600A Neutral Kit (600V safety switch)", "AHC", 4, "4.4"],
  ["3.18", "Combiners & Disconnects PO (TerraSmart)", "TerraSmart", 6, "4.4"],
];

type NewRow = Record<string, unknown> & { wbs_code: string };
const rows: NewRow[] = [];
for (const [wbs, item, who, weeks, need] of ITEMS) {
  const lead =
    weeks === null ? "Lead time (manufacturing) - TBD" : weeks === 0 ? "Lead time - in stock" : `Lead time (manufacturing) - ${weeks} wks`;
  const base = { project_id: PID, status: "Not Started", pct_complete: 0, assigned_to: who, task_type: "procurement" };
  rows.push({ ...base, wbs_code: wbs, task_name: item, parent_wbs_code: "3", level_code: 2, predecessors: null, duration_days: null, is_milestone: false });
  rows.push({ ...base, wbs_code: `${wbs}.1`, task_name: "Order By (PO issued)", parent_wbs_code: wbs, level_code: 3, predecessors: `${wbs}.2SS`, duration_days: 0, is_milestone: true });
  rows.push({ ...base, wbs_code: `${wbs}.2`, task_name: lead, parent_wbs_code: wbs, level_code: 3, predecessors: `${wbs}.3SF`, duration_days: (weeks ?? 0) * 5, is_milestone: false });
  rows.push({ ...base, wbs_code: `${wbs}.3`, task_name: "Delivery (transit)", parent_wbs_code: wbs, level_code: 3, predecessors: `${need}SF`, duration_days: TRANSIT_DAYS, is_milestone: false });
}

const ctx = await loadScheduleContext(sb as never, PID);
if (!ctx) throw new Error("no schedule");
const by = new Map(ctx.tasks.map((t) => [String(t.wbs_code), t]));
const after = Math.max(...["3", "3.1", "3.2", "3.3"].map((w) => Number(by.get(w)?.sort_order ?? 0)));
const fresh = rows
  .filter((r) => !by.has(r.wbs_code))
  .map((r, i) => ({ ...r, sort_order: after + 10 * (i + 1), start_date: ctx.dataDate, end_date: ctx.dataDate }));

const sim = [...ctx.tasks, ...fresh.map((f, i) => ({ ...f, id: `new-${i}` }))] as unknown as CpmInput[];
const plan = new Map(planScheduleSync(sim, { calendar: ctx.calendar, dataDate: ctx.dataDate }).map((u) => [u.wbs, u]));
const at = (w: string) => plan.get(w) ?? { start: String(by.get(w)?.start_date), end: String(by.get(w)?.end_date) };
console.log("ORDER BY       DELIVERED BY   ITEM");
for (const [wbs, item, , weeks, need] of ITEMS) {
  console.log(`${at(`${wbs}.1`).start}     ${at(`${wbs}.3`).end}     ${wbs.padEnd(5)} ${item}  [${weeks === null ? "TBD" : weeks + " wks"} -> ${need} starts ${at(need).start}]`);
}
const moved = Array.from(plan.values()).filter((u) => by.has(u.wbs) && u.wbs !== "3");
if (moved.length) console.log(`\nEXISTING ROWS THAT WOULD MOVE: ${moved.map((u) => u.wbs).join(", ")}`);

if (!APPLY) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}
for (const t of ctx.tasks) {
  if (Number(t.sort_order) > after && !String(t.wbs_code).startsWith("3")) {
    const { error } = await sb.from("schedule_tasks").update({ sort_order: Number(t.sort_order) + SORT_SHIFT }).eq("id", t.id);
    if (error) throw error;
  }
}
if (fresh.length) {
  const { error } = await sb.from("schedule_tasks").insert(fresh as never);
  if (error) throw error;
}
const n = await syncScheduleDates(sb as never, PID);
console.log(`\nInserted ${fresh.length}, synced ${n} dates.`);
