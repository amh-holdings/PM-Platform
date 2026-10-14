/**
 * Judging a sub's bill against the schedule as it stood on a past date.
 *
 * Pyramid's 9/1-9/25 bill read $56k "unsupported" on 2.04 (basins) and 3.01
 * (access road) when the field record covered both: the mapping pointed at a
 * split summary row and a commodity nobody logged, and the 9/21 snapshot
 * predated the updates that recorded the road and riser as finished.
 */

import {
  expandToLeaves,
  tasksAsOf,
  type AsOfTask,
} from "../../src/lib/sub-billing-asof";
import { staleSources, verifyLine, type BillLine, type Evidence, type SovLine } from "../../src/lib/sub-billing";

let passed = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name} - got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    console.log(`  FAIL  ${name}`);
  }
}

const ASOF = "2026-09-25";

console.log("\nThe schedule as of a past date\n");

const live: AsOfTask[] = [
  { wbs_code: "5.1.1.9", task_name: "Rough Road", status: "Complete", pct_complete: 100, start_date: "2026-08-25", end_date: "2026-08-25" },
  { wbs_code: "5.1.1.7.2", task_name: "Riser install", status: "Complete", pct_complete: 100, start_date: "2026-09-18", end_date: "2026-09-18" },
  { wbs_code: "5.1.1.6.3", task_name: "Lined inlets install", status: "Complete", pct_complete: 100, start_date: "2026-10-07", end_date: "2026-10-09" },
  { wbs_code: "5.1.1.7.5", task_name: "Embankment", status: "Complete", pct_complete: 100, start_date: "2026-09-16", end_date: "2026-09-28" },
  { wbs_code: "5.1.1.8.1", task_name: "Culvert", status: "In Progress", pct_complete: 75, start_date: "2026-08-24", end_date: "2026-10-16" },
  { wbs_code: "5.1.3.7", task_name: "Convert basins", status: "Not Started", pct_complete: null, start_date: "2026-11-16", end_date: "2026-11-23" },
  { wbs_code: "9.9", task_name: "Unreported", status: "In Progress", pct_complete: 50, start_date: "2026-09-15", end_date: "2026-10-05" },
];
const snapshot: AsOfTask[] = [
  { wbs_code: "5.1.1.9", status: "In Progress", pct_complete: 10 },
  { wbs_code: "5.1.1.7.2", status: "Not Started", pct_complete: null },
  { wbs_code: "5.1.1.7.5", status: "In Progress", pct_complete: 5 },
];
const pins = [
  { wbsCode: "5.1.1.7.5", reportDate: "2026-09-24", pct: 70 },
  { wbsCode: "5.1.1.7.5", reportDate: "2026-09-27", pct: 100 }, // after the cut-off
  { wbsCode: "5.1.1.8.1", reportDate: "2026-09-10", pct: 40 },
  { wbsCode: "5.1.1.8.1", reportDate: "2026-09-10", pct: 45 }, // same day, higher wins
];
const { tasks, basis } = tasksAsOf({ live, pins, snapshot, asOf: ASOF });
const at = (w: string) => tasks.find((t) => t.wbs_code === w)!;

eq("finished before the cut-off beats a stale snapshot (Rough Road)", [at("5.1.1.9").pct_complete, basis.get("5.1.1.9")], [100, "finished"]);
eq("riser finished 9/18 reads done though the 9/21 snapshot said Not Started", at("5.1.1.7.2").pct_complete, 100);
eq("finished AFTER the cut-off is not counted as done", at("5.1.1.6.3").pct_complete === 100, false);
eq("finished after the cut-off with nothing earlier reads 0", [at("5.1.1.6.3").pct_complete, basis.get("5.1.1.6.3")], [0, "not_started"]);
eq("a dated report inside the window beats the snapshot", [at("5.1.1.7.5").pct_complete, basis.get("5.1.1.7.5")], [70, "report"]);
eq("a report after the cut-off is ignored", at("5.1.1.7.5").pct_complete, 70);
eq("two pins on one day take the higher", at("5.1.1.8.1").pct_complete, 45);
eq("not started until November reads 0", at("5.1.3.7").pct_complete, 0);
eq("open across the cut-off with no report is prorated", [at("9.9").pct_complete, basis.get("9.9")], [50, "prorated"]);
eq("live dates survive (weights stay correct)", at("5.1.1.7.5").end_date, "2026-09-28");

