// Load the GridPower Solutions ship schedule (job 134594, Sweet Spring Solar)
// onto the delivery tasks and PO lines.
//
// Why this exists: the delivery dates in the schedule came from a one-time
// import and the PO header carried a single expected_delivery_date for a PO
// covering seven items with five different dates. The ship schedule is the
// vendor's own document and is per item, so it is the better source.
//
// Conventions taken from the sheet itself:
//   - Where a "Current ESD / Ship Date" exists it supersedes the original ESD.
//     The sheet is pulling in, not slipping: GOAB 9/18 against 9/30, arrestors
//     9/30 against 10/15, mini power center 10/2 against 10/30.
//   - A delivery is a point event, not a span. The multi-day durations on these
//     tasks were lead-time artifacts of the authoring sheet, so a task with a
//     known ship date becomes a milestone on that date.
//   - Material the sheet marks Delivered is recorded as actual on the PO line
//     and the task is closed out.
//
// Power Factors (4.4.6.2) is deliberately NOT touched. It is a different vendor,
// absent from this sheet, and it is the item actually gating electrical start.
//
// Usage:
//   node scripts/load-gridpower-ship-schedule.mjs           # dry run
//   node scripts/load-gridpower-ship-schedule.mjs --apply

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
const APPLY = process.argv.includes("--apply");

// wbs -> what the ship schedule says. `date` already applies the current-ship-
// date-wins rule. `delivered` means the sheet's Material Status reads Delivered.
const SHIP = {
  "4.4.4.2":  { item: "27kV Recloser SEL 651R",            vendor: "Tavrida",         date: "2026-10-18", delivered: false, note: "In production, on time. Original ESD 10/18." },
  "4.4.7.2":  { item: "GOAB Lineboss 25kV 900A",           vendor: "Maclean/Inertia", date: "2026-09-18", delivered: true,  note: "Delivered. Shipped 9/18 against a 9/30 ESD." },
  "4.4.8.2":  { item: "Primary Metering CT 40:5 / PT 60:1", vendor: "EHV",            date: "2026-10-25", delivered: false, note: "In production, on time. Original ESD 10/25." },
  "4.4.9.2":  { item: "600A LVPB 1.1 and 1.2",             vendor: "ABB Empower",     date: "2026-10-21", delivered: false, note: "1.1 in transit to jobsite, 1.2 in production. Both ESD 10/21." },
  "4.4.10.2": { item: "Mini Power Center 7.5kVA",          vendor: "EPEC",            date: "2026-10-02", delivered: false, note: "In production. Current ship 10/2 against a 10/30 ESD." },
  "4.4.11.2": { item: "Surge Arrestors PDV-100 (9)",       vendor: "Hubbell",         date: "2026-09-30", delivered: true,  note: "Delivered. Shipped 9/30 against a 10/15 ESD. UPS 1Z2268070312535378." },
  "4.4.12.2": { item: "30A AC Disconnect + 250V fuses",    vendor: "ABB / Fuseco",    date: "2026-10-15", delivered: true,  note: "Both delivered. Disconnect ESD 10/15 with no ship date; fuses shipped 7/11." },
};

// PO lines that the sheet marks Delivered, so the actual date goes on record.
// Order matters: the fuse line reads "250V Fuses for the AC Disconnect", so it
// matches the disconnect rule too. Most specific first.
const LINE_ACTUALS = [
  { match: /GOAB/i,                        date: "2026-09-18" },
  { match: /Surge Arrestors/i,             date: "2026-09-30" },
  { match: /Fuses/i,                       date: "2026-07-11" },
  { match: /AC Disconnect|Safety Switch/i, date: "2026-10-15" },
];

const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: tasks, error } = await sb
  .from("schedule_tasks")
  .select("wbs_code, task_name, start_date, end_date, duration_days, is_milestone, status, pct_complete, date_constraint_type, date_constraint_date")
  .eq("project_id", PROJECT_ID)
  .in("wbs_code", Object.keys(SHIP));
if (error) throw new Error(error.message);

const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
console.log("GridPower Solutions ship schedule, job 134594 - Sweet Spring Solar\n");
console.log(pad("WBS", 11) + pad("Item", 34) + pad("was", 24) + pad("becomes", 16) + "status");

const taskPatches = [];
for (const [wbs, s] of Object.entries(SHIP)) {
  const t = tasks.find((x) => x.wbs_code === wbs);
  if (!t) {
    console.log(`${pad(wbs, 11)}MISSING from the schedule`);
    continue;
  }
  const was = `${t.start_date ?? "-"} -> ${t.end_date ?? "-"}`;
  const patch = {
    start_date: s.date,
    end_date: s.date,
    duration_days: 0,
    is_milestone: true,
    // The SNET anchors came from a PO header date that covered several items at
    // once. The per-item ship date replaces them, so the stale floor comes off.
    date_constraint_type: null,
    date_constraint_date: null,
  };
  if (s.delivered) {
    patch.status = "Complete";
    patch.pct_complete = 100;
  }
  taskPatches.push({ wbs, patch, label: s.item });
  console.log(
    pad(wbs, 11) + pad(s.item, 34) + pad(was, 24) + pad(s.date, 16) +
      (s.delivered ? "DELIVERED" : "in production") +
      (t.date_constraint_type ? `  (clearing ${t.date_constraint_type} ${t.date_constraint_date})` : ""),
  );
}

const { data: pos } = await sb
  .from("procurement_orders")
  .select("id, po_number, vendor_name")
  .eq("project_id", PROJECT_ID);
const gpIds = new Set(pos.filter((p) => /Grid Power/i.test(p.vendor_name ?? "")).map((p) => p.id));
const { data: lines } = await sb
  .from("procurement_order_lines")
  .select("id, procurement_order_id, line_no, description, actual_delivery_date");

const linePatches = [];
for (const l of lines) {
  if (!gpIds.has(l.procurement_order_id)) continue;
  const hit = LINE_ACTUALS.find((a) => a.match.test(l.description ?? ""));
  if (!hit || l.actual_delivery_date === hit.date) continue;
  linePatches.push({ id: l.id, date: hit.date, description: l.description });
}
console.log(`\nPO lines gaining an actual delivery date (${linePatches.length}):`);
for (const p of linePatches) console.log(`  ${pad(p.date, 13)}${String(p.description).slice(0, 60)}`);

console.log(`\nNot touched: 4.4.6.2 Power Factors - different vendor, not on this sheet, and the item gating electrical start.`);

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to write ${taskPatches.length} tasks and ${linePatches.length} PO lines.`);
  process.exit(0);
}

let tw = 0;
for (const p of taskPatches) {
  const { error: e } = await sb
    .from("schedule_tasks")
    .update(p.patch)
    .eq("project_id", PROJECT_ID)
    .eq("wbs_code", p.wbs);
  if (e) { console.error(`  ${p.wbs}: ${e.message}`); continue; }
  tw++;
}
let lw = 0;
for (const p of linePatches) {
  const { error: e } = await sb
    .from("procurement_order_lines")
    .update({ actual_delivery_date: p.date })
    .eq("id", p.id);
  if (e) { console.error(`  line ${p.id}: ${e.message}`); continue; }
  lw++;
}
console.log(`\nWrote ${tw} delivery tasks and ${lw} PO lines.`);
