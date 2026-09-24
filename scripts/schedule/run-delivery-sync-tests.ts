/**
 * Completing a delivery on the schedule, and what it does to the purchase
 * order behind it.
 *
 * Zarina, after marking procurement rows complete: "Once I change the
 * procurement items delivered, does it update the AFP billing suggestion?" It
 * did not, because a procurement SOV line is valued from the PO's milestones
 * and the "on delivery" one fires on procurement_orders.actual_delivery_date.
 * These are the rules that close that gap without letting the schedule quietly
 * move money that is already on an issued AFP.
 */

import {
  describeDeliverySync,
  deliveryDateForTask,
  planDeliverySync,
} from "../../src/lib/schedule-po-delivery";

let passed = 0;
const failures: string[] = [];

function same(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name} - got ${a}, want ${b}`);
    console.log(`  FAIL  ${name} - got ${a}, want ${b}`);
  }
}

function check(name: string, cond: boolean, detail = "") {
  same(name + (detail ? ` (${detail})` : ""), cond, true);
}

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

const TODAY = "2026-09-24";

section("What date goes on the PO");

same(
  "a row closed out late takes its own finish - the schedule is the evidence",
  deliveryDateForTask({ wbs_code: "1", end_date: "2026-09-18" }, TODAY),
  "2026-09-18",
);

same(
  "a finish still ahead means it arrived early, so today",
  deliveryDateForTask({ wbs_code: "1", end_date: "2026-11-13" }, TODAY),
  TODAY,
);

same(
  "a finish of today is today either way",
  deliveryDateForTask({ wbs_code: "1", end_date: TODAY }, TODAY),
  TODAY,
);

same(
  "no finish at all falls back to today rather than guessing",
  deliveryDateForTask({ wbs_code: "1", end_date: null }, TODAY),
  TODAY,
);

section("Which POs get stamped");

const groundworks = {
  id: "po-1",
  po_number: "PO-019",
  vendor_name: "GroundWorks",
  linked_delivery_task_wbs_code: "4.4.5.2",
  actual_delivery_date: null as string | null,
};

same(
  "a completed delivery stamps the PO linked to it",
  planDeliverySync({
    completed: [{ wbs_code: "4.4.5.2", task_name: "Delivery", end_date: "2026-09-30" }],
    pos: [groundworks],
    todayIso: TODAY,
  }),
  {
    updates: [{ poId: "po-1", label: "PO-019", date: TODAY }],
    alreadyRecorded: [],
    unlinked: [],
  },
);

same(
  "a PO that already has a delivery date is NEVER overwritten - it may be on an issued AFP",
  planDeliverySync({
    completed: [{ wbs_code: "4.4.5.2", task_name: "Delivery", end_date: "2026-09-30" }],
    pos: [{ ...groundworks, actual_delivery_date: "2026-08-01" }],
    todayIso: TODAY,
  }),
  { updates: [], alreadyRecorded: ["PO-019"], unlinked: [] },
);

same(
  "a completed row with no PO pointing at it is reported, not swallowed",
  planDeliverySync({
    completed: [{ wbs_code: "4.4.3.2", task_name: "Delivery", end_date: "2026-11-13" }],
    pos: [groundworks],
    todayIso: TODAY,
  }),
  { updates: [], alreadyRecorded: [], unlinked: ["Delivery"] },
);

same(
  "the WBS stands in when the task has no name",
  planDeliverySync({
    completed: [{ wbs_code: "4.4.3.2", task_name: "  ", end_date: null }],
    pos: [],
    todayIso: TODAY,
  }),
  { updates: [], alreadyRecorded: [], unlinked: ["4.4.3.2"] },
);

same(
  "two POs on one delivery task both get stamped",
  planDeliverySync({
    completed: [{ wbs_code: "4.4.5.2", task_name: "Delivery", end_date: "2026-09-18" }],
    pos: [groundworks, { ...groundworks, id: "po-2", po_number: "PO-020" }],
    todayIso: TODAY,
  }),
  {
    updates: [
      { poId: "po-1", label: "PO-019", date: "2026-09-18" },
      { poId: "po-2", label: "PO-020", date: "2026-09-18" },
    ],
    alreadyRecorded: [],
    unlinked: [],
  },
);

same(
  "a PO is only stamped once even if two completed rows point at it",
  planDeliverySync({
    completed: [
      { wbs_code: "4.4.5.2", task_name: "Delivery", end_date: "2026-09-18" },
      { wbs_code: "4.4.5.2", task_name: "Delivery", end_date: "2026-09-20" },
    ],
    pos: [groundworks],
    todayIso: TODAY,
  }),
  {
    updates: [{ poId: "po-1", label: "PO-019", date: "2026-09-18" }],
    alreadyRecorded: [],
    unlinked: [],
  },
);

same(
  "an unlinked PO is not matched to anything",
  planDeliverySync({
    completed: [{ wbs_code: "4.4.5.2", task_name: "Delivery", end_date: null }],
    pos: [{ ...groundworks, linked_delivery_task_wbs_code: null }],
    todayIso: TODAY,
  }),
  { updates: [], alreadyRecorded: [], unlinked: ["Delivery"] },
);

same(
  "a PO with no number falls back to the vendor",
  planDeliverySync({
    completed: [{ wbs_code: "4.4.5.2", task_name: "Delivery", end_date: "2026-09-18" }],
    pos: [{ ...groundworks, po_number: null }],
    todayIso: TODAY,
  }),
  {
    updates: [{ poId: "po-1", label: "GroundWorks", date: "2026-09-18" }],
    alreadyRecorded: [],
    unlinked: [],
  },
);

same("nothing completed is nothing to do", planDeliverySync({ completed: [], pos: [groundworks], todayIso: TODAY }), {
  updates: [],
  alreadyRecorded: [],
  unlinked: [],
});

section("What the save message says");

check(
  "a stamped PO says the AFP will pick it up",
  (describeDeliverySync({
    updates: [{ poId: "po-1", label: "PO-019", date: "2026-09-18" }],
    alreadyRecorded: [],
    unlinked: [],
  }) ?? "").includes("PO-019 (2026-09-18)"),
);

check(
  "an unlinked row says where to link it, so the silence is explained",
  /no PO linked/i.test(
    describeDeliverySync({ updates: [], alreadyRecorded: [], unlinked: ["Delivery"] }) ?? "",
  ),
);

check(
  "a date left alone says so",
  /left as it was/i.test(
    describeDeliverySync({ updates: [], alreadyRecorded: ["PO-019"], unlinked: [] }) ?? "",
  ),
);

same(
  "nothing to report says nothing rather than padding the message",
  describeDeliverySync({ updates: [], alreadyRecorded: [], unlinked: [] }),
  null,
);

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
