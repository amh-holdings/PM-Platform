// Procurement importer - known-answer test harness.
//
// Pure functions only, no database. The cases that matter most are the ones
// where a row must NOT become what it looks like: a repeated PO number that is
// a second payment rather than a second purchase order, a paid date with no
// money behind it, a delivery-task link pointing at a task this project does
// not have, and a blank cell being read as an instruction to erase.
//
// Every one of those is silent if it goes wrong. A PO imported without its
// cost is a commitment the forecast never sees, and a payment recorded as paid
// for zero dollars is worse than one not recorded at all.
//
// Run: npx tsx scripts/procurement/run-import-tests.ts

import {
  buildPoRows,
  diffProcurement,
  guessPoColumns,
  normalizeStatus,
  parsePct,
  parsePoGrid,
  parsePoMoney,
  planFromPoDiff,
  type DeliveryTask,
  type ExistingOrder,
  type PoColumnKey,
} from "@/lib/procurement-import";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

function hit(list: string[], needle: string): boolean {
  return list.some((s) => s.toLowerCase().includes(needle.toLowerCase()));
}

// --------------------------------- values ---------------------------------
section("Money, percentage and status parsing");

eq("plain number", parsePoMoney("412000"), 412000);
eq("currency with commas and padding", parsePoMoney(" $412,000.00 "), 412000);
eq("Excel zero renders as a lone dash", parsePoMoney(" $-   "), 0);
eq("parenthesised deduct is negative", parsePoMoney("(1,200.00)"), -1200);
eq("prose is null, not zero", parsePoMoney("TBD"), null);

eq("percent with a sign", parsePct("30%"), 30);
eq("bare percent", parsePct("30"), 30);
eq("spreadsheet fraction", parsePct("0.3"), 30);
eq("a bare 1 is one percent, not the whole PO", parsePct("1"), 1);
eq("100% survives", parsePct("100%"), 100);
eq("prose is null", parsePct("balance"), null);

eq("known status passes through", normalizeStatus("Complete"), "complete");
eq("open reads as active", normalizeStatus("Open"), "active");
eq("received reads as delivered", normalizeStatus("Received"), "delivered");
eq("voided reads as cancelled", normalizeStatus("Voided"), "cancelled");
eq("a vocabulary we do not know stays null", normalizeStatus("Awaiting Peter"), null);

// ------------------------------ column guessing ------------------------------
section("Column guessing");

const header = [
  "PO Number",
  "Vendor",
  "Description",
  "PO Total",
  "Ordered",
  "Expected Delivery",
  "Milestone",
  "%",
  "Paid Date",
];
const sampleRows = [
  ["PO-018", "FTC Solar", "Piles and racking", "412,000.00", "07/03/26", "10/29/26", "Deposit", "30", "07/12/26"],
  ["PO-018", "", "", "", "", "", "Release to ship", "60", ""],
];
const guessed = guessPoColumns(header, sampleRows);
eq("PO number from header", guessed[0], "po_number");
eq("vendor from header", guessed[1], "vendor_name");
eq("PO total from header", guessed[3], "total_value");
eq("ordered from header", guessed[4], "ordered_date");
eq("expected delivery from header", guessed[5], "expected_delivery_date");
eq("milestone from header", guessed[6], "milestone_name");
eq("percentage from header", guessed[7], "pct_of_total");
eq("paid date is the paid column, not the milestone due", guessed[8], "paid_at");

// A headerless export still has to find the PO number and the money.
const headerless = guessPoColumns(null, [
  ["PO-018", "FTC Solar", "412,000.00", "07/03/26"],
  ["PO-019", "Maddox", "96,100.00", "06/26/25"],
]);
eq("headerless: PO number from its shape", headerless[0], "po_number");
eq("headerless: vendor from its shape", headerless[1], "vendor_name");
eq("headerless: total from its shape", headerless[2], "total_value");
eq("headerless: a date column is not read as a PO number", headerless[3], "ordered_date");