console.log("\nA linked summary row means the work under it\n");

const codes = ["5.1.1.6", "5.1.1.6.1", "5.1.1.6.2", "5.1.1.7", "5.1.1.7.1", "5.1.3.7", "5.1.3.3", "5.1.3.3.1"];
eq("a parent expands to its leaves", expandToLeaves(["5.1.1.6"], codes), ["5.1.1.6.1", "5.1.1.6.2"]);
eq("a leaf stays itself", expandToLeaves(["5.1.3.7"], codes), ["5.1.3.7"]);
eq("5.1.1.1 does not swallow 5.1.1.10", expandToLeaves(["5.1.1.1"], ["5.1.1.1", "5.1.1.10", "5.1.1.10.1"]), ["5.1.1.1"]);
eq("no duplicates when parent and child are both linked", expandToLeaves(["5.1.1.6", "5.1.1.6.1"], codes), ["5.1.1.6.1", "5.1.1.6.2"]);
eq("multi-level parent reaches the bottom", expandToLeaves(["5.1.3"], codes), ["5.1.3.7", "5.1.3.3.1"]);

// The Basin 1 parent that read "Complete at 7%" after it was split.
const ev: Evidence = {
  tasks: new Map([
    ["5.1.1.6", { wbs_code: "5.1.1.6", task_name: "Construct Basin 1 ESC", status: "Complete", pct_complete: 7, duration_days: 30 }],
    ["5.1.1.6.1", { wbs_code: "5.1.1.6.1", task_name: "Culvert", status: "Complete", pct_complete: 100, duration_days: 5 }],
    ["5.1.1.6.2", { wbs_code: "5.1.1.6.2", task_name: "Riser", status: "Complete", pct_complete: 100, duration_days: 5 }],
  ]),
  commodities: new Map([
    ["road", { label: "Road Install", installed: 0, total: 250, uom: "ft" }],
  ]),
  todayIso: ASOF,
  lastUpdate: new Map([["task:5.1.1.6.1", "2026-09-21"]]),
};
const sov = (o: Partial<SovLine>): SovLine =>
  ({ item_number: "x", description: "x", scheduled_value: 1000, verification_method: "schedule", linked_task_wbs_codes: [], linked_commodity_ids: [], ...o }) as SovLine;
const bill = (total: number, thisPeriod: number): BillLine => ({
  item_number: "x", description: "x", scheduled_value: 1000, from_previous: total - thisPeriod, this_period: thisPeriod,
  materials_stored: 0, total_completed: total, pct_billed: total / 1000, balance_to_finish: 1000 - total, retainage_amount: 0,
});

eq("a line linked to the split parent reads its subtasks, not the parent's 7%", verifyLine(sov({ linked_task_wbs_codes: ["5.1.1.6"] }), bill(1000, 500), ev).verifiedPct, 1);

console.log("\nA source nobody updates is called out\n");

const road = sov({ verification_method: "commodity", linked_commodity_ids: ["road"] });
eq("a commodity never logged against is named", staleSources(road, ev), "Road Install has never been updated");
eq("the note rides on the line's detail when it is billed this period", verifyLine(road, bill(1000, 500), ev).detail.includes("CHECK SOURCE: Road Install has never been updated"), true);
eq("no note when nothing is billed this period", verifyLine(road, bill(500, 0), ev).detail.includes("CHECK SOURCE"), false);
eq("finished tasks are never stale", staleSources(sov({ linked_task_wbs_codes: ["5.1.1.6"] }), ev), null);
eq("no lastUpdate loaded means no notes at all", staleSources(road, { ...ev, lastUpdate: undefined }), null);

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
