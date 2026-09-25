/**
 * What date a PO payment milestone lands on in the cash forecast.
 *
 * Zarina: "Is the cashflow up to date and calling from scheduled deliveries
 * and construction tasks?" Construction tasks were driving the owner and sub
 * SOV lines. Scheduled deliveries drove nothing - a vendor payment sat on
 * whatever date was typed when the PO was entered. These are the rules that
 * connect the delivery task to the vendor cash without letting the schedule
 * quietly re-date money that has already been paid.
 */

import {
  scheduleDrivesDate,
  addDaysIso,
  describeMilestoneDate,
  describeScheduleMove,
  describeScheduleMoveCount,
  forecastMilestoneDate,
  forecastPoDates,
  isDeliveryTrigger,
  netTermsDays,
  nextDueDate,
} from "../../src/lib/po-payment-forecast";

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

const task = { wbs_code: "4.4.2.2", task_name: "Delivery", end_date: "2026-11-18" };
const po = {
  id: "po-1",
  po_number: "PO-017",
  vendor_name: "FTC Solar",
  linked_delivery_task_wbs_code: "4.4.2.2",
  actual_delivery_date: null,
  payment_terms_summary: "Net 30 from invoice",
};

console.log("\nNet terms parsing\n");

same("Net 30 reads 30", netTermsDays("Net 30 from invoice"), 30);
same("NET45 with no space reads 45", netTermsDays("NET45 days"), 45);
same("lower case net 60 reads 60", netTermsDays("net 60"), 60);
same("no terms at all reads zero", netTermsDays("50% deposit, balance on delivery"), 0);
same("null reads zero", netTermsDays(null), 0);
// A three-digit read would turn "Net 3000" into eight years of float.
same("an absurd term is refused rather than trusted", netTermsDays("Net 3000"), 0);
same("terms hiding in another word are not terms", netTermsDays("Internet 30 portal"), 0);
same("2% 10 Net 30 still reads 30", netTermsDays("2% 10 Net 30"), 30);

console.log("\nWhich milestones follow the delivery\n");

check("on delivery follows the delivery", isDeliveryTrigger({ trigger_event: "Delivery to site" }));
check(
  "legacy wording still reads as a delivery",
  isDeliveryTrigger({ trigger_event: "Delivered to site" }),
);
check(
  "the name carries it when the trigger is blank",
  isDeliveryTrigger({ trigger_event: null, milestone_name: "Balance on delivery" }),
);
check("a deposit does not", !isDeliveryTrigger({ trigger_event: "PO release" }));
check("commissioning does not", !isDeliveryTrigger({ trigger_event: "Commissioning" }));
// Power Factors is 40 deposit / 30 delivery / 30 commissioning, and the
// commissioning row has to mean commissioning in both modules or the AFP and
// the cash flow disagree about the same money.
check(
  "commissioning wins over the word delivery in the same trigger",
  !isDeliveryTrigger({ trigger_event: "Commissioning and delivery sign-off" }),
);

console.log("\nThe date the forecast uses\n");

const onDelivery = { milestone_name: "Balance on delivery", trigger_event: "Delivery to site" };

same(
  "a delivery payment follows the linked task plus Net terms",
  forecastMilestoneDate({ milestone: { ...onDelivery, expected_date: "2026-10-05" }, po, deliveryTask: task }),
  {
    date: "2026-12-18",
    source: "schedule",
    viaWbs: "4.4.2.2",
    termsDays: 30,
    supersedes: "2026-10-05",
  },
);

same(
  "with no Net terms it lands on the delivery itself",
  forecastMilestoneDate({
    milestone: onDelivery,
    po: { ...po, payment_terms_summary: "Balance on delivery" },
    deliveryTask: task,
  }).date,
  "2026-11-18",
);

// The typed date was a guess made when the PO was entered. The schedule is
// the current plan, so the schedule wins - that is the entire point.
same(
  "the schedule beats the typed date",
  forecastMilestoneDate({
    milestone: { ...onDelivery, expected_date: "2026-08-01" },
    po: { ...po, payment_terms_summary: null },
    deliveryTask: task,
  }).source,
  "schedule",
);

