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
  lineLabel,
  scheduleDrivesDate,
  addDaysIso,
  describeMilestoneDate,
  describeScheduleMove,
  describeScheduleMoveCount,
  forecastMilestoneDate,
  forecastPoDates,
  isDeliveryTrigger,
  isTypedEventTrigger,
  isSigningTrigger,
  resolveNetTerms,
  netTermsDays,
  nextDueDate,
} from "../../src/lib/po-payment-forecast";
import { monthIsoFromDate } from "../../src/lib/cashflow";

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
    viaLine: null,
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
  { date: "2026-10-12", source: "arrived", viaWbs: null, viaLine: null, termsDays: 30, supersedes: null },
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
  { date: "2026-09-30", source: "paid", viaWbs: null, viaLine: null, termsDays: 0, supersedes: null },
);

same(
  "a deposit keeps its typed date",
  forecastMilestoneDate({
    milestone: { milestone_name: "Deposit", trigger_event: "PO release", expected_date: "2026-07-01" },
    po,
    deliveryTask: task,
  }),
  { date: "2026-07-01", source: "typed", viaWbs: null, viaLine: null, termsDays: 0, supersedes: null },
);

// Commissioning used to keep its typed date untouched. Zarina:
// "Commissioning doesnt have a forecast for net 30." The typed date is the
// commissioning DAY, there is still no task to derive it from, but the PO's
// terms are applied on top of it now, because this column is the day money
// leaves the bank.
same(
  "commissioning is the typed day plus the PO's terms",
  forecastMilestoneDate({
    milestone: { milestone_name: "Commissioning", trigger_event: "Commissioning", expected_date: "2026-12-20" },
    po,
    deliveryTask: task,
  }),
  {
    date: "2027-01-19",
    source: "event",
    viaWbs: null,
    viaLine: null,
    termsDays: 30,
    supersedes: "2026-12-20",
  },
);

// With no terms on the PO there is nothing to add, so nothing changes and
// nothing is said about it.
same(
  "no terms leaves the commissioning date exactly as typed",
  forecastMilestoneDate({
    milestone: { milestone_name: "Commissioning", trigger_event: "Commissioning", expected_date: "2026-12-20" },
    po: { ...po, payment_terms_summary: null },
  }),
  { date: "2026-12-20", source: "typed", viaWbs: null, viaLine: null, termsDays: 0, supersedes: null },
);

same(
  "a commissioning milestone with no date typed still has no date",
  forecastMilestoneDate({
    milestone: { milestone_name: "Commissioning", trigger_event: "Commissioning" },
    po,
  }).date,
  null,
);

same(
  "a paid commissioning milestone is never re-dated",
  forecastMilestoneDate({
    milestone: {
      milestone_name: "Commissioning",
      trigger_event: "Commissioning",
      expected_date: "2026-12-20",
      paid_at: "2026-12-22",
    },
    po,
  }).source,
  "paid",
);

// Her row: commissioning 16 Dec, Net 30, so the money goes out 15 Jan.
same(
  "the row she reported now pays 30 days after commissioning",
  forecastMilestoneDate({
    milestone: {
      milestone_name: "Commissioning",
      trigger_event: "Commissioning complete - Net 30",
      expected_date: "2026-12-16",
    },
    po: { ...po, payment_terms_summary: "Net 30" },
  }).date,
  "2027-01-15",
);

// Commissioning must never be read as a delivery or a signing trigger, or it
// would start following the schedule or the signing date.
check(
  "commissioning is only ever a commissioning trigger",
  isTypedEventTrigger({ trigger_event: "Commissioning complete - Net 30" }) &&
    !isDeliveryTrigger({ trigger_event: "Commissioning complete - Net 30" }) &&
    !isSigningTrigger({ trigger_event: "Commissioning complete - Net 30" }),
);

console.log("\nWhen there is nothing to go on\n");

