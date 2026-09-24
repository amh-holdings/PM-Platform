/**
 * The amount box on the Bill this period panel, on its way onto an AFP.
 *
 * Both of these decide what the owner gets invoiced, and both used to sit
 * inline in a server action where nothing could reach them.
 */

import {
  defaultAfpAmountForPo,
  forecastAmountPatch,
  needsADecision,
  pairForecastAmounts,
  pickAfpTargetLine,
  resolveProcurementAmount,
} from "../../src/lib/billing-progress";

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

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

section("Pairing ids with amounts");

eq(
  "a plain selection pairs straight across",
  pairForecastAmounts(["a", "b"], [100, 200]),
  [
    { id: "a", amount: 100 },
    { id: "b", amount: 200 },
  ],
);

eq(
  "a blank id in the middle takes its own amount with it",
  pairForecastAmounts(["a", "", "c"], [100, 200, 300]),
  [
    { id: "a", amount: 100 },
    { id: "c", amount: 300 },
  ],
);

eq("whitespace is not an id", pairForecastAmounts(["  "], [50]), []);
eq("nothing selected pairs to nothing", pairForecastAmounts([], []), []);

eq(
  "an id with no amount comes through undefined rather than shifting the rest",
  pairForecastAmounts(["a", "b"], [100]),
  [
    { id: "a", amount: 100 },
    { id: "b", amount: undefined },
  ],
);

section("Which field the edit has to land on");

eq(
  "an untouched planned row needs no write",
  forecastAmountPatch({ planned_amount: 1000, actual_amount: 0 }, 1000),
  null,
);

eq(
  "an edited planned row writes planned only",
  forecastAmountPatch({ planned_amount: 1000, actual_amount: 0 }, 650),
  { planned_amount: 650 },
);

eq(
  "a row carrying an actual writes both, or the pay app bills the old figure",
  forecastAmountPatch({ planned_amount: 1000, actual_amount: 1000 }, 500),
  { planned_amount: 500, actual_amount: 500 },
);

eq(
  "the actual is what an edit is measured against, not the plan",
  forecastAmountPatch({ planned_amount: 9999, actual_amount: 500 }, 500),
  null,
);

eq(
  "a blocked row at zero can be overwritten",
  forecastAmountPatch({ planned_amount: 0, actual_amount: 0 }, 82619.12),
  { planned_amount: 82619.12 },
);

eq(
  "billing nothing is a real edit",
  forecastAmountPatch({ planned_amount: 1000, actual_amount: 0 }, 0),
  { planned_amount: 0 },
);

eq(
  "float noise is not an edit",
  forecastAmountPatch({ planned_amount: 1234.56, actual_amount: 0 }, 1234.5600000000002),
  null,
);

eq(
  "a negative amount is refused rather than credited",
  forecastAmountPatch({ planned_amount: 1000, actual_amount: 0 }, -5),
  null,
);

eq(
  "a blank box is refused rather than read as zero",
  forecastAmountPatch({ planned_amount: 1000, actual_amount: 0 }, Number.NaN),
  null,
);

eq(
  "a missing amount is refused",
  forecastAmountPatch({ planned_amount: 1000, actual_amount: 0 }, undefined as unknown as number),
  null,
);

eq(
  "nulls read as zero rather than throwing",
  forecastAmountPatch({ planned_amount: null, actual_amount: null }, 250),
  { planned_amount: 250 },
);

section("Read-only explanation, or a row you can price?");

const schedule = { procurement: false, linkedPoTotal: null };
const po = { procurement: true, linkedPoTotal: 400000 };

eq(
  "a schedule line at 0% stays read-only - the zero is a measurement",
  needsADecision({ ...schedule, earned: 0, alreadyBilled: 0 }),
  false,
);

eq(
  "a procurement line the app cannot value becomes a row you can price",
  needsADecision({ ...po, earned: 0, alreadyBilled: 0 }),
  true,
);

eq(
  "so does one with prior billing against it",
  needsADecision({ ...po, earned: 0, alreadyBilled: 82619.12 }),
  true,
);

eq(
  "earned value masked by earlier billing still qualifies",
  needsADecision({ ...po, earned: 42750.07, alreadyBilled: 82619.12 }),
  true,
);

eq(
  "a fully measured procurement line with nothing new does not",
  needsADecision({ ...po, earned: 42750.07, alreadyBilled: 10000 }),
  false,
);