// Moving Oct 5 to Dec 18 is worth a line on the dashboard. Moving it three
// days inside the same month is noise.
same(
  "a move inside the same month is not reported",
  forecastMilestoneDate({
    milestone: { ...onDelivery, expected_date: "2026-11-02" },
    po: { ...po, payment_terms_summary: null },
    deliveryTask: task,
  }).supersedes,
  null,
);

same(
  "an arrival that already happened beats the plan",
  forecastMilestoneDate({
    milestone: onDelivery,
    po: { ...po, actual_delivery_date: "2026-09-12" },
    deliveryTask: task,
  }),
  { date: "2026-10-12", source: "arrived", viaWbs: null, termsDays: 30, supersedes: null },
);

// paid_at is money that has left the bank on a day that happened. Nothing
// re-dates it.
same(
  "a paid milestone keeps its paid date",
  forecastMilestoneDate({
    milestone: { ...onDelivery, expected_date: "2026-10-05", paid_at: "2026-09-30" },
    po: { ...po, actual_delivery_date: "2026-09-12" },
    deliveryTask: task,
  }),
  { date: "2026-09-30", source: "paid", viaWbs: null, termsDays: 0, supersedes: null },
);

same(
  "a deposit keeps its typed date",
  forecastMilestoneDate({
    milestone: { milestone_name: "Deposit", trigger_event: "PO release", expected_date: "2026-07-01" },
    po,
    deliveryTask: task,
  }),
  { date: "2026-07-01", source: "typed", viaWbs: null, termsDays: 0, supersedes: null },
);

same(
  "commissioning keeps its typed date, there is no task pointing at it",
  forecastMilestoneDate({
    milestone: { milestone_name: "Commissioning", trigger_event: "Commissioning", expected_date: "2026-12-20" },
    po,
    deliveryTask: task,
  }).source,
  "typed",
);

console.log("\nWhen there is nothing to go on\n");

same(
  "no delivery link falls back to the typed date",
  forecastMilestoneDate({
    milestone: { ...onDelivery, expected_date: "2026-10-05" },
    po: { ...po, linked_delivery_task_wbs_code: null },
    deliveryTask: null,
  }),
  { date: "2026-10-05", source: "typed", viaWbs: null, termsDays: 0, supersedes: null },
);

// The PO points at a task, the task has no finish. Same position as no link
// at all, and the typed date is still better than nothing.
same(
  "a linked task with no finish date falls back to the typed date",
  forecastMilestoneDate({
    milestone: { ...onDelivery, expected_date: "2026-10-05" },
    po,
    deliveryTask: { wbs_code: "4.4.2.2", task_name: "Delivery", end_date: null },
  }).source,
  "typed",
);

// This is money in no month at all, which is the case the dashboard has to
// call out rather than drop.
same(
  "no date anywhere reports none",
  forecastMilestoneDate({
    milestone: onDelivery,
    po: { ...po, linked_delivery_task_wbs_code: null },
    deliveryTask: null,
  }),
  { date: null, source: "none", viaWbs: null, termsDays: 0, supersedes: null },
);

console.log("\nDate arithmetic\n");

same("Net 30 crosses a month end", addDaysIso("2026-11-18", 30), "2026-12-18");
same("Net 45 crosses a year end", addDaysIso("2026-12-05", 45), "2027-01-19");
same("a leap day is a real day", addDaysIso("2028-02-28", 1), "2028-02-29");
same("zero days is the same day", addDaysIso("2026-11-18", 0), "2026-11-18");

console.log("\nA whole PO\n");

const milestones = [
  { milestone_name: "Deposit", trigger_event: "PO release", expected_date: "2026-07-01", paid_at: "2026-07-03" },
  { milestone_name: "Balance on delivery", trigger_event: "Delivery to site", expected_date: "2026-10-05" },
  { milestone_name: "Commissioning", trigger_event: "Commissioning", expected_date: "2027-01-15" },
];