same(
  "no delivery link falls back to the typed date",
  forecastMilestoneDate({
    milestone: { ...onDelivery, expected_date: "2026-10-05" },
    po: { ...po, linked_delivery_task_wbs_code: null },
    deliveryTask: null,
  }),
  { date: "2026-10-05", source: "typed", viaWbs: null, viaLine: null, termsDays: 0, supersedes: null },
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
  { date: null, source: "none", viaWbs: null, viaLine: null, termsDays: 0, supersedes: null },
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

// The commissioning row reads "commissioning" rather than "typed" since
// Zarina asked for the PO's Net 30 to reach it. 2027-01-15 plus 30 days.
same(
  "each milestone is dated by its own rule",
  forecastPoDates({ po, milestones, deliveryTask: task }).map((d) => d.source),
  ["paid", "schedule", "event"],
);
same(
  "and the commissioning one lands 30 days after the day typed",
  forecastPoDates({ po, milestones, deliveryTask: task })[2].date,
  "2027-02-14",
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

console.log("\nA PO with more than one delivery\n");

// Zarina: "there are POs that has multiple deliveries on it. And each item
// inside a PO can be linked to a line in the schedule." FTC Solar delivers
// piles and racking on different dates against different schedule rows.
const SCHEDULE: Record<string, { wbs_code: string; task_name: string; end_date: string }> = {
  "4.3.1.2": { wbs_code: "4.3.1.2", task_name: "Pile Delivery", end_date: "2026-10-29" },
  "4.3.2.2": { wbs_code: "4.3.2.2", task_name: "Racking Delivery", end_date: "2026-11-18" },
};
const taskOf = (w: string) => SCHEDULE[w] ?? null;

const PILES = { id: "l1", line_no: 1, description: "Piles", linked_delivery_task_wbs_code: "4.3.1.2" };
const RACKING = { id: "l2", line_no: 2, description: "Racking", linked_delivery_task_wbs_code: "4.3.2.2" };
const LINES = [PILES, RACKING];

// No PO-level link at all. Each milestone rides on its own item.
const multiPo = { ...po, linked_delivery_task_wbs_code: null, payment_terms_summary: null };

same(
  "a milestone tied to the piles line follows the pile delivery",
  forecastMilestoneDate({
    milestone: { ...onDelivery, procurement_order_line_id: "l1" },
    po: multiPo,
    lines: LINES,
    taskOf,
  }),
  {
    date: "2026-10-29",
    source: "schedule",
    viaWbs: "4.3.1.2",
    viaLine: { id: "l1", label: "Line 1 Piles" },
    termsDays: 0,
    supersedes: null,
  },
);

same(
  "and the racking milestone follows the racking delivery, three weeks later",
  forecastMilestoneDate({
    milestone: { ...onDelivery, procurement_order_line_id: "l2" },
    po: multiPo,
    lines: LINES,
    taskOf,
  }).date,
  "2026-11-18",
);

// This is the whole point. One link for the PO gave both shipments one date.
check(
  "the two deliveries no longer land on the same day",
  forecastMilestoneDate({
    milestone: { ...onDelivery, procurement_order_line_id: "l1" },
    po: multiPo, lines: LINES, taskOf,
  }).date !==
    forecastMilestoneDate({
      milestone: { ...onDelivery, procurement_order_line_id: "l2" },
      po: multiPo, lines: LINES, taskOf,
    }).date,
);

// An item carries no arrival date of its own. Zarina: "If the delivery date
// in the schedule is different on when it actually arrives, I will just
// adjust schedule and not here." One fact, one place.
// Moving the schedule row moves the payment. That is the whole mechanism she
// asked for: adjust the schedule, not a second box on this page.
same(
  "moving the schedule row moves the item's payment with it",
  forecastMilestoneDate({
    milestone: { ...onDelivery, procurement_order_line_id: "l1" },
    po: multiPo,
    lines: LINES,
    taskOf: (wbs) =>
      wbs === "4.3.1.2"
        ? { wbs_code: "4.3.1.2", task_name: "Pile Delivery", end_date: "2026-10-20" }
        : taskOf(wbs),
  }).date,
  "2026-10-20",
);

// And the whole-order case reads the schedule too, never a stored arrival.
same(
  "a whole-order milestone waits for the last schedule row, not a stored date",
  forecastMilestoneDate({
    milestone: onDelivery,
    po: multiPo,
    lines: LINES,
    taskOf: (wbs) =>
      wbs === "4.3.2.2"
        ? { wbs_code: "4.3.2.2", task_name: "Racking Delivery", end_date: "2026-12-04" }
        : taskOf(wbs),
  }).date,
  "2026-12-04",
);

console.log("\nA milestone that covers the whole order\n");

// No line named, so it is not earned until the last item lands. Taking the
// first would pay for equipment still on a truck.
same(
  "with no line named it waits for the last delivery",
  forecastMilestoneDate({ milestone: onDelivery, po: multiPo, lines: LINES, taskOf }),
  {
    date: "2026-11-18",
    source: "last_line",
    viaWbs: "4.3.2.2",
    viaLine: { id: "l2", label: "Line 2 Racking" },
    termsDays: 0,
    supersedes: null,
  },
);

same(
  "the order of the lines does not decide it, the dates do",
  forecastMilestoneDate({
    milestone: onDelivery,
    po: multiPo,
    lines: [RACKING, PILES],
    taskOf,
  }).date,
  "2026-11-18",
);

// A PO-level link is a deliberate statement that the order arrives as one
// delivery, so it outranks reading the items.
same(
  "a PO-level link still wins over guessing from the lines",
  forecastMilestoneDate({
    milestone: onDelivery,
    po: { ...po, payment_terms_summary: null },
    deliveryTask: task,
    lines: LINES,
    taskOf,
  }).source,
  "schedule",
);

// The line the milestone names outranks the PO-level link: the PO pays per
// delivery, and the milestone says which one.
same(
  "but a line named on the milestone outranks even that",
  forecastMilestoneDate({
    milestone: { ...onDelivery, procurement_order_line_id: "l1" },
    po: { ...po, payment_terms_summary: null },
    deliveryTask: task,
    lines: LINES,
    taskOf,
  }).viaWbs,
  "4.3.1.2",
);

same(
  "a line with no schedule link falls through to the rest",
  forecastMilestoneDate({
    milestone: { ...onDelivery, procurement_order_line_id: "l3", expected_date: "2026-10-05" },
    po: multiPo,
    lines: [{ id: "l3", line_no: 3, description: "Freight" }],
    taskOf,
  }),
  { date: "2026-10-05", source: "typed", viaWbs: null, viaLine: null, termsDays: 0, supersedes: null },
);

same(
  "no lines at all behaves exactly as it did before 0062",
  forecastMilestoneDate({
    milestone: { ...onDelivery, expected_date: "2026-10-05" },
    po,
    deliveryTask: task,
  }).source,
  "schedule",
);

check(
  "Net terms apply to a line date the same way",
  forecastMilestoneDate({
    milestone: { ...onDelivery, procurement_order_line_id: "l1" },
    po: { ...multiPo, payment_terms_summary: "Net 30" },
    lines: LINES,
    taskOf,
  }).date === "2026-11-28",
);

check(
  "the note names the item when there is more than one delivery",
  (describeMilestoneDate(
    forecastMilestoneDate({
      milestone: { ...onDelivery, procurement_order_line_id: "l2" },
      po: multiPo, lines: LINES, taskOf,
    }),
    "Racking Delivery",
  ) ?? "").includes("Line 2 Racking"),
);

check(
  "and says which item the whole-order milestone is waiting on",
  (describeMilestoneDate(
    forecastMilestoneDate({ milestone: onDelivery, po: multiPo, lines: LINES, taskOf }),
  ) ?? "").includes("last item to land"),
);

check(
  "a single-delivery PO says nothing about items",
  !(describeMilestoneDate(
    forecastMilestoneDate({ milestone: onDelivery, po, deliveryTask: task }),
    "Delivery",
  ) ?? "").includes("for Line"),
);

same("a line with both numbers and a name reads as both", lineLabel(PILES), "Line 1 Piles");
same("a nameless line reads as its number", lineLabel({ line_no: 4 }), "Line 4");
same("a numberless line reads as its name", lineLabel({ description: "Freight" }), "Freight");
same("an empty line still reads as something", lineLabel({}), "an item");

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


// ---------------------------------------------------------------------------
// The seam into the cash flow.
//
// Zarina: "Can you confirm that this moves the cashflow forcast well?"
//
// buildProjection does exactly two things with what forecastMilestoneDate
// returns: monthIsoFromDate(at.date), then it adds the amount to that month's
// vendorCashOut. So composing those two here is the same arithmetic the curve
// does, and a move that crosses a month boundary has to land in the new month.
// ---------------------------------------------------------------------------

console.log("\nThe seam into the cash flow\n");

/** What the curve buckets this milestone into, for a given schedule. */
const cashMonth = (lineId: string | null, pileEnd: string, rackEnd: string) =>
  monthIsoFromDate(
    forecastMilestoneDate({
      milestone: lineId
        ? { ...onDelivery, procurement_order_line_id: lineId }
        : onDelivery,
      po: multiPo,
      lines: LINES,
      taskOf: (wbs) =>
        wbs === "4.3.1.2"
          ? { wbs_code: "4.3.1.2", task_name: "Pile Delivery", end_date: pileEnd }
          : wbs === "4.3.2.2"
            ? { wbs_code: "4.3.2.2", task_name: "Racking Delivery", end_date: rackEnd }
            : taskOf(wbs),
    }).date!,
  );

same(
  "the piles payment sits in the month the pile delivery sits in",
  cashMonth("l1", "2026-10-29", "2026-11-18"),
  "2026-10-01",
);
same(
  "the racking payment sits in its own, later month",
  cashMonth("l2", "2026-10-29", "2026-11-18"),
  "2026-11-01",
);
same(
  "slipping the pile delivery into November moves that money to November",
  cashMonth("l1", "2026-11-03", "2026-11-18"),
  "2026-11-01",
);
same(
  "pulling the racking delivery into October moves that money to October",
  cashMonth("l2", "2026-10-29", "2026-10-30"),
  "2026-10-01",
);
same(
  "a whole-order payment rides the LAST delivery, so slipping racking moves it",
  cashMonth(null, "2026-10-29", "2026-12-02"),
  "2026-12-01",
);
same(
  "and slipping the FIRST delivery leaves a whole-order payment where it was",
  cashMonth(null, "2026-11-03", "2026-11-18"),
  "2026-11-01",
);

check(
  "two items on one PO can land in two different cash-flow months",
  cashMonth("l1", "2026-10-29", "2026-11-18") !==
    cashMonth("l2", "2026-10-29", "2026-11-18"),
);


// ---------------------------------------------------------------------------
// A milestone that fires when the PO is signed.
//
// Zarina: "Can you add option for net 30 after PO, or is it a hidden
// understand that if set trigger to PO release, then it will be automatically
// net 30?"
//
// The trigger says WHEN it is earned, the PO's payment terms say how long
// after that it is paid. Two facts, two fields. Only delivery triggers ever
// had their two halves put together.
// ---------------------------------------------------------------------------

console.log("\nA milestone that fires on signing\n");

const signedPo = {
  ...po,
  signed_at: "2026-06-17",
  ordered_date: "2026-06-01",
  payment_terms_summary: "Net 30",
};
const release = { milestone_name: "Downpayment", trigger_event: "PO Release" };

same(
  "PO Release takes the signed date plus the PO's Net 30",
  forecastMilestoneDate({ milestone: release, po: signedPo }),
  {
    date: "2026-07-17",
    source: "signed",
    viaWbs: null,
    viaLine: null,
    termsDays: 30,
    supersedes: null,
  },
);

check(
  "every signing wording behaves the same way",
  ["PO Release", "PO Signed", "Deposit", "Down payment", "Mobilization"].every(
    (t) =>
      forecastMilestoneDate({
        milestone: { milestone_name: t, trigger_event: t },
        po: signedPo,
      }).date === "2026-07-17",
  ),
);

same(
  "no net terms on the PO means the signing date itself",
  forecastMilestoneDate({
    milestone: release,
    po: { ...signedPo, payment_terms_summary: null },
  }).date,
  "2026-06-17",
);

same(
  "Net 60 moves it a month further out",
  forecastMilestoneDate({
    milestone: release,
    po: { ...signedPo, payment_terms_summary: "Net 60" },
  }).date,
  "2026-08-16",
);

// The signed date is a fact, so it beats the guess, exactly as a delivery
// date does. The typed date is reported as superseded when the month moves.
same(
  "the signed date beats a typed one, and says so",
  forecastMilestoneDate({
    milestone: { ...release, expected_date: "2026-09-15" },
    po: signedPo,
  }),
  {
    date: "2026-07-17",
    source: "signed",
    viaWbs: null,
    viaLine: null,
    termsDays: 30,
    supersedes: "2026-09-15",
  },
);

// Before it is signed, a typed date is somebody's judgement about when that
// will happen. The ordered date is only a stand-in, so it does not overrule.
const unsigned = { ...signedPo, signed_at: null };
same(
  "an unsigned PO keeps the typed date",
  forecastMilestoneDate({
    milestone: { ...release, expected_date: "2026-09-15" },
    po: unsigned,
  }),
  {
    date: "2026-09-15",
    source: "typed",
    viaWbs: null,
    viaLine: null,
    termsDays: 0,
    supersedes: null,
  },
);
same(
  "an unsigned PO with nothing typed falls back to the ordered date plus terms",
  forecastMilestoneDate({ milestone: release, po: unsigned }),
  {
    date: "2026-07-01",
    source: "ordered",
    viaWbs: null,
    viaLine: null,
    termsDays: 30,
    supersedes: null,
  },
);
same(
  "no signed date, no typed date and no ordered date is still no date",
  forecastMilestoneDate({
    milestone: release,
    po: { ...unsigned, ordered_date: null },
  }).date,
  null,
);

// This is the whole point: money that was outside the curve is now in it.
check(
  "the deposit she reported now has a date",
  forecastMilestoneDate({ milestone: release, po: signedPo }).date !== null,
);

// A paid milestone is still never re-dated.
same(
  "paid still wins over everything",
  forecastMilestoneDate({
    milestone: { ...release, paid_at: "2026-06-20" },
    po: signedPo,
  }).source,
  "paid",
);

// A signing trigger must never be read as a delivery one, or a deposit would
// start following the schedule.
check(
  "a delivery wording is not a signing trigger",
  !isSigningTrigger({ trigger_event: "Delivery to site" }) &&
    !isSigningTrigger({ trigger_event: "Commissioning" }),
);
check(
  "a signing wording is not a delivery trigger",
  !isDeliveryTrigger({ trigger_event: "PO Release" }),
);

// And the derived date reaches the cash flow in the right month.
same(
  "the signed date buckets into July",
  monthIsoFromDate(forecastMilestoneDate({ milestone: release, po: signedPo }).date!),
  "2026-07-01",
);
same(
  "Net 60 buckets it into August instead",
  monthIsoFromDate(
    forecastMilestoneDate({
      milestone: release,
      po: { ...signedPo, payment_terms_summary: "Net 60" },
    }).date!,
  ),
  "2026-08-01",
);


// ---------------------------------------------------------------------------
// Engineering and progress payments follow the same rule.
//
// Zarina, on a PO reading "20% Down Payment, 10% Engineering, 40% Progress
// payment, 30% upon delivery": "Can you make sure that it fixes all POs."
// Half that order's value sat on two wordings nothing recognised.
// ---------------------------------------------------------------------------

console.log("\nEngineering and progress payments\n");

const netPo = { ...po, payment_terms_summary: "Net 30" };

for (const t of ["Engineering", "Progress payment", "Commissioning"]) {
  same(
    `${t} takes the typed day plus the PO's Net 30`,
    forecastMilestoneDate({
      milestone: { milestone_name: t, trigger_event: t, expected_date: "2026-12-16" },
      po: netPo,
    }).date,
    "2027-01-15",
  );
  check(
    `${t} never reads as a delivery or a signing trigger`,
    !isDeliveryTrigger({ trigger_event: t }) && !isSigningTrigger({ trigger_event: t }),
  );
}

// The wordings that actually appeared on her PO, not the tidy dropdown ones.
same(
  "the PO's own wording works, not just the dropdown value",
  forecastMilestoneDate({
    milestone: {
      milestone_name: "Engineering",
      trigger_event: "10% Engineering",
      expected_date: "2026-10-01",
    },
    po: netPo,
  }).date,
  "2026-10-31",
);

// An engineering DOWN PAYMENT must not fire on signing just because the word
// down is in it. The event check runs first.
check(
  "engineering beats the deposit wording inside the same string",
  !isSigningTrigger({ trigger_event: "Engineering down payment" }) &&
    isTypedEventTrigger({ trigger_event: "Engineering down payment" }),
);
check(
  "progress payment on delivery is the event, not the delivery",
  !isDeliveryTrigger({ trigger_event: "Progress payment on delivery" }),
);

// And a PO release is still a PO release.
check(
  "the signing triggers are untouched",
  ["PO Release", "PO Signed", "Deposit", "Down payment", "Mobilization"].every(
    (t) => isSigningTrigger({ trigger_event: t }) && !isTypedEventTrigger({ trigger_event: t }),
  ),
);


// ---------------------------------------------------------------------------
// Net terms as a column, not a phrase.
//
// Zarina: "Can you separate the net terms instead? Like add a column for
// specific net terms then the forcast will draw from that not just on a text
// field."
// ---------------------------------------------------------------------------

console.log("\nNet terms from the column\n");

same("the column wins over the summary", resolveNetTerms({ net_terms_days: 45, payment_terms_summary: "Net 30" }), 45);
same("no column falls back to the summary", resolveNetTerms({ payment_terms_summary: "Net 30" }), 30);
same("a null column falls back too", resolveNetTerms({ net_terms_days: null, payment_terms_summary: "Net 60" }), 60);

// The whole point of keeping null and zero apart. Zero is an answer.
same("zero in the column means zero, not 'read the text'", resolveNetTerms({ net_terms_days: 0, payment_terms_summary: "Net 30" }), 0);
same("nothing anywhere is zero days", resolveNetTerms({}), 0);
same("prose with no net in it is zero days", resolveNetTerms({ payment_terms_summary: "20% Down Payment, 10% Engineering, 40% Progress payment, 30% upon delivery" }), 0);

// Out-of-range values are typos, not terms. Fall back rather than store them.
same("a negative column is ignored", resolveNetTerms({ net_terms_days: -5, payment_terms_summary: "Net 30" }), 30);
same("over a year is ignored", resolveNetTerms({ net_terms_days: 400, payment_terms_summary: "Net 30" }), 30);
same("a fraction is truncated", resolveNetTerms({ net_terms_days: 30.9 }), 30);
same("NaN is ignored", resolveNetTerms({ net_terms_days: Number.NaN, payment_terms_summary: "Net 45" }), 45);

// End to end: the column moves the forecast date.
const colPo = { ...po, signed_at: "2026-06-17", payment_terms_summary: "Net 30", net_terms_days: 60 };
same(
  "the column, not the summary, decides when the deposit is paid",
  forecastMilestoneDate({
    milestone: { milestone_name: "Downpayment", trigger_event: "PO Release" },
    po: colPo,
  }).date,
  "2026-08-16",
);
same(
  "and a zero column pays on the day itself",
  forecastMilestoneDate({
    milestone: { milestone_name: "Downpayment", trigger_event: "PO Release" },
    po: { ...colPo, net_terms_days: 0 },
  }).date,
  "2026-06-17",
);
same(
  "the column reaches a commissioning milestone too",
  forecastMilestoneDate({
    milestone: { milestone_name: "Commissioning", trigger_event: "Commissioning", expected_date: "2026-12-16" },
    po: { ...colPo, net_terms_days: 45 },
  }).date,
  "2027-01-30",
);

// ---------------------------------------------------------------------------
// Net terms on the milestone, which is the row that actually pays.
//
// Zarina, on a PO reading "20% Down Payment, 10% Engineering, 40% Progress
// payment, 30% upon delivery": "Instead of the summary from the uploaded PO,
// can you just do it when adding a milestone?"
//
// Four milestones, four clocks. A single number on the order picks one of
// them and is wrong three times, so the row wins when it says anything and
// the order is only what it falls back to.
// ---------------------------------------------------------------------------

console.log("\nNet terms from the milestone\n");

const msPo = { payment_terms_summary: "Net 30", net_terms_days: 60 };

same(
  "the milestone wins over the order",
  resolveNetTerms(msPo, { net_terms_days: 15 }),
  15,
);
same(
  "a blank milestone falls back to the order",
  resolveNetTerms(msPo, { net_terms_days: null }),
  60,
);
same(
  "no milestone at all falls back to the order",
  resolveNetTerms(msPo),
  60,
);
same(
  "blank at both levels falls back to the summary",
  resolveNetTerms({ payment_terms_summary: "Net 45" }, { net_terms_days: null }),
  45,
);
// The same null-is-not-zero rule, one level down. A deposit due on signing
// with no lag has to be able to say so on a PO whose other rows are Net 30.
same(
  "zero on the milestone means zero, not 'ask the order'",
  resolveNetTerms(msPo, { net_terms_days: 0 }),
  0,
);
// Out of range is a typo, not an instruction to pay in a year. It falls
// through to the order rather than being stored or honoured.
same(
  "an out-of-range milestone falls through to the order",
  resolveNetTerms(msPo, { net_terms_days: 400 }),
  60,
);
same(
  "a negative milestone falls through to the order",
  resolveNetTerms(msPo, { net_terms_days: -5 }),
  60,
);
same(
  "a fractional milestone is truncated, not dropped",
  resolveNetTerms(msPo, { net_terms_days: 20.9 }),
  20,
);

// End to end, on the PO she was looking at. One order, four milestones, and
// each one lands where its own terms put it rather than all four sharing the
// order's number.
const mixedPo = {
  ...po,
  signed_at: "2026-06-17",
  payment_terms_summary: "20% Down Payment, 10% Engineering, 40% Progress payment, 30% upon delivery",
  net_terms_days: 30,
};

same(
  "a deposit set to 0 pays on the signing date, not 30 days later",
  forecastMilestoneDate({
    milestone: { milestone_name: "Down Payment", trigger_event: "PO Release", net_terms_days: 0 },
    po: mixedPo,
  }).date,
  "2026-06-17",
);
same(
  "engineering on the same PO still runs at its own Net 45",
  forecastMilestoneDate({
    milestone: {
      milestone_name: "Engineering",
      trigger_event: "Engineering",
      expected_date: "2026-07-01",
      net_terms_days: 45,
    },
    po: mixedPo,
  }).date,
  "2026-08-15",
);
same(
  "and a row that says nothing still takes the order's 30",
  forecastMilestoneDate({
    milestone: {
      milestone_name: "Progress payment",
      trigger_event: "Progress payment",
      expected_date: "2026-07-01",
    },
    po: mixedPo,
  }).date,
  "2026-07-31",
);
// Paid is still paid. Terms at any level never re-date money that has left.
same(
  "terms on the milestone do not move a payment already made",
  forecastMilestoneDate({
    milestone: {
      milestone_name: "Down Payment",
      trigger_event: "PO Release",
      net_terms_days: 90,
      paid_at: "2026-06-20",
    },
    po: mixedPo,
  }).date,
  "2026-06-20",
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
