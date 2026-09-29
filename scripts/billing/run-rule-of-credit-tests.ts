/**
 * The rule of credit on a SOV line.
 *
 * Zarina, on 6.03 Fencing/SWPPP: "Please update this recommended rules of
 * credit on what to bill to owner. Recommended rules of credit: SWPPP at 30%,
 * rest is fence."
 *
 * The tasks below are the real 6.03 links, with the crew and duration basis
 * from the August manhour study.
 */

import {
  applyRuleOfCredit,
  describeRuleOfCredit,
  parseRuleOfCredit,
  type RuleOfCreditTask,
} from "../../src/lib/rule-of-credit";

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

function close(name: string, actual: number, expected: number, tol = 1e-6) {
  eq(name, Math.abs(actual - expected) < tol, true);
  if (Math.abs(actual - expected) >= tol) {
    failures[failures.length - 1] = `${name} - got ${actual}, want ${expected}`;
  }
}

const SWEET_SPRINGS = {
  note: "SWPPP 30%, fence the remainder.",
  components: [
    { name: "Fence", weightPct: 70, match: ["fencing installation"] },
    { name: "SWPPP", weightPct: 30, match: [] as string[] },
  ],
};

console.log("\nParsing\n");

eq("a well formed rule parses", parseRuleOfCredit(SWEET_SPRINGS) !== null, true);
eq("null is not a rule", parseRuleOfCredit(null), null);
eq("no components is not a rule", parseRuleOfCredit({ components: [] }), null);

// The whole reason parsing is strict. A rule that does not sum to 100 would
// bill a line at a percentage of a percentage and say nothing about it.
eq(
  "weights that do not sum to 100 are refused",
  parseRuleOfCredit({
    components: [
      { name: "Fence", weightPct: 70, match: ["fencing"] },
      { name: "SWPPP", weightPct: 25, match: [] },
    ],
  }),
  null,
);
eq(
  "weights that sum to more than 100 are refused",
  parseRuleOfCredit({
    components: [
      { name: "A", weightPct: 70, match: ["a"] },
      { name: "B", weightPct: 70, match: [] },
    ],
  }),
  null,
);
// Two remainders means the second silently claims nothing.
eq(
  "two remainder components are refused",
  parseRuleOfCredit({
    components: [
      { name: "A", weightPct: 50, match: [] },
      { name: "B", weightPct: 50, match: [] },
    ],
  }),
  null,
);
eq(
  "a negative weight is refused",
  parseRuleOfCredit({
    components: [
      { name: "A", weightPct: -10, match: ["a"] },
      { name: "B", weightPct: 110, match: [] },
    ],
  }),
  null,
);
eq(
  "a nameless component is refused",
  parseRuleOfCredit({
    components: [
      { name: "  ", weightPct: 50, match: ["a"] },
      { name: "B", weightPct: 50, match: [] },
    ],
  }),
  null,
);
eq(
  "a rule with no remainder is allowed when every scope names itself",
  parseRuleOfCredit({
    components: [
      { name: "A", weightPct: 50, match: ["alpha"] },
      { name: "B", weightPct: 50, match: ["beta"] },
    ],
  }) !== null,
  true,
);

eq("the one-line label reads in order", describeRuleOfCredit(parseRuleOfCredit(SWEET_SPRINGS)!), "Fence 70% / SWPPP 30%");

console.log("\n6.03 Fencing/SWPPP\n");

const rule = parseRuleOfCredit(SWEET_SPRINGS)!;

/** The real 6.03 links. pct is 0-1. */
const tasks = (escPct: number, fencePct: number): RuleOfCreditTask[] => [
  { wbsCode: "5.1.1.1", taskName: "Partition off Limits of Disturbance", pct: escPct, durationDays: 2 },
  { wbsCode: "5.1.1.5", taskName: "Silt/Rock Fence Install", pct: escPct, durationDays: 1 },
  { wbsCode: "5.1.1.6", taskName: "Construct Basin 1 ESC", pct: escPct, durationDays: 7 },
  { wbsCode: "5.1.1.7", taskName: "Construct Basin 2 ESC", pct: escPct, durationDays: 7 },
  { wbsCode: "5.1.2", taskName: "Fencing Installation", pct: fencePct, durationDays: 4 },
  { wbsCode: "5.1.3.5", taskName: "Basin 1 Final Grading / Stab / Seed", pct: escPct, durationDays: 2 },
  { wbsCode: "5.1.3.6", taskName: "Basin 2 Final Grading / Stab / Seed", pct: escPct, durationDays: 2 },
  { wbsCode: "5.1.3.7", taskName: "Convert Basins to Stormwater Ponds", pct: escPct, durationDays: 6 },
  { wbsCode: "5.1.3.8", taskName: "Permanent Seeding", pct: escPct, durationDays: 2 },
];

// The pattern is "fencing installation" and NOT "fence", precisely so the
// silt fence stays in SWPPP. A looser pattern hands 70% of a $203,835.79 line
// to a one-day silt fence, which is the trap this test exists to hold shut.
const split = applyRuleOfCredit({ rule, tasks: tasks(0.5, 0) });
eq("the permanent fence is the only task in Fence", split.components[0].tasks.map((t) => t.wbsCode), ["5.1.2"]);
eq("silt fence stays in SWPPP", split.components[1].tasks.some((t) => t.wbsCode === "5.1.1.5"), true);
eq("every other task lands in SWPPP", split.components[1].tasks.length, 8);

