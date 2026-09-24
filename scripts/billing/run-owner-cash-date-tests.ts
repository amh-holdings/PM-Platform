/**
 * The month owner money actually reaches the bank.
 *
 * The forecast computed this one way for every entry, period month plus Net
 * terms, which is right for an unpaid AFP and wrong for a paid one. AFP 11 was
 * paid on a day that happened and the curve still drew it where Net 30 put it.
 * pay_applications.paid_at was already in the database; nothing read it.
 */

import {
  describeOwnerCashMove,
  describeOwnerCashMoveCount,
  ownerCashMonth,
} from "../../src/lib/billing-cash-date";

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

function check(name: string, cond: boolean) {
  same(name, cond, true);
}

console.log("\nUnpaid entries keep the terms forecast\n");

same(
  "Net 30 on August work lands in September",
  ownerCashMonth({ periodMonth: "2026-08-01", ownerTermsDays: 30 }),
  { month: "2026-09-01", source: "terms", paidOn: null, supersedes: null },
);

same(
  "Net 60 lands two months out",
  ownerCashMonth({ periodMonth: "2026-08-01", ownerTermsDays: 60 }).month,
  "2026-10-01",
);

same(
  "no terms on the project means the work month",
  ownerCashMonth({ periodMonth: "2026-08-01", ownerTermsDays: 0 }),
  { month: "2026-08-01", source: "period", paidOn: null, supersedes: null },
);

console.log("\nA payment that happened wins\n");

// AFP 11: August work, Net 30 would say September, actually paid 9/16. Same
// month here, so there is nothing to report - the fix is invisible and that
// is correct.
same(
  "a payment inside the terms month changes nothing and reports nothing",
  ownerCashMonth({
    periodMonth: "2026-08-01",
    payAppPaidAt: "2026-09-16T14:02:00.000Z",
    ownerTermsDays: 30,
  }),
  { month: "2026-09-01", source: "paid", paidOn: "2026-09-16", supersedes: null },
);

// The case the fix exists for: the owner paid late, so the money is really a
// month further out than the contract says.
same(
  "a late payment moves the money and says which month it left",
  ownerCashMonth({
    periodMonth: "2026-08-01",
    payAppPaidAt: "2026-10-09",
    ownerTermsDays: 30,
  }),
  { month: "2026-10-01", source: "paid", paidOn: "2026-10-09", supersedes: "2026-09-01" },
);

same(
  "an early payment moves it the other way just as happily",
  ownerCashMonth({
    periodMonth: "2026-08-01",
    payAppPaidAt: "2026-08-20",
    ownerTermsDays: 30,
  }),
  { month: "2026-08-01", source: "paid", paidOn: "2026-08-20", supersedes: "2026-09-01" },
);

// Net 30 describes when the owner is EXPECTED to pay. Once they have paid,
// adding the terms on top would push real money into the future.
same(
  "terms are not applied on top of a payment date",
  ownerCashMonth({
    periodMonth: "2026-08-01",
    payAppPaidAt: "2026-10-09",
    ownerTermsDays: 60,
  }).month,
  "2026-10-01",
);

same(
  "the entry's own paid date beats the pay application's",
  ownerCashMonth({
    periodMonth: "2026-08-01",
    entryPaidAt: "2026-09-02",
    payAppPaidAt: "2026-10-09",
    ownerTermsDays: 30,
  }).paidOn,
  "2026-09-02",
);

console.log("\nA person beats everything\n");

same(
  "cash_in_month outranks a payment date",
  ownerCashMonth({
    periodMonth: "2026-08-01",
    cashInMonth: "2026-12-01",
    payAppPaidAt: "2026-10-09",
    ownerTermsDays: 30,
  }),
  { month: "2026-12-01", source: "override", paidOn: null, supersedes: null },
);

same(
  "an override given as a mid-month date still keys the month",
  ownerCashMonth({ periodMonth: "2026-08-01", cashInMonth: "2026-12-19", ownerTermsDays: 30 }).month,
  "2026-12-01",
);

console.log("\nBad dates do not become months\n");

same(
  "an empty paid date is no paid date",
  ownerCashMonth({ periodMonth: "2026-08-01", payAppPaidAt: "", ownerTermsDays: 30 }).source,
  "terms",
);

same(
  "a malformed paid date is refused rather than parsed",
  ownerCashMonth({ periodMonth: "2026-08-01", payAppPaidAt: "not a date", ownerTermsDays: 30 }).source,
  "terms",
);

console.log("\nWhat it says on screen\n");

const moved = ownerCashMonth({
  periodMonth: "2026-08-01",
  payAppPaidAt: "2026-10-09",
  ownerTermsDays: 30,
});
const line = describeOwnerCashMove({ label: "AFP 11", at: moved });
check("the line names the AFP", line.includes("AFP 11"));
check("the line names the day it was paid", line.includes("2026-10-09"));
check("the line names the month it moved to", line.includes("2026-10"));
check("the line names the month the terms gave", line.includes("2026-09"));

same(
  "one reads as one",
  describeOwnerCashMoveCount(1),
  "1 payment received lands on its real date, not its terms date",
);
check("several read as several", describeOwnerCashMoveCount(3).startsWith("3 payments"));

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
