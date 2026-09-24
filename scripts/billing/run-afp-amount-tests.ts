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
  typedAmount,
} from "../../src/lib/billing-progress";
import {
  applyPoContribution,
  contributionFor,
  contributionTotal,
  describeContributions,
  describeStagingEffect,
  describePoAfpStanding,
  canAddToAfp,
  canUndoFromPo,
  overwriteWarning,
  planUndo,
} from "../../src/lib/afp-po-staging";

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const LABELS: Record<string, string> = { "po-17": "PO-017", "po-22": "PO-022" };
const labelOf = (id: string) => LABELS[id] ?? "a PO";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
  }
}

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

section("A typed amount wins on ANY kind of line");

// This gate used to live inside the procurement branch only, so Add to AFP
// worked on a procurement SOV line and was discarded on every other kind.
// Zarina: "I just added an AFP amount from PO-17. But it is not reflecting."
eq("a typed figure comes through", typedAmount(42750.07), 42750.07);
eq("zero is an empty box, not a figure", typedAmount(0), null);
eq("negative is refused rather than credited", typedAmount(-500), null);
eq("nothing typed is nothing", typedAmount(null), null);
eq("and neither is undefined", typedAmount(undefined), null);
eq("a broken number does not become an amount", typedAmount(Number.NaN), null);


// ---------------------------------------------------------------------------
// Two POs on one SOV line in one period.
//
// Zarina: "I added 2 POs for AFP13 but it is not reflecting in the billing it
// should say a default number of 50% of PO17 and 50% of PO22." PO-017 and
// PO-022 both hang off 5.05 POI Procurement, and billing_entries carries
// unique (billing_line_id, period_month), so the second overwrote the first.
// ---------------------------------------------------------------------------

eq(
  "a second PO adds to the line rather than replacing the first",
  applyPoContribution([{ poId: "po-17", amount: 47965 }], "po-22", 4480.25),
  [
    { poId: "po-17", amount: 47965 },
    { poId: "po-22", amount: 4480.25 },
  ],
);

eq(
  "and the line totals both",
  contributionTotal(
    applyPoContribution([{ poId: "po-17", amount: 47965 }], "po-22", 4480.25),
  ),
  52445.25,
);

eq(
  "re-staging the same PO corrects its figure, it does not double it",
  applyPoContribution(
    [
      { poId: "po-17", amount: 47965 },
      { poId: "po-22", amount: 4480.25 },
    ],
    "po-17",
    50000,
  ),
  [
    { poId: "po-22", amount: 4480.25 },
    { poId: "po-17", amount: 50000 },
  ],
);

eq(
  "zero takes a PO back off the line and leaves the others",
  applyPoContribution(
    [
      { poId: "po-17", amount: 47965 },
      { poId: "po-22", amount: 4480.25 },
    ],
    "po-22",
    0,
  ),
  [{ poId: "po-17", amount: 47965 }],
);

eq("cents survive the round trip", contributionTotal([
  { poId: "po-17", amount: 47965.01 },
  { poId: "po-22", amount: 4480.25 },
]), 52445.26);

eq("a PO not on the line contributes nothing", contributionFor([{ poId: "po-17", amount: 10 }], "po-22"), 0);
eq("and one that is contributes its own figure", contributionFor([{ poId: "po-17", amount: 10 }], "po-17"), 10);

eq(
  "the breakdown names both POs against the sum",
  describeContributions(
    [
      { poId: "po-17", amount: 47965 },
      { poId: "po-22", amount: 4480.25 },
    ],
    labelOf,
    money,
  ),
  "PO-017 $47,965.00 + PO-022 $4,480.25",
);

eq(
  "one PO is still named - next to a bare number that is the question",
  describeContributions([{ poId: "po-17", amount: 47965 }], labelOf, money),
  "PO-017 $47,965.00",
);

eq(
  "nothing staged breaks down to nothing",
  describeContributions([], labelOf, money),
  null,
);

// --- what the dialog says before you save ---

eq(
  "an empty line needs no warning",
  describeStagingEffect({
    stagedThisPeriod: 0,
    stagedByThisPo: 0,
    incomingAmount: 4480.25,
    poLabel: "PO-022",
    formatAmount: money,
  }),
  null,
);

check(
  "adding alongside another PO states the resulting line total",
  (describeStagingEffect({
    stagedThisPeriod: 47965,
    stagedByThisPo: 0,
    incomingAmount: 4480.25,
    poLabel: "PO-022",
    formatAmount: money,
  }) ?? "").includes("$52,445.25"),
);

check(
  "and says it adds rather than replaces",
  (describeStagingEffect({
    stagedThisPeriod: 47965,
    stagedByThisPo: 0,
    incomingAmount: 4480.25,
    poLabel: "PO-022",
    formatAmount: money,
  }) ?? "").includes("adds to it"),
);

check(
  "correcting this PO's own figure says replace, and totals the rest with it",
  (() => {
    const line = describeStagingEffect({
      stagedThisPeriod: 52445.25,
      stagedByThisPo: 4480.25,
      incomingAmount: 6000,
      poLabel: "PO-022",
      formatAmount: money,
    }) ?? "";
    return line.includes("replaces") && line.includes("$53,965.00");
  })(),
);

check(
  "this PO alone on the line says replace and nothing about others",
  (() => {
    const line = describeStagingEffect({
      stagedThisPeriod: 4480.25,
      stagedByThisPo: 4480.25,
      incomingAmount: 6000,
      poLabel: "PO-022",
      formatAmount: money,
    }) ?? "";
    return line.includes("replaces that figure") && !line.includes("other purchase orders");
  })(),
);