// ------------------------------ one row per PO ------------------------------
section("One row per purchase order");

const flatMap: (PoColumnKey | null)[] = [
  "po_number",
  "vendor_name",
  "description",
  "total_value",
  "ordered_date",
  "expected_delivery_date",
];
const flatGrid = parsePoGrid(
  [
    "PO Number\tVendor\tDescription\tPO Total\tOrdered\tExpected Delivery",
    "PO-018\tFTC Solar\tPiles and racking\t 412,000.00 \t07/03/26\t10/29/26",
    "PO-019\tMaddox\t1500kVA transformer\t 96,100.00 \t06/26/25\t11/13/26",
    "Total\t\t\t 508,100.00 \t\t",
  ].join("\n"),
);
const flat = buildPoRows(flatGrid, flatMap);
eq("two purchase orders", flat.rows.length, 2);
eq("the totals row is skipped, not imported", hit(flat.notes, "total row"), true);
eq("no milestone columns means no milestones", flat.hasMilestones, false);
eq("money parsed", flat.rows[0].values.total_value, 412000);
eq("dates normalised to ISO", flat.rows[0].values.ordered_date, "2026-07-03");

const noPoNumber = buildPoRows(
  parsePoGrid(["PO Number\tVendor", "\tOrphan Supply Co"].join("\n")),
  ["po_number", "vendor_name"],
);
eq("a row with no PO number is rejected, not guessed at", noPoNumber.rejected.length, 1);
eq("and says why", hit([noPoNumber.rejected[0].reason], "PO number"), true);

// -------------------------- one row per milestone --------------------------
section("One row per payment milestone");

const msMap: (PoColumnKey | null)[] = [
  "po_number",
  "vendor_name",
  "description",
  "total_value",
  "milestone_name",
  "pct_of_total",
  "milestone_expected_date",
  "paid_at",
];
const msGrid = parsePoGrid(
  [
    "PO Number\tVendor\tDescription\tPO Total\tMilestone\t%\tMilestone Due\tPaid Date",
    "PO-018\tFTC Solar\tPiles and racking\t 412,000.00 \tDeposit\t30\t07/10/26\t07/12/26",
    "PO-018\t\t\t\tRelease to ship\t60\t10/01/26\t",
    "PO-018\t\t\t\tFinal\t10\t11/15/26\t",
    "PO-019\tMaddox\t1500kVA transformer\t 96,100.00 \tDeposit\t50\t07/01/25\t07/03/25",
  ].join("\n"),
);
const ms = buildPoRows(msGrid, msMap);
eq("four rows collapse to two purchase orders", ms.rows.length, 2);
eq("read as a payment schedule", ms.hasMilestones, true);
eq("the first PO carries three payments", ms.rows[0].milestones.length, 3);
eq("the second carries one", ms.rows[1].milestones.length, 1);
eq(
  "header fields come from the first row of the group",
  ms.rows[0].values.vendor_name,
  "FTC Solar",
);
eq("blank repeats do not erase the vendor", ms.rows[0].values.total_value, 412000);
eq("milestone order is sheet order", ms.rows[0].milestones[1].values.milestone_name, "Release to ship");
eq("paid date parsed on the milestone", ms.rows[0].milestones[0].values.paid_at, "2026-07-12");

// A milestone row that says nothing but the PO number is a spreadsheet
// artefact, not a payment.
const padded = buildPoRows(
  parsePoGrid(
    ["PO Number\tVendor\tMilestone", "PO-020\tAcme\tDeposit", "PO-020\t\t"].join("\n"),
  ),
  ["po_number", "vendor_name", "milestone_name"],
);
eq("an empty repeat row adds no payment", padded.rows[0].milestones.length, 1);

