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
import { buildSubLetter, groupGaps } from "../../src/lib/sub-billing-letter";
import { billVerdict, recommendedApproval, staleSources, verifyLine, type BillLine, type Evidence, type SovLine } from "../../src/lib/sub-billing";

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

console.log("\nWhat Approve pays when nobody types a figure (Pyramid AFP 3)\n");

// SV, from previous, this period, verified % at 9/25 - straight off the bill and the engine.
const afp3: [string, number, number, number, number][] = [
  ["1.03", 20192.01, 10096.0, 5048.0, 1],
  ["2.02", 60576.03, 18172.8, 12115.21, 0.473],
  ["2.04", 40384.02, 24230.41, 16153.61, 0.592],
  ["3.01", 80768.04, 40384.02, 40384.02, 1],
  ["5.01", 20192.01, 4038.4, 2019.2, 0.741],
  ["5.02", 13461.34, 10096.0, 3365.33, 1],
];
let gross = 0;
const byItem: Record<string, number> = {};
for (const [item, sv, prev, cur, vp] of afp3) {
  // Flag the way verifyLine does, from the verified percent.
  const verifiedAmount = Math.round(vp * sv * 100) / 100;
  const variance = prev + cur - verifiedAmount;
  const overPct = (prev + cur) / sv - vp > 0.05;
  const flag = overPct && variance > 2500 ? "flag" : overPct || variance > 2500 ? "review" : "ok";
  const r = recommendedApproval({ this_period: cur, from_previous: prev, verified_amount: verifiedAmount, flag_level: flag });
  byItem[item] = r.amount;
  gross += r.amount;
}
eq("2.04 billed to 100% against 59.2% is held in full", byItem["2.04"], 0);
eq("2.02 at 50% vs 47.3% is within tolerance and paid as billed", byItem["2.02"], 12115.21);
eq("1.03 is paid as billed, not the larger amount the record supports", byItem["1.03"], 5048);
eq("3.01 road finished 8/25 is paid", byItem["3.01"], 40384.02);
eq("AFP 3 approves $62,931.76 gross", Math.round(gross * 100) / 100, 62931.76);
eq("a line with no evidence is paid as billed but marked", recommendedApproval({ this_period: 500, from_previous: 0, verified_amount: null, flag_level: "unverifiable" }), { amount: 500, held: 0, basis: "no_evidence" });
eq("a credit line passes through untouched", recommendedApproval({ this_period: -200, from_previous: 1000, verified_amount: 0, flag_level: "flag" }).amount, -200);
eq("partly supported: pays up to the record", recommendedApproval({ this_period: 1000, from_previous: 2000, verified_amount: 2600, flag_level: "flag" }), { amount: 600, held: 400, basis: "capped" });

console.log("\nThe verdict\n");

const money = (v: number) => `$${v.toFixed(2)}`;
const vline = (o: Partial<Parameters<typeof billVerdict>[0]["lines"][number]>) => ({
  item_number: "2.04", description: "Drainage", billed: 1000, approve: 1000, pct_billed: 1, verified_pct: 1, flag_level: "ok", detail: "", ...o,
});
const pass = { status: "pass", severity: "error", label: "Adds up", message: null };
eq("all supported -> approve", billVerdict({ checks: [pass], lines: [vline({})], approveGross: 1000, approveNet: 950, money }).kind, "approve");
const held = billVerdict({ checks: [pass], lines: [vline({ approve: 0, pct_billed: 1, verified_pct: 0.592, flag_level: "flag" })], approveGross: 0, approveNet: 0, money });
eq("a line ahead of the record -> hold", held.kind, "hold");
eq("the hold names the line and both percents", held.reasons[0], "2.04 Drainage: billed to 100.0%, the reports and schedule support 59.2%. Hold $1000.00.");
eq("arithmetic failure -> send back, even with lines held", billVerdict({ checks: [{ status: "fail", severity: "error", label: "Total foots", message: "off by $10" }], lines: [vline({ approve: 0, flag_level: "flag" })], approveGross: 0, approveNet: 0, money }).kind, "send_back");
eq("a warning does not block approval", billVerdict({ checks: [{ status: "warn", severity: "warning", label: "COI pending", message: null }], lines: [vline({})], approveGross: 1000, approveNet: 950, money }).kind, "approve");
eq("an unmeasured line -> CM sign-off", billVerdict({ checks: [pass], lines: [vline({ verified_pct: null, flag_level: "unverifiable" })], approveGross: 1000, approveNet: 950, money }).kind, "needs_cm");
eq("a stale source is named on the hold", billVerdict({ checks: [pass], lines: [vline({ approve: 0, flag_level: "flag", detail: "Road: 0 of 250 ft. CHECK SOURCE: Road Install has never been updated" })], approveGross: 0, approveNet: 0, money }).reasons[0].includes("check the evidence source - Road Install has never been updated"), true);

