/**
 * Business development math: win rate, weighted pipeline, follow-up queue.
 *
 * Run: npx tsx scripts/bd/run-bd-tests.ts
 */

import {
  addDays,
  dollarsPerWatt,
  firstBidDateByOpp,
  latestBidByOpp,
  lossReasonMix,
  medianCycleDays,
  needsOutcome,
  pipeline,
  queueBucket,
  winRate,
  type BidLite,
  type OppLite,
} from "../../src/lib/bd";

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

const opp = (id: string, stage: string, extra: Partial<OppLite> = {}): OppLite => ({
  id,
  stage,
  owner_id: null,
  company_id: "c1",
  est_value: null,
  probability_pct: null,
  size_mw_dc: null,
  next_follow_up_date: "2026-10-20",
  expected_decision_date: null,
  outcome_date: null,
  loss_reason: null,
  ...extra,
});
const bid = (opportunity_id: string, submitted_on: string, price: number, created_at = ""): BidLite => ({
  opportunity_id,
  submitted_on,
  price,
  equipment_basis: "epc_furnished",
  created_at,
});

// Revisions: the latest one is the price of record.
const bids = [
  bid("won1", "2026-03-01", 9_000_000),
  bid("won1", "2026-04-01", 8_500_000), // BAFO - this one counts
  bid("lost1", "2026-05-01", 6_000_000),
  bid("lost2", "2026-05-01", 4_000_000, "2026-05-01T10:00"),
  bid("lost2", "2026-05-01", 3_900_000, "2026-05-01T15:00"), // same day, entered later
  bid("open1", "2026-09-01", 10_000_000),
];
const latest = latestBidByOpp(bids);
eq("latest revision by date", latest.get("won1")?.price, 8_500_000);
eq("same-day tie goes to later entry", latest.get("lost2")?.price, 3_900_000);

const opps = [
  opp("won1", "won", { outcome_date: "2026-05-15" }),
  opp("lost1", "lost", { loss_reason: "price", outcome_date: "2026-06-01" }),
  opp("lost2", "lost", { loss_reason: "price", outcome_date: "2026-06-10" }),
  opp("lost3", "lost", { loss_reason: "schedule" }), // no bid on file
  opp("nobid", "no_bid"),
  opp("dead", "dead"),
  opp("open1", "submitted"), // 35% default
  opp("open2", "lead", { est_value: 5_000_000, probability_pct: 50 }),
];

const wr = winRate(opps, latest);
eq("count rate excludes no-bid and dead", [wr.won, wr.lost], [1, 3]);
eq("count rate", wr.rateCount, 0.25);
eq("$ rate leaves out decided jobs with no bid", [wr.wonDollars, wr.decidedDollars], [8_500_000, 18_400_000]);

const p = pipeline(opps, latest);
eq("pipeline counts open only", p.count, 2);
eq("pipeline total uses bid else estimate", p.total, 15_000_000);
eq("weighted uses override else stage default", p.weighted, 10_000_000 * 0.35 + 5_000_000 * 0.5);

eq("loss mix", lossReasonMix(opps), [
  { reason: "price", count: 2 },
  { reason: "schedule", count: 1 },
]);
eq("median cycle days from first bid", medianCycleDays(opps, firstBidDateByOpp(bids)), 40); // 31, 40, 75

eq("queue overdue", queueBucket("2026-10-08", "2026-10-09"), "overdue");
eq("queue today", queueBucket("2026-10-09", "2026-10-09"), "today");
eq("queue this week", queueBucket("2026-10-16", "2026-10-09"), "week");
eq("queue later", queueBucket("2026-10-17", "2026-10-09"), "later");

eq("decision date passed asks for outcome", needsOutcome(opp("x", "submitted", { expected_decision_date: "2026-10-01" }), "2026-10-09"), true);
eq("a lead never asks for an outcome", needsOutcome(opp("x", "lead", { expected_decision_date: "2026-10-01" }), "2026-10-09"), false);
eq("closed never asks", needsOutcome(opp("x", "won", { expected_decision_date: "2026-10-01" }), "2026-10-09"), false);

eq("$/W", dollarsPerWatt(8_500_000, 5), 1.7);
eq("$/W without size", dollarsPerWatt(8_500_000, null), null);
eq("addDays across month", addDays("2026-10-28", 7), "2026-11-04");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