// A payment with no name cannot be matched on re-import.
const unnamed = buildPoRows(
  parsePoGrid(
    ["PO Number\tVendor\tMilestone\tMilestone Amount", "PO-021\tAcme\t\t1000"].join("\n"),
  ),
  ["po_number", "vendor_name", "milestone_name", "milestone_amount"],
);
eq("a payment with no name is rejected", unnamed.rejected.length, 1);
eq("and says why", hit([unnamed.rejected[0].reason], "milestone name"), true);

// The sheet disagreeing with itself about one PO.
const conflicted = buildPoRows(
  parsePoGrid(
    [
      "PO Number\tVendor\tMilestone",
      "PO-022\tFTC Solar\tDeposit",
      "PO-022\tFTC Solar Inc\tFinal",
    ].join("\n"),
  ),
  ["po_number", "vendor_name", "milestone_name"],
);
eq("a disagreement inside one PO is named", hit(conflicted.rows[0].issues, "further down"), true);
eq("and the first value is the one used", conflicted.rows[0].values.vendor_name, "FTC Solar");

const dupeNames = buildPoRows(
  parsePoGrid(
    [
      "PO Number\tVendor\tMilestone",
      "PO-023\tAcme\tDeposit",
      "PO-023\t\tdeposit",
    ].join("\n"),
  ),
  ["po_number", "vendor_name", "milestone_name"],
);
eq(
  "the same payment name twice on one PO is flagged",
  hit(dupeNames.rows[0].issues, "cannot tell them apart"),
  true,
);

// ------------------------------- the diff -------------------------------
section("Diff against what is already on the project");

const existing: ExistingOrder[] = [
  {
    id: "po-018",
    po_number: "PO-018",
    vendor_name: "FTC Solar",
    description: "Piles and racking",
    total_value: 412000,
    ordered_date: "2026-07-03",
    expected_delivery_date: "2026-10-29",
    actual_delivery_date: null,
    status: "active",
    payment_terms_summary: "30/60/10",
    notes: "Restart CO pending signature",
    linked_delivery_task_wbs_code: null,
    milestones: [
      {
        id: "m1",
        milestone_name: "Deposit",
        pct_of_total: 30,
        trigger_event: null,
        expected_date: "2026-07-10",
        amount: 123600,
        paid_at: "2026-07-12",
        paid_amount: 123600,
        sort_order: 1,
        notes: null,
      },
    ],
  },
];

const tasks: DeliveryTask[] = [
  { wbs_code: "4.3.1.2", end_date: "2026-10-29" },
  { wbs_code: "4.4.3.2", end_date: "2026-11-13" },
];

// A new PO with no vendor cannot be created: vendor_name is required.
const noVendor = diffProcurement(
  existing,
  buildPoRows(
    parsePoGrid(["PO Number\tPO Total", "PO-099\t50000"].join("\n")),
    ["po_number", "total_value"],
  ),
  ["po_number", "total_value"],
  tasks,
);
eq("a new PO with no vendor blocks", hit(noVendor.blocking, "no vendor"), true);

// A blank cell is silence, not an erase instruction.
const blanks = diffProcurement(
  existing,
  buildPoRows(
    parsePoGrid(["PO Number\tVendor\tPO Notes", "PO-018\tFTC Solar\t"].join("\n")),
    ["po_number", "vendor_name", "notes"],
  ),
  ["po_number", "vendor_name", "notes"],
  tasks,
);
eq("a blank note does not wipe the note already there", blanks.changes.length, 0);
eq("the PO reads as unchanged", blanks.unchangedCount, 1);

// A paid date with nothing behind it.
const paidNothing = diffProcurement(
  existing,
  buildPoRows(
    parsePoGrid(
      ["PO Number\tVendor\tMilestone\tPaid Date", "PO-018\tFTC Solar\tFinal\t09/01/26"].join("\n"),
    ),
    ["po_number", "vendor_name", "milestone_name", "paid_at"],
  ),
  ["po_number", "vendor_name", "milestone_name", "paid_at"],
  tasks,
);
eq(
  "a payment recorded as paid with no amount blocks the import",
  hit(paidNothing.blocking, "paid date and no amount"),
  true,
);