console.log("\nThe review, worded as the email to the sub (Pyramid AFP 3)\n");

const usd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD" });
const areas = groupGaps([
  { area: "Basin 1 ESC", task: "Matting and seeding", pctDone: 0, pctOfLine: 0.1125 },
  { area: "Basin 1 ESC", task: "Lined inlets install", pctDone: 0, pctOfLine: 0.0375 },
  { area: "Basin 1 ESC", task: "Emergency Spillway", pctDone: 0, pctOfLine: 0.0125 },
  { area: "Basin 2 ESC", task: "Matting and seeding", pctDone: 0, pctOfLine: 0.1 },
  { area: "Basin 2 ESC", task: "Cut/Fill", pctDone: 0.4, pctOfLine: 0.015 },
  { area: "Basin 2 ESC", task: "Embankment", pctDone: 0.95, pctOfLine: 0.005625 },
  { area: "", task: "Convert Sediment Basins to Stormwater Ponds", pctDone: 0, pctOfLine: 0.075 },
]);
eq("gaps group by area, biggest first", areas.map((a) => a.area), ["Basin 1 ESC", "Basin 2 ESC", "Convert Sediment Basins to Stormwater Ponds"]);
eq("partly done tasks say how far along", areas[1].items, "Matting and seeding, Cut/Fill (40% complete), Embankment (95% complete)");
eq("a task with no area reads as not started", areas[2].items, "Not started");
const letter = buildSubLetter({
  kind: "hold", projectName: "Sweet Springs", appNumber: 3, periodStart: "2026-09-01", periodEnd: "2026-09-25",
  todayIso: "2026-10-15", retainagePct: 5, approveGross: 62931.76, retainage: 3146.59, net: 59785.17,
  holds: [{ item: "2.04", description: "Drainage structures and stormwater management", held: 16153.61, scheduledValue: 40384.02,
    billedToPct: 1, builtPct: 0.592, prevAmount: 24230.41, earned: 0, areas, todayPct: 0.9, nextBillable: 12115.21 }],
  sendBack: [], asks: ["The conditional lien waiver for $59,785.17"], money: usd,
});
eq("subject names the project, period and held line", letter.subject, "Sweet Springs - Pay Application #3 (9/1 - 9/25) Approved with Hold on Line 2.04");
eq("approved sentence", letter.approved, "Approved: $62,931.76 gross, less 5% retainage ($3,146.59), for a payment of $59,785.17.");
eq("held sentence", letter.heldLine, "Held: $16,153.61 on Line 2.04, Drainage structures and stormwater management.");
eq("the why, as in the email", letter.holds[0].paragraph, "The application bills Line 2.04 to 100% complete. Our daily reports show it was 59.2% complete at the 9/25 period end. Prior applications already billed 60% ($24,230.41), so no additional amount is earned on this line for this period.");
eq("next step tells them what the next bill can carry", letter.holds[0].next, "Please carry the Line 2.04 balance forward on your next application. Based on our reports through 10/15/2026, about $12,115.21 of it is now supported and can be billed on Pay Application #4. The remainder will follow as the open work is completed.");
eq("the copied email carries the breakdown", letter.text.includes("- Basin 1 ESC (16.25% of the line): Matting and seeding, Lined inlets install, Emergency Spillway"), true);
console.log("\n----- copied email -----\n" + letter.text + "\n------------------------");

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
