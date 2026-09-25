/**
 * The retainage rate on a subcontract.
 *
 * Zarina: "Can you add option to add retainage to subs SOVs."
 */

import {
  describeRetainageRate,
  parseRetainageRate,
  retainageOn,
} from "../../src/lib/retainage-rate";

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

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

console.log("\nReading a typed rate\n");

eq("a plain number", parseRetainageRate("10"), 10);
eq("a percent sign is stripped", parseRetainageRate("10%"), 10);
eq("spaces are stripped", parseRetainageRate("  10 % "), 10);
eq("a decimal survives", parseRetainageRate("7.5"), 7.5);
eq("a third decimal rounds to two", parseRetainageRate("7.555"), 7.56);
eq("zero is a real rate, not blank", parseRetainageRate("0"), 0);
eq("the top of the range is allowed", parseRetainageRate("100"), 100);

// Blank is not zero. Tabbing through the box must not write a hard 0 over a
// subcontract that retains 10%.
eq("blank is not stated", parseRetainageRate(""), null);
eq("whitespace is not stated", parseRetainageRate("   "), null);
eq("absent is not stated", parseRetainageRate(null), null);
eq("undefined is not stated", parseRetainageRate(undefined), null);

eq("a negative rate is a typo", parseRetainageRate("-5"), "invalid");
eq("over 100 is a typo", parseRetainageRate("105"), "invalid");
eq("letters are a typo", parseRetainageRate("ten"), "invalid");
eq("a bare percent sign is a typo", parseRetainageRate("%"), "invalid");

console.log("\nWhat the rate holds back\n");

eq("ten percent of the Lumina SOV", retainageOn(481983.11, 10), 48198.31);
eq("five percent", retainageOn(481983.11, 5), 24099.16);
eq("zero holds nothing", retainageOn(481983.11, 0), 0);
eq("a rate on nothing is nothing", retainageOn(0, 10), 0);
eq("a bad amount is nothing, never NaN", retainageOn(Number.NaN, 10), 0);
eq("a bad rate is nothing, never NaN", retainageOn(100, Number.NaN), 0);

console.log("\nWhat the screen says\n");

eq(
  "zero says so plainly, because it is the case that surprises people",
  describeRetainageRate(0, 481983.11, money),
  "Nothing is held back. Every approved dollar goes out in full.",
);
eq(
  "a rate with an SOV prices itself",
  describeRetainageRate(10, 481983.11, money),
  "10% held back, $48,198.31 across the full $481,983.11 SOV.",
);
eq(
  "a rate with no SOV loaded yet still reads",
  describeRetainageRate(10, 0, money),
  "10% of each approved bill is held back.",
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
