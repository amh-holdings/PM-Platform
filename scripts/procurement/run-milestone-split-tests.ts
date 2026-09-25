/**
 * The % and the Amount on a payment milestone.
 *
 * Zarina: "if I write here the % amount it should calculate automatically."
 * Every number below is off the PO she was looking at, $47,965.00.
 */

import {
  amountFromPct,
  pctFromAmount,
  splitAgrees,
} from "../../src/lib/milestone-split";

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

const PO = 47965;

console.log("\nA percentage becomes an amount\n");

// The exact case she reported.
eq("50% of her PO", amountFromPct(PO, 50), 23982.5);
eq("40% deposit", amountFromPct(PO, 40), 19186);
eq("60% balance", amountFromPct(PO, 60), 28779);
eq("and the two halves of a 40/60 come back to the PO",
  amountFromPct(PO, 40)! + amountFromPct(PO, 60)!, PO);
eq("100% is the whole order", amountFromPct(PO, 100), PO);
eq("a third rounds to the cent", amountFromPct(PO, 33.33), 15986.73);
eq("zero percent is zero, not nothing", amountFromPct(PO, 0), 0);

console.log("\nAn amount becomes a percentage\n");

eq("half the PO reads as 50%", pctFromAmount(PO, 23982.5), 50);
eq("the deposit reads as 40%", pctFromAmount(PO, 19186), 40);
eq("a rounded-up amount tells the truth", pctFromAmount(PO, 24000), 50.04);
eq("the whole order is 100%", pctFromAmount(PO, PO), 100);
eq("zero dollars is zero percent", pctFromAmount(PO, 0), 0);

console.log("\nWhen nothing can be derived\n");

// Dividing by an unset PO value, or multiplying by it, both give zero, and
// zero is a real amount somebody could mean.
eq("no PO value, no amount", amountFromPct(0, 50), null);
eq("no PO value, no percentage", pctFromAmount(0, 1000), null);
eq("a negative PO value is not a PO value", amountFromPct(-100, 50), null);
eq("a blank percentage derives nothing", amountFromPct(PO, null), null);
eq("a blank amount derives nothing", pctFromAmount(PO, null), null);
eq("NaN in, null out", amountFromPct(PO, Number.NaN), null);
eq("NaN amount in, null out", pctFromAmount(PO, Number.NaN), null);

console.log("\nWhether the two figures agree\n");

eq("50 and half the PO agree", splitAgrees(PO, 50, 23982.5), true);
eq(
  "50 and the FULL PO do not, which is the bug she caught",
  splitAgrees(PO, 50, PO),
  false,
);
eq(
  "a cent of rounding is not a disagreement",
  splitAgrees(PO, 33.33, 15986.74),
  true,
);
eq("a dollar out is a disagreement", splitAgrees(PO, 50, 23983.5), false);
eq("nothing to compare against agrees", splitAgrees(PO, null, 1000), true);
eq("no amount yet agrees", splitAgrees(PO, 50, null), true);
eq("no PO value, nothing to check", splitAgrees(0, 50, 1000), true);

console.log("\nRound trips\n");

for (const pct of [10, 25, 33.33, 40, 50, 60, 75, 100]) {
  const back = pctFromAmount(PO, amountFromPct(PO, pct));
  eq(`${pct}% survives a round trip`, Math.abs(back! - pct) < 0.01, true);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
