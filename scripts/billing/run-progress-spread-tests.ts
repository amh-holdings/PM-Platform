/**
 * Percent-complete SOV lines spread across the months their work runs.
 *
 * Sussex 7.02 AC/DC Wire is $814,540 of work on 4.4 Electrical, May 6 to
 * Aug 6 2027. Billed as a lump it all sat in August; billed as completed it
 * follows the days.
 */

import { isProgressBilled, spreadByTaskDays } from "../../src/lib/progress-billing-spread";

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

const sum = (xs: [string, number][]) => Math.round(xs.reduce((s, [, v]) => s + v, 0) * 100) / 100;

// May 6 - Aug 6: 26 + 30 + 31 + 6 = 93 days.
const wire = spreadByTaskDays(814540.21, [{ start_date: "2027-05-06", end_date: "2027-08-06" }]);
eq("wire lands in four months", wire.map(([m]) => m), ["2027-05-01", "2027-06-01", "2027-07-01", "2027-08-01"]);
eq("wire May share is 26 of 93 days", wire[0][1], Math.round((814540.21 * 26) / 93 * 100) / 100);
eq("wire parts add back to the line exactly", sum(wire), 814540.21);

// Two tasks overlapping by five days count those days once.
const overlap = spreadByTaskDays(100, [
  { start_date: "2027-01-01", end_date: "2027-01-10" },
  { start_date: "2027-01-06", end_date: "2027-01-20" },
]);
eq("overlapping days counted once", overlap, [["2027-01-01", 100]]);

const gap = spreadByTaskDays(300, [
  { start_date: "2027-01-31", end_date: "2027-01-31" },
  { start_date: "2027-03-01", end_date: "2027-03-02" },
]);
eq("a gap between tasks bills nothing in the gap", gap, [["2027-01-01", 100], ["2027-03-01", 200]]);

eq("no dated task means no spread", spreadByTaskDays(500, [{ start_date: null, end_date: "2027-01-01" }]), []);
eq("one-day task is one month", spreadByTaskDays(42, [{ start_date: "2027-02-03", end_date: "2027-02-03" }]), [["2027-02-01", 42]]);

eq("progress flag", isProgressBilled({ billing_method: "progress" }), true);
eq("milestone flag", isProgressBilled({ billing_method: "milestone" }), false);
eq("column missing reads as milestone", isProgressBilled({}), false);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