check(
  "without the ledger the dialog says the figure would be replaced, and names the migration",
  (() => {
    const line = describeStagingEffect({
      stagedThisPeriod: 47965,
      stagedByThisPo: null,
      incomingAmount: 4480.25,
      poLabel: "PO-022",
      formatAmount: money,
    }) ?? "";
    return line.includes("0059") && line.includes("replace");
  })(),
);

// --- the refusal that replaces the silent overwrite ---

check(
  "a different PO onto an occupied line is refused, naming the PO in the way",
  (() => {
    const w = overwriteWarning({
      existingPoId: "po-17",
      existingAmount: 47965,
      incomingPoId: "po-22",
      labelOf,
      formatAmount: money,
    }) ?? "";
    return w.includes("PO-017") && w.includes("$47,965.00") && w.includes("0059");
  })(),
);

eq(
  "the same PO correcting itself is never in its own way",
  overwriteWarning({
    existingPoId: "po-17",
    existingAmount: 47965,
    incomingPoId: "po-17",
    labelOf,
    formatAmount: money,
  }),
  null,
);

eq(
  "an empty line is not in the way either",
  overwriteWarning({
    existingPoId: null,
    existingAmount: 0,
    incomingPoId: "po-22",
    labelOf,
    formatAmount: money,
  }),
  null,
);

eq(
  "nor is a line whose figure is zero",
  overwriteWarning({
    existingPoId: "po-17",
    existingAmount: 0,
    incomingPoId: "po-22",
    labelOf,
    formatAmount: money,
  }),
  null,
);

// The default she expects: half of each PO, summed onto the one line.
eq(
  "50% of PO-017 plus 50% of PO-022 is what the line carries",
  contributionTotal(
    applyPoContribution(
      applyPoContribution([], "po-17", defaultAfpAmountForPo(95930)),
      "po-22",
      defaultAfpAmountForPo(8960.49),
    ),
  ),
  52445.25,
);


// ---------------------------------------------------------------------------
// Added, and the way back off.
//
// Zarina: "I already added this to AFP. should say added and I would not be
// able to add again unless I undo. So once add, there should be an undo
// button."
// ---------------------------------------------------------------------------

const monthName = (m: string) =>
  ({ "2026-09-01": "Sep 2026", "2026-10-01": "Oct 2026" })[m] ?? m;

const STAGED = {
  state: "staged" as const,
  amount: 47965,
  lineLabel: "5.05 POI Procurement",
  periodMonth: "2026-09-01",
};
const BILLED = {
  state: "billed" as const,
  amount: 47965,
  lineLabel: "5.05 POI Procurement",
  periodMonth: "2026-09-01",
  afpNumber: "AFP 13",
};

eq("a PO with nothing staged can be added", canAddToAfp({ state: "none" }), true);
eq("one already staged cannot be added again", canAddToAfp(STAGED), false);
eq("nor can one already billed", canAddToAfp(BILLED), false);

eq("a staged PO can be taken back off here", canUndoFromPo(STAGED), true);
eq("a billed one cannot - that is the Billing page's job", canUndoFromPo(BILLED), false);
eq("and there is nothing to undo on an untouched PO", canUndoFromPo({ state: "none" }), false);

eq(
  "an untouched PO says nothing, so the opening-amount line stands",
  describePoAfpStanding({ state: "none" }, money, monthName),
  null,
);

check(
  "a staged PO names the amount, the line and the period",
  (() => {
    const line = describePoAfpStanding(STAGED, money, monthName) ?? "";
    return (
      line.includes("$47,965.00") &&
      line.includes("5.05 POI Procurement") &&
      line.includes("Sep 2026") &&
      line.includes("Undo")
    );
  })(),
);

check(
  "a billed PO names the application and sends you to the Billing page",
  (() => {
    const line = describePoAfpStanding(BILLED, money, monthName) ?? "";
    return line.includes("AFP 13") && line.includes("Billing page");
  })(),
);

// --- what undo does to the entry underneath ---

eq(
  "with another PO still on the line, the line re-sums around the gap",
  planUndo({
    contributions: [
      { poId: "po-17", amount: 47965 },
      { poId: "po-22", amount: 4480.25 },
    ],
    poId: "po-17",
    createdEntry: false,
    priorPlannedAmount: null,
  }),
  { action: "resum", remaining: [{ poId: "po-22", amount: 4480.25 }], plannedAmount: 4480.25 },
);

eq(
  "the last PO off a row the staging created takes the row with it",
  planUndo({
    contributions: [{ poId: "po-17", amount: 47965 }],
    poId: "po-17",
    createdEntry: true,
    priorPlannedAmount: null,
  }),
  { action: "delete_entry" },
);

eq(
  "the last PO off a row that predates it restores what it displaced",
  planUndo({
    contributions: [{ poId: "po-17", amount: 47965 }],
    poId: "po-17",
    createdEntry: false,
    priorPlannedAmount: 23982.5,
  }),
  { action: "restore", plannedAmount: 23982.5 },
);

check(
  "an imported forecast is never deleted by an undo",
  planUndo({
    contributions: [{ poId: "po-17", amount: 47965 }],
    poId: "po-17",
    createdEntry: false,
    priorPlannedAmount: 8095.95,
  }).action !== "delete_entry",
);

eq(
  "a row that predates the staging but carried nothing restores to zero",
  planUndo({
    contributions: [{ poId: "po-17", amount: 47965 }],
    poId: "po-17",
    createdEntry: false,
    priorPlannedAmount: null,
  }),
  { action: "restore", plannedAmount: 0 },
);

eq(
  "undoing a PO that is not on the line leaves every other one alone",
  planUndo({
    contributions: [{ poId: "po-17", amount: 47965 }],
    poId: "po-99",
    createdEntry: false,
    priorPlannedAmount: null,
  }),
  { action: "resum", remaining: [{ poId: "po-17", amount: 47965 }], plannedAmount: 47965 },
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