eq(
  "and neither does a schedule line whose earned value is simply spent",
  needsADecision({ ...schedule, earned: 50000, alreadyBilled: 50000 }),
  false,
);

eq(
  "a schedule line masked by earlier billing is the original case, still true",
  needsADecision({ ...schedule, earned: 1000, alreadyBilled: 5000 }),
  true,
);

eq(
  "half a cent of earned value is not earned value",
  needsADecision({ ...schedule, earned: 0.004, alreadyBilled: 0 }),
  false,
);

section("Add to AFP: the amount the dialog opens on");

eq("half the PO, to the cent", defaultAfpAmountForPo(8960.49), 4480.25);
eq("an odd total rounds up rather than losing a cent", defaultAfpAmountForPo(0.01), 0.01);
eq("a PO with no value offers nothing", defaultAfpAmountForPo(0), 0);
eq("and neither does a negative one", defaultAfpAmountForPo(-100), 0);
eq("or a missing one", defaultAfpAmountForPo(Number.NaN), 0);

section("Add to AFP: which SOV line it lands on");

eq(
  "one allocation decides it",
  pickAfpTargetLine({ allocations: [{ billingLineId: "a", amount: 5000 }], linkedLineIds: [] }),
  "a",
);

eq(
  "several allocations open on the largest share",
  pickAfpTargetLine({
    allocations: [
      { billingLineId: "a", amount: 5000 },
      { billingLineId: "b", amount: 12000 },
    ],
    linkedLineIds: ["c"],
  }),
  "b",
);

eq(
  "an allocation beats the older amount-less link",
  pickAfpTargetLine({
    allocations: [{ billingLineId: "a", amount: 1 }],
    linkedLineIds: ["z"],
  }),
  "a",
);

eq(
  "one linked line decides it when nothing is allocated",
  pickAfpTargetLine({ allocations: [], linkedLineIds: ["z"] }),
  "z",
);

eq(
  "two linked lines is ambiguous, so the dialog asks",
  pickAfpTargetLine({ allocations: [], linkedLineIds: ["y", "z"] }),
  null,
);

eq(
  "nothing linked at all is also a question",
  pickAfpTargetLine({ allocations: [], linkedLineIds: [] }),
  null,
);

section("A typed amount versus the milestone estimate");

eq(
  "the typed figure wins outright",
  resolveProcurementAmount({ manualAmount: 4480.25, earnedValue: 3975.25, alreadyBilled: 0 }),
  { kind: "manual", amount: 4480.25 },
);

eq(
  "and is NOT netted against prior billing - the person typing did that",
  resolveProcurementAmount({ manualAmount: 4480.25, earnedValue: 0, alreadyBilled: 82619.12 }),
  { kind: "manual", amount: 4480.25 },
);

eq(
  "a line nobody staged still bills its triggered milestones",
  resolveProcurementAmount({ manualAmount: null, earnedValue: 3975.25, alreadyBilled: 0 }),
  { kind: "earned", amount: 3975.25 },
);

eq(
  "prior billing still nets off the estimate",
  resolveProcurementAmount({ manualAmount: null, earnedValue: 10000, alreadyBilled: 4000 }),
  { kind: "earned", amount: 6000 },
);

eq(
  "earned but fully billed is blocked, and says which",
  resolveProcurementAmount({ manualAmount: null, earnedValue: 10000, alreadyBilled: 10000 }),
  { kind: "blocked", reason: "already_billed" },
);

eq(
  "nothing earned is a different block",
  resolveProcurementAmount({ manualAmount: null, earnedValue: 0, alreadyBilled: 0 }),
  { kind: "blocked", reason: "nothing_earned" },
);

eq(
  "a manual zero is not a typed amount, it is an empty box",
  resolveProcurementAmount({ manualAmount: 0, earnedValue: 3975.25, alreadyBilled: 0 }),
  { kind: "earned", amount: 3975.25 },
);

eq(
  "a negative manual amount is refused rather than credited",
  resolveProcurementAmount({ manualAmount: -500, earnedValue: 0, alreadyBilled: 0 }),
  { kind: "blocked", reason: "nothing_earned" },
);

eq(
  "PO-022 end to end: $4,480.25 staged beats the $3,975.25 deposit",
  resolveProcurementAmount({ manualAmount: 4480.25, earnedValue: 3975.25, alreadyBilled: 0 }),
  { kind: "manual", amount: 4480.25 },
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
