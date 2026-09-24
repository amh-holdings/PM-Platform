/**
 * The amount box on the Bill this period panel, on its way onto an AFP.
 *
 * Both of these decide what the owner gets invoiced, and both used to sit
 * inline in a server action where nothing could reach them.
 */

import {
  forecastAmountPatch,
  pairForecastAmounts,
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

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