// SWPPP at 54%, the reading Dimension used, fence not started.
const atCT = applyRuleOfCredit({ rule, tasks: tasks(0.54, 0) });
close("SWPPP 54% and no fence earns 16.2% of the line", atCT.pct, 0.162);
close("a $203,835.79 line earns $33,021.40", Math.round(203835.79 * atCT.pct * 100) / 100, 33021.4);

// The end state: both scopes complete is the whole line, every time.
close("both complete is 100%", applyRuleOfCredit({ rule, tasks: tasks(1, 1) }).pct, 1);
close("neither started is 0%", applyRuleOfCredit({ rule, tasks: tasks(0, 0) }).pct, 0);
// Fence alone is 70 whatever the ESC durations are. That is the point of the
// rule: duration decides nothing across scopes.
close("the fence alone is 70% of the line", applyRuleOfCredit({ rule, tasks: tasks(0, 1) }).pct, 0.7);
close("SWPPP alone is 30% of the line", applyRuleOfCredit({ rule, tasks: tasks(1, 0) }).pct, 0.3);

// What it replaces. Duration weighting over the same nine tasks puts the
// four-day fence against 29 ESC days, so the fence is worth 12% of the line
// rather than 70%. Same evidence, wildly different bill.
const durationFence = 4 / 33;
eq(
  "duration weighting would value the fence far below the rule",
  Math.round(durationFence * 1000) / 10 < 70,
  true,
);

console.log("\nSaying what happened\n");

const done = applyRuleOfCredit({ rule, tasks: tasks(0.54, 0) });
eq(
  "the reason names both scopes, their progress and their weight",
  done.reason,
  "Rule of credit: Fence is 0% done and carries 70%, SWPPP is 54% done and carries 30%, so the line has earned 16.2%",
);

// A component matching nothing earns zero at full weight, which is right, and
// is named, because "the pattern no longer matches" looks identical from the
// number alone.
const noFence = applyRuleOfCredit({
  rule,
  tasks: tasks(1, 1).filter((t) => t.wbsCode !== "5.1.2"),
});
eq("a component with no task is named", noFence.emptyComponents, ["Fence"]);
close("and earns nothing at its full weight", noFence.pct, 0.3);
eq("the reason says it has no linked task", noFence.reason.includes("Fence has no linked task"), true);

// No remainder and a task nobody claims. The task is dropped rather than
// guessed at, and the count is said out loud.
const strict = parseRuleOfCredit({
  components: [
    { name: "A", weightPct: 50, match: ["alpha"] },
    { name: "B", weightPct: 50, match: ["beta"] },
  ],
})!;
const orphan = applyRuleOfCredit({
  rule: strict,
  tasks: [
    { wbsCode: "1", taskName: "Alpha work", pct: 1, durationDays: 1 },
    { wbsCode: "2", taskName: "Beta work", pct: 1, durationDays: 1 },
    { wbsCode: "3", taskName: "Gamma work", pct: 1, durationDays: 1 },
  ],
});
close("the claimed scopes still earn in full", orphan.pct, 1);
eq("and the unclaimed task is counted in the reason", orphan.reason.includes("1 linked task(s) match no scope"), true);

console.log("\nInside a component\n");

// Duration weighting still applies WITHIN a scope, because eight ESC tasks
// are one scope and how long each takes is a fair proxy for how much of it
// they are. A seven-day basin counts more than a one-day silt fence.
const partial = applyRuleOfCredit({
  rule,
  tasks: [
    { wbsCode: "5.1.1.5", taskName: "Silt/Rock Fence Install", pct: 1, durationDays: 1 },
    { wbsCode: "5.1.1.6", taskName: "Construct Basin 1 ESC", pct: 0, durationDays: 7 },
    { wbsCode: "5.1.2", taskName: "Fencing Installation", pct: 0, durationDays: 4 },
  ],
});
close("one of eight days done is 12.5% of SWPPP", partial.components[1].pct, 1 / 8);
close("which is 3.75% of the line at 30%", partial.pct, 0.3 * (1 / 8));

// No durations anywhere degrades to the plain mean inside the scope, never to
// zero.
const noDur = applyRuleOfCredit({
  rule,
  tasks: [
    { wbsCode: "a", taskName: "Basin 1 ESC", pct: 1, durationDays: null },
    { wbsCode: "b", taskName: "Basin 2 ESC", pct: 0, durationDays: null },
    { wbsCode: "c", taskName: "Fencing Installation", pct: 1, durationDays: null },
  ],
});
close("no durations is the plain mean inside the scope", noDur.components[1].pct, 0.5);
close("and the line is still weighted by the rule", noDur.pct, 0.7 + 0.3 * 0.5);

// Case does not decide whether a line bills.
const upper = applyRuleOfCredit({
  rule,
  tasks: [{ wbsCode: "5.1.2", taskName: "FENCING INSTALLATION (PERMANENT)", pct: 1, durationDays: 4 }],
});
close("matching ignores case", upper.pct, 0.7);

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
