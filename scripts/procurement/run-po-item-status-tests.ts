/**
 * Each item's status on a PO, read off the schedule row it lands on.
 */

import { poItemStatus } from "../../src/lib/po-item-status";

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

const today = "2026-10-22";
const row = (status: string | null, pct: number | null, end: string | null) => ({
  wbsCode: "4.4.9.2",
  status,
  pctComplete: pct,
  endDate: end,
});

eq(
  "a Complete row is delivered on its finish",
  poItemStatus(row("Complete", 100, "2026-09-30"), today),
  { kind: "delivered", label: "Delivered Sep 30, 2026" },
);
eq(
  "100% without the Complete status still counts as delivered",
  poItemStatus(row("In Progress", 100, "2026-10-06"), today).kind,
  "delivered",
);
eq(
  "an open row past its finish is late",
  poItemStatus(row("Not Started", 0, "2026-10-21"), today),
  { kind: "late", label: "Late, planned Oct 21, 2026" },
);
eq(
  "an open row finishing today is due, not late",
  poItemStatus(row("Not Started", 0, "2026-10-22"), today).kind,
  "due",
);
eq(
  "an open row ahead of its finish is due on it",
  poItemStatus(row(null, null, "2026-11-04"), today),
  { kind: "due", label: "Due Nov 4, 2026" },
);
eq(
  "an open row with no finish says not delivered",
  poItemStatus(row("Not Started", 0, null), today),
  { kind: "due", label: "Not delivered" },
);
eq(
  "no schedule row says so rather than guessing",
  poItemStatus(null, today),
  { kind: "unlinked", label: "No schedule row" },
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