// A percentage becomes money from the PO total.
const pctMap: (PoColumnKey | null)[] = [
  "po_number",
  "vendor_name",
  "milestone_name",
  "pct_of_total",
];
const pctDiff = diffProcurement(
  existing,
  buildPoRows(
    parsePoGrid(
      ["PO Number\tVendor\tMilestone\t%", "PO-018\tFTC Solar\tRelease to ship\t60"].join("\n"),
    ),
    pctMap,
  ),
  pctMap,
  tasks,
);
eq("the new payment lands on the existing PO", pctDiff.milestoneAdds.length, 1);
eq(
  "60% of the PO total becomes an amount",
  pctDiff.milestoneAdds[0].values.amount,
  412000 * 0.6,
);

// Milestones that add up to more than the PO.
const overMap: (PoColumnKey | null)[] = [
  "po_number",
  "vendor_name",
  "total_value",
  "milestone_name",
  "milestone_amount",
];
const over = diffProcurement(
  existing,
  buildPoRows(
    parsePoGrid(
      [
        "PO Number\tVendor\tPO Total\tMilestone\tMilestone Amount",
        "PO-030\tAcme\t100000\tDeposit\t60000",
        "PO-030\t\t\tFinal\t60000",
      ].join("\n"),
    ),
    overMap,
  ),
  overMap,
  tasks,
);
eq("milestones over the PO total warn", hit(over.warnings, "add up to"), true);

const pctSumMap: (PoColumnKey | null)[] = [
  "po_number",
  "vendor_name",
  "total_value",
  "milestone_name",
  "pct_of_total",
];
const pctSum = diffProcurement(
  existing,
  buildPoRows(
    parsePoGrid(
      [
        "PO Number\tVendor\tPO Total\tMilestone\t%",
        "PO-031\tAcme\t100000\tDeposit\t30",
        "PO-031\t\t\tFinal\t60",
      ].join("\n"),
    ),
    pctSumMap,
  ),
  pctSumMap,
  tasks,
);
eq("percentages that do not reach 100 warn", hit(pctSum.warnings, "not 100%"), true);

// Delivery task links.
const linkMap: (PoColumnKey | null)[] = [
  "po_number",
  "vendor_name",
  "expected_delivery_date",
  "delivery_task_wbs",
];
const badLink = diffProcurement(
  existing,
  buildPoRows(
    parsePoGrid(
      ["PO Number\tVendor\tExpected Delivery\tDelivery Task", "PO-040\tAcme\t10/01/26\t9.9.9"].join("\n"),
    ),
    linkMap,
  ),
  linkMap,
  tasks,
);
eq("a link to a task the project does not have warns", hit(badLink.warnings, "not on this project"), true);
eq("and the PO still imports", badLink.adds.length, 1);
eq(
  "without the link",
  badLink.adds[0].values.linked_delivery_task_wbs_code,
  null,
);
eq(
  "keeping the date the sheet gave",
  badLink.adds[0].values.expected_delivery_date,
  "2026-10-01",
);

const goodLink = diffProcurement(
  existing,
  buildPoRows(
    parsePoGrid(
      ["PO Number\tVendor\tExpected Delivery\tDelivery Task", "PO-041\tAcme\t10/01/26\t4.4.3.2"].join("\n"),
    ),
    linkMap,
  ),
  linkMap,
  tasks,
);
eq(
  "the linked task's finish wins over the typed delivery date",
  goodLink.adds[0].values.expected_delivery_date,
  "2026-11-13",
);
eq("and the override is said out loud", hit(goodLink.warnings, "task wins"), true);

