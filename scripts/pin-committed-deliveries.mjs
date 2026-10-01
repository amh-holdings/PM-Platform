// Pin committed delivery dates as date constraints rather than start dates.
//
// The problem this fixes: a delivery date written into start_date does not
// survive. Two things erase it.
//
//   1. The schedule page syncs the projection back into start_date/end_date, so
//      the stored date becomes whatever the engine last computed. The Tavrida
//      recloser was written at its vendor ESD of 10/18 and came back 10/29.
//
//   2. For a task with logic, the projection follows its predecessors in both
//      directions. The pile deliveries were written at 10/23 and the engine
//      pulled them to 10/15 and 10/16, because their imported lead times say
//      the material could be ready sooner.
//
// Neither is a bug. start_date is an output of the forecast, not an input. The
// input for "this is the date the material arrives" is a date constraint, which
// nothing overwrites.
//
// MSO (must start on) rather than SNET (start no earlier than), because these
// are dates, not windows. A vendor saying 10/18 is not saying "any time after
// the 18th". MSO also makes the engine report a violation when the logic and
// the committed date disagree - the recloser's imported lead time runs to
// 10/28 against a vendor ESD of 10/18, and that disagreement is worth seeing
// rather than silently resolving in favour of the import.
//
// Delivered material is not pinned. It has an actual date and status Complete,
// which is stronger than any constraint.
//
// Usage:
//   node scripts/pin-committed-deliveries.mjs           # dry run
//   node scripts/pin-committed-deliveries.mjs --apply

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
const APPLY = process.argv.includes("--apply");

// Only dates with a source behind them. Anything computed from an imported lead
// time is deliberately absent - pinning a guess makes it look like a fact.
const COMMITTED = [
  { wbs: "4.3.1.2",  date: "2026-10-23", item: "Racking piles (Elevated Steel)",  source: "Phil, 10/1 - same window as CAB piles. PO-023 header says 10/29" },
  { wbs: "4.4.1.2",  date: "2026-10-23", item: "CAB piles",                       source: "Phil, 10/1 - same window as racking piles. No PO on record" },
  { wbs: "4.4.4.2",  date: "2026-10-18", item: "27kV Recloser (Tavrida)",         source: "GridPower ship schedule, original ESD" },
  { wbs: "4.4.8.2",  date: "2026-10-25", item: "Primary Metering CT/PT (EHV)",    source: "GridPower ship schedule, original ESD" },
  { wbs: "4.4.9.2",  date: "2026-10-21", item: "600A LVPB 1.1 and 1.2 (ABB)",     source: "GridPower ship schedule, original ESD" },
  { wbs: "4.4.10.2", date: "2026-10-02", item: "Mini Power Center (EPEC)",        source: "GridPower ship schedule, current ship date" },
  { wbs: "4.4.6.2",  date: "2026-10-30", item: "Power Factors",                   source: "Phil, 10/1 - verbal, last week of October. PO P-016 says 11/03" },
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
  .select("wbs_code, task_name, start_date, status, predecessors, date_constraint_type, date_constraint_date")
  .eq("project_id", PROJECT_ID)
  .in("wbs_code", COMMITTED.map((c) => c.wbs));
if (error) throw new Error(error.message);

const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
console.log(pad("WBS", 11) + pad("Item", 34) + pad("pin", 13) + pad("stored", 13) + "note");
const todo = [];
for (const c of COMMITTED) {
  const t = tasks.find((x) => x.wbs_code === c.wbs);
  if (!t) { console.log(`${pad(c.wbs, 11)}MISSING`); continue; }
  if (t.status === "Complete") {
    console.log(`${pad(c.wbs, 11)}${pad(c.item, 34)}${pad("-", 13)}${pad(t.start_date, 13)}already delivered, not pinned`);
    continue;
  }
  const drift = t.start_date !== c.date ? `stored drifted from the committed date` : "";
  console.log(`${pad(c.wbs, 11)}${pad(c.item, 34)}${pad(c.date, 13)}${pad(t.start_date, 13)}${drift}`);
  todo.push(c);
}

console.log(`\nSources:`);
for (const c of todo) console.log(`  ${pad(c.wbs, 11)}${c.source}`);

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to pin ${todo.length} dates as MSO constraints.`);
  process.exit(0);
}

let wrote = 0;
for (const c of todo) {
  const { error: e } = await sb
    .from("schedule_tasks")
    .update({
      date_constraint_type: "MSO",
      date_constraint_date: c.date,
      start_date: c.date,
      end_date: c.date,
      duration_days: 0,
      is_milestone: true,
    })
    .eq("project_id", PROJECT_ID)
    .eq("wbs_code", c.wbs);
  if (e) { console.error(`  ${c.wbs}: ${e.message}`); continue; }
  wrote++;
}
console.log(`\nPinned ${wrote} committed delivery dates.`);
