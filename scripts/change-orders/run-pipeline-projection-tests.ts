/**
 * Change orders that are not approved yet, in the cash-flow forecast.
 *
 * Zarina: "Since it is draft, you project it for the next month. For example,
 * we have 2 draft COs, assuming it will be submitted on October, then assume
 * it will be billed on October for AFP14."
 *
 * An approved CO already reaches the forecast through its own SOV line. These
 * rules are about everything before approval, which reached it nowhere.
 */

import {
  isPipelineCo,
  pipelineCoBillingMonth,
  planPipelineCoRevenue,
  describePipelineCo,
} from "../../src/lib/change-order-projection";

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

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

section("Which change orders count");

same("a draft counts", isPipelineCo("draft"), true);
same("internal review counts", isPipelineCo("internal_review"), true);
same(
  "submitted counts - it is MORE likely to be billed, not less",
  isPipelineCo("submitted"),
  true,
);
same(
  "approved does NOT - it is already in the forecast through its SOV line",
  isPipelineCo("approved"),
  false,
);
same("rejected does not", isPipelineCo("rejected"), false);
same("void does not", isPipelineCo("void"), false);
same("nor does a missing status", isPipelineCo(null), false);

section("Which month it bills in");

same(
  "one month after the AFP being assembled - September open means October",
  pipelineCoBillingMonth("2026-09-01"),
  "2026-10-01",
);
same("it rolls the year", pipelineCoBillingMonth("2026-12-01"), "2027-01-01");

section("Zarina's two draft COs");

const TWO_DRAFTS = [
  { co_number: "CO-07", co_value: 48000, status: "draft" },
  { co_number: "CO-08", co_value: 22500, status: "draft" },
];

{
  // September is the open AFP, so these land on AFP 14 in October. No
  // retainage, no payment terms: the plain case first.
  const plan = planPipelineCoRevenue({
    cos: TWO_DRAFTS,
    openPeriodMonth: "2026-09-01",
    ownerRetainagePct: 0,
    ownerTermsDays: 0,
  });
  same("billed in October", plan.month, "2026-10-01");
  same("cash in October too with no terms", plan.cashMonth, "2026-10-01");
  same("both COs are in", plan.entries.length, 2);
  same("totalling $70,500", plan.totalGross, 70500);
  same("and all of it is cash", plan.totalNet, 70500);
}

{
  // The real Sweet Springs shape: 5% retainage, Net 30.
  const plan = planPipelineCoRevenue({
    cos: TWO_DRAFTS,
    openPeriodMonth: "2026-09-01",
    ownerRetainagePct: 0.05,
    ownerTermsDays: 30,
  });
  same("revenue is still recognised in October", plan.month, "2026-10-01");
  same("but Net 30 pushes the cash to November", plan.cashMonth, "2026-11-01");
  same("retainage held is 5%", plan.totalRetainage, 3525);
  same("so cash in is the balance", plan.totalNet, 66975);
}

section("The awkward ones");

same(
  "an approved CO in the list is skipped, not double counted",
  planPipelineCoRevenue({
    cos: [...TWO_DRAFTS, { co_number: "CO-06", co_value: 100000, status: "approved" }],
    openPeriodMonth: "2026-09-01",
    ownerRetainagePct: 0,
    ownerTermsDays: 0,
  }).totalGross,
  70500,
);

same(
  "a time-only CO carries no money and no row",
  planPipelineCoRevenue({
    cos: [{ co_number: "CO-03", co_value: 0, status: "draft" }],
    openPeriodMonth: "2026-09-01",
    ownerRetainagePct: 0.05,
    ownerTermsDays: 0,
  }).entries.length,
  0,
);

{
  // A credit reduces revenue and is real. Negative retainage is not.
  const plan = planPipelineCoRevenue({
    cos: [{ co_number: "CO-09", co_value: -15000, status: "draft" }],
    openPeriodMonth: "2026-09-01",
    ownerRetainagePct: 0.05,
    ownerTermsDays: 0,
  });
  same("a credit CO is counted", plan.totalGross, -15000);
  same("with no retainage held against it", plan.totalRetainage, 0);
  same("so the whole credit hits cash", plan.totalNet, -15000);
}

same(
  "nothing in the pipeline plans nothing",
  planPipelineCoRevenue({
    cos: [{ co_number: "CO-06", co_value: 100000, status: "approved" }],
    openPeriodMonth: "2026-09-01",
    ownerRetainagePct: 0.05,
    ownerTermsDays: 30,
  }).entries.length,
  0,
);

same(
  "a CO with no number still gets a label rather than blank",
  planPipelineCoRevenue({
    cos: [{ co_number: "  ", co_value: 1000, status: "draft" }],
    openPeriodMonth: "2026-09-01",
    ownerRetainagePct: 0,
    ownerTermsDays: 0,
  }).entries[0].coNumber,
  "CO",
);

section("What the forecast says about it");