// Dropping a PO total under what is already paid against it.
const cutMap: (PoColumnKey | null)[] = ["po_number", "vendor_name", "total_value"];
const cut = diffProcurement(
  existing,
  buildPoRows(
    parsePoGrid(["PO Number\tVendor\tPO Total", "PO-018\tFTC Solar\t100000"].join("\n")),
    cutMap,
  ),
  cutMap,
  tasks,
);
eq("lowering a total under what is paid warns", hit(cut.warnings, "already paid"), true);
eq("and it is still offered as a change", cut.changes.length, 1);

// A PO already on the project with no PO number cannot be matched.
const unnumberedExisting: ExistingOrder[] = [
  { ...existing[0], id: "po-x", po_number: null, milestones: [] },
];
const unnumbered = diffProcurement(
  unnumberedExisting,
  buildPoRows(
    parsePoGrid(["PO Number\tVendor", "PO-018\tFTC Solar"].join("\n")),
    ["po_number", "vendor_name"],
  ),
  ["po_number", "vendor_name"],
  tasks,
);
eq(
  "a PO on the project with no PO number is called out as unmatchable",
  hit(unnumbered.warnings, "invisible to this import"),
  true,
);

// ------------------------------- the plan -------------------------------
section("Plan written from the diff");

const planMap: (PoColumnKey | null)[] = [
  "po_number",
  "vendor_name",
  "total_value",
  "milestone_name",
  "pct_of_total",
  "paid_at",
];
const planDiff = diffProcurement(
  existing,
  buildPoRows(
    parsePoGrid(
      [
        "PO Number\tVendor\tPO Total\tMilestone\t%\tPaid Date",
        "PO-050\tAcme\t200000\tDeposit\t50\t08/01/26",
        "PO-050\t\t\tFinal\t50\t",
      ].join("\n"),
    ),
    planMap,
  ),
  planMap,
  tasks,
);
const plan = planFromPoDiff(planDiff);
eq("one purchase order to add", plan.adds.length, 1);
eq("with both payments travelling with it", plan.adds[0].milestones.length, 2);
eq("the deposit is worth half the PO", plan.adds[0].milestones[0].amount, 100000);
eq(
  "a payment marked paid banks what it is worth rather than nothing",
  plan.adds[0].milestones[0].paid_amount,
  100000,
);
eq(
  "an unpaid payment banks nothing",
  plan.adds[0].milestones[1].paid_amount,
  null,
);
eq("a new PO defaults to active", plan.adds[0].status, "active");
eq(
  "the delivery task link writes to its real column",
  Object.keys(planFromPoDiff(goodLink).adds[0]).includes(
    "linked_delivery_task_wbs_code",
  ),
  true,
);

// ------------------------------ round trip ------------------------------
section("Re-importing the same sheet changes nothing");

const rtMap: (PoColumnKey | null)[] = [
  "po_number",
  "vendor_name",
  "description",
  "total_value",
  "ordered_date",
  "expected_delivery_date",
  "milestone_name",
  "pct_of_total",
  "milestone_expected_date",
  "paid_at",
];
const rtSheet = parsePoGrid(
  [
    "PO Number\tVendor\tDescription\tPO Total\tOrdered\tExpected Delivery\tMilestone\t%\tMilestone Due\tPaid Date",
    "PO-018\tFTC Solar\tPiles and racking\t412000\t07/03/26\t10/29/26\tDeposit\t30\t07/10/26\t07/12/26",
  ].join("\n"),
);
const second = diffProcurement(existing, buildPoRows(rtSheet, rtMap), rtMap, tasks);
eq("no purchase orders added", second.adds.length, 0);
eq("no purchase orders changed", second.changes.length, 0);
eq("no payments added", second.milestoneAdds.length, 0);
eq("no payments changed", second.milestoneChanges.length, 0);
eq("the PO reads as unchanged", second.unchangedCount, 1);
eq("the payment reads as unchanged", second.unchangedMilestoneCount, 1);
eq("nothing blocks", second.blocking.length, 0);

// --------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
