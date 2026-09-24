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
  describeAfpFollowUp,
  describeDeliveryLinkCount,
  describeDeliverySync,
  deliveryDateForTask,
  deliveryLinkLabel,
  deliveryLinkNote,
  planDeliverySync,
  splitDeliveryLinkChoices,
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

section("Delivered is not billed: the AFP nudge");

const DELIVERED = [
  { poId: "po-1", label: "PO-017" },
  { poId: "po-2", label: "PO-019" },
];

check(
  "a delivered PO with nothing staged is named",
  (describeAfpFollowUp({
    delivered: [DELIVERED[0]],
    stagedPoIds: [],
    periodMonth: "2026-09-01",
  }) ?? "").includes("PO-017"),
);

check(
  "and the period is named with it",
  (describeAfpFollowUp({
    delivered: [DELIVERED[0]],
    stagedPoIds: [],
    periodMonth: "2026-09-01",
  }) ?? "").includes("2026-09"),
);

same(
  "a PO that already has an amount staged is left alone - the nudge would be noise",
  describeAfpFollowUp({
    delivered: [DELIVERED[0]],
    stagedPoIds: ["po-1"],
    periodMonth: "2026-09-01",
  }),
  null,
);

check(
  "with two waiting, both are named and the wording is plural",
  (() => {
    const line = describeAfpFollowUp({
      delivered: DELIVERED,
      stagedPoIds: [],
      periodMonth: "2026-09-01",
    }) ?? "";
    return line.includes("PO-017") && line.includes("PO-019") && line.includes("are delivered");
  })(),
);

check(
  "one staged and one not names only the one that needs doing",
  (() => {
    const line = describeAfpFollowUp({
      delivered: DELIVERED,
      stagedPoIds: ["po-1"],
      periodMonth: "2026-09-01",
    }) ?? "";
    return line.includes("PO-019") && !line.includes("PO-017");
  })(),
);

same(
  "nothing delivered is nothing to nudge about",
  describeAfpFollowUp({ delivered: [], stagedPoIds: [], periodMonth: "2026-09-01" }),
  null,
);


// ---------------------------------------------------------------------------
// What the picker offers. Zarina: "I dont see all POs here."
// ---------------------------------------------------------------------------

const POS = [
  { id: "a", po_number: "P-001", vendor_name: "Maddox", status: "active" },
  { id: "b", po_number: "P-002", vendor_name: "FTC Solar", status: "cancelled" },
  {
    id: "c",
    po_number: "PO-017",
    vendor_name: "GroundWork",
    status: "delivered",
    linked_delivery_task_wbs_code: "4.4.5.2",
    actual_delivery_date: "2026-09-20",
  },
  {
    id: "d",
    po_number: "PO-019",
    vendor_name: "Grid Power",
    status: "active",
    linked_delivery_task_wbs_code: "4.4.9.2",
  },
  { id: "e", po_number: null, vendor_name: "CAB Solar", status: "on hold" },
];

check(
  "a cancelled PO is offered, not dropped",
  splitDeliveryLinkChoices({ pos: POS, wbsCode: "4.4.5.2" }).available.some(
    (o) => o.id === "b",
  ),
);

check(
  "the cancelled one carries its state so the picker can say it",
  splitDeliveryLinkChoices({ pos: POS, wbsCode: "4.4.5.2" }).available.find(
    (o) => o.id === "b",
  )?.note === "cancelled",
);

same(
  "active, complete and delivered get no annotation",
  [
    deliveryLinkNote("active"),
    deliveryLinkNote("complete"),
    deliveryLinkNote("delivered"),
    deliveryLinkNote(null),
    deliveryLinkNote("  "),
  ],
  [null, null, null, null, null],
);

same(
  "an unrecognised state is passed through rather than swallowed",
  deliveryLinkNote("On Hold"),
  "on hold",
);

same(
  "every PO on the project is accounted for",
  splitDeliveryLinkChoices({ pos: POS, wbsCode: "4.4.5.2" }).total,
  POS.length,
);

check(
  "the PO already on this task sits in linked, not the dropdown",
  (() => {
    const s = splitDeliveryLinkChoices({ pos: POS, wbsCode: "4.4.5.2" });
    return (
      s.linked.length === 1 &&
      s.linked[0].id === "c" &&
      !s.available.some((o) => o.id === "c")
    );
  })(),
);

check(
  "a PO on a different task stays offered, carrying the code it points at",
  (() => {
    const o = splitDeliveryLinkChoices({ pos: POS, wbsCode: "4.4.5.2" }).available.find(
      (x) => x.id === "d",
    );
    return o?.linkedWbs === "4.4.9.2";
  })(),
);

same(
  "a PO with no number falls back to the vendor",
  deliveryLinkLabel({ id: "e", po_number: null, vendor_name: "CAB Solar" }),
  "CAB Solar",
);

same(
  "a PO with neither still gets a label",
  deliveryLinkLabel({ id: "z" }),
  "PO",
);

check(
  "the count line names the number so it can be checked against Procurement",
  describeDeliveryLinkCount(13).startsWith("13 purchase orders on this project"),
);

check("one PO reads as one", describeDeliveryLinkCount(1).startsWith("1 purchase order on"));

check("no POs says so plainly", describeDeliveryLinkCount(0).includes("No purchase orders"));

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