{
  const line = describePipelineCo(
    { coNumber: "CO-07", status: "draft", gross: 48000, retainage: 0, net: 48000 },
    "2026-10-01",
  );
  same("it names the CO", line.includes("CO-07"), true);
  same("it names the month", line.includes("2026-10"), true);
  same("and it says the money rests on an assumption", /not on an approval/.test(line), true);
}


/* ------------------------------------------------------------------ */
/* The cost side                                                       */
/* ------------------------------------------------------------------ */

// Revenue without cost is not a forecast. Every pipeline CO landed in the
// curve as pure margin, so "Margin at completion" read high by exactly the
// cost of doing the work.

import {
  describePipelineCoCost,
  describeUncostedPipelineCo,
  normalizeCoNumber,
  planPipelineCoCost,
} from "../../src/lib/change-order-projection";

console.log("\nPipeline change order COST\n");

const costCos = [
  { co_number: "CO-05", co_value: 120000, status: "draft" },
  { co_number: "CO-06", co_value: 40000, status: "submitted" },
  { co_number: "CO-07", co_value: 15000, status: "internal_review" },
  { co_number: "CO-04", co_value: 90000, status: "approved" },
  { co_number: "CO-08", co_value: 5000, status: "rejected" },
];

const plan = planPipelineCoCost({
  cos: costCos,
  month: "2026-10-01",
  costAmountByCoNumber: new Map([["CO-05", 94000]]),
  costByCoNumber: new Map([["CO-06", 31500]]),
});

same("only pipeline COs are costed", plan.entries.map((e) => e.coNumber), ["CO-05", "CO-06"]);
same("the CO's own cost is preferred", plan.entries[0].source, "cost_amount");
same("the cost code estimate is the fallback", plan.entries[1].source, "cost_code");
same("the total is what goes in the month", plan.totalCost, 125500);
same("the month is the revenue's month", plan.month, "2026-10-01");

// A CO with revenue and no cost anywhere. Guessing one would be worse than
// naming the hole, so it is named.
same("a CO with no cost is reported, not invented", plan.uncosted, [
  { coNumber: "CO-07", gross: 15000 },
]);

// Zero is "nobody filled this in", not "this is free". Booking it as a real
// zero is how a change order becomes 100% margin in silence.
same(
  "a zero cost_amount falls through to the cost code",
  planPipelineCoCost({
    cos: [{ co_number: "CO-09", co_value: 20000, status: "draft" }],
    month: "2026-10-01",
    costAmountByCoNumber: new Map([["CO-09", 0]]),
    costByCoNumber: new Map([["CO-09", 17000]]),
  }).entries[0].cost,
  17000,
);

same(
  "zero in both places is reported as uncosted",
  planPipelineCoCost({
    cos: [{ co_number: "CO-09", co_value: 20000, status: "draft" }],
    month: "2026-10-01",
    costAmountByCoNumber: new Map([["CO-09", 0]]),
    costByCoNumber: new Map([["CO-09", 0]]),
  }).uncosted.length,
  1,
);

// A zero-value CO is a time-only change. It moves a date, not cash, and
// planPipelineCoRevenue already drops it - so the cost side must too.
same(
  "a time-only CO is neither costed nor reported",
  planPipelineCoCost({
    cos: [{ co_number: "CO-10", co_value: 0, status: "draft" }],
    month: "2026-10-01",
    costByCoNumber: new Map(),
  }),
  { month: "2026-10-01", entries: [], uncosted: [], totalCost: 0 },
);

// Revenue and cost must key COs the same way or a cost silently misses its
// change order and the CO reads as pure margin.
same("CO 5 keys as CO-05", normalizeCoNumber("CO 5"), "CO-05");
same("co-5 keys as CO-05", normalizeCoNumber("co-5"), "CO-05");
same("CO-05 keys as itself", normalizeCoNumber("CO-05"), "CO-05");
same("a number with no digits falls back to the text", normalizeCoNumber("pending"), "PENDING");

same(
  "a cost keyed loosely still finds its CO",
  planPipelineCoCost({
    cos: [{ co_number: "CO-5", co_value: 120000, status: "draft" }],
    month: "2026-10-01",
    costByCoNumber: new Map([["CO-05", 94000]]),
  }).entries[0].cost,
  94000,
);

same(
  "the cost line names where the number came from",
  describePipelineCoCost(plan.entries[0], "2026-10-01").includes("change order's own cost"),
  true,
);
same(
  "and the fallback says so too",
  describePipelineCoCost(plan.entries[1], "2026-10-01").includes("estimate on its cost code"),
  true,
);
same(
  "an uncosted CO says the margin is overstated",
  describeUncostedPipelineCo(plan.uncosted[0]).includes("margin at completion is high"),
  true,
);
same(
  "and names the CO and the money",
  describeUncostedPipelineCo(plan.uncosted[0]).includes("CO-07") &&
    describeUncostedPipelineCo(plan.uncosted[0]).includes("15,000"),
  true,
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