same(
  "each milestone is dated by its own rule",
  forecastPoDates({ po, milestones, deliveryTask: task }).map((d) => d.source),
  ["paid", "schedule", "typed"],
);

// Next due skips the paid deposit and reads the delivery payment off the
// schedule, not off the Oct 5 that was typed.
same(
  "next due is the soonest unpaid forecast date",
  nextDueDate({ po, milestones, deliveryTask: task }),
  "2026-12-18",
);

same(
  "a fully paid PO has nothing due",
  nextDueDate({
    po,
    milestones: [{ milestone_name: "All of it", trigger_event: "PO release", paid_at: "2026-07-03" }],
    deliveryTask: task,
  }),
  null,
);

console.log("\nWhich date is the headline\n");

// The schedule is the source of truth for a delivery, so when it supplies the
// date it IS the Expected value. Printing the typed date in the column and the
// real one in grey underneath leaves the reader to choose.
check(
  "a schedule-driven milestone is run by the schedule",
  scheduleDrivesDate(
    forecastMilestoneDate({ milestone: onDelivery, po, deliveryTask: task }),
  ),
);
check(
  "so is one the goods have already arrived for",
  scheduleDrivesDate(
    forecastMilestoneDate({
      milestone: onDelivery,
      po: { ...po, actual_delivery_date: "2026-09-12" },
      deliveryTask: task,
    }),
  ),
);
check(
  "a deposit is not - its typed date is the only date there is",
  !scheduleDrivesDate(
    forecastMilestoneDate({
      milestone: { milestone_name: "Deposit", trigger_event: "PO release", expected_date: "2026-07-01" },
      po,
      deliveryTask: task,
    }),
  ),
);
check(
  "nor is a paid one - that date already happened",
  !scheduleDrivesDate(
    forecastMilestoneDate({
      milestone: { ...onDelivery, paid_at: "2026-09-30" },
      po,
      deliveryTask: task,
    }),
  ),
);
check(
  "nor is one with nothing behind it",
  !scheduleDrivesDate(
    forecastMilestoneDate({
      milestone: onDelivery,
      po: { ...po, linked_delivery_task_wbs_code: null },
      deliveryTask: null,
    }),
  ),
);

console.log("\nWhat it says on screen\n");

const moved = forecastMilestoneDate({
  milestone: { ...onDelivery, expected_date: "2026-10-05" },
  po,
  deliveryTask: task,
});

check(
  "the PO page names the task the date came from",
  (describeMilestoneDate(moved, "Delivery") ?? "").includes("4.4.2.2 Delivery"),
);
check(
  "and names the terms it added",
  (describeMilestoneDate(moved, "Delivery") ?? "").includes("Net 30"),
);
check(
  "a paid row says nothing, the Paid column already does",
  describeMilestoneDate(
    forecastMilestoneDate({ milestone: { ...onDelivery, paid_at: "2026-09-30" }, po, deliveryTask: task }),
  ) === null,
);
check(
  "a typed row says nothing, the date is already on screen",
  describeMilestoneDate(
    forecastMilestoneDate({
      milestone: { milestone_name: "Deposit", trigger_event: "PO release", expected_date: "2026-07-01" },
      po,
      deliveryTask: task,
    }),
  ) === null,
);
check(
  "a row with no date anywhere says so",
  (describeMilestoneDate(
    forecastMilestoneDate({
      milestone: onDelivery,
      po: { ...po, linked_delivery_task_wbs_code: null },
      deliveryTask: null,
    }),
  ) ?? "").includes("not in the cash forecast"),
);

const line = describeScheduleMove({
  poLabel: "PO-017",
  milestoneName: "Balance on delivery",
  at: moved,
  taskName: "Delivery",
});
check("the move line names the PO", line.includes("PO-017"));
check("the move line names the date it left", line.includes("2026-10-05"));
check("the move line names the date it went to", line.includes("2026-12-18"));
check("the move line names the task", line.includes("4.4.2.2 Delivery"));

same("one move reads as one", describeScheduleMoveCount(1), "1 vendor payment takes its date from the schedule");
check("several read as several", describeScheduleMoveCount(4).startsWith("4 vendor payments"));

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
