/**
 * The billed-items ledger: which PO items can still go on this period's AFP.
 */

import {
  blockedItems,
  canBillItem,
  itemBillingState,
  itemBillingStates,
} from "../../src/lib/po-item-ledger";

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

const OCT = "2026-10-01";
const SEP = "2026-09-01";

eq("an item never staged is open", itemBillingState([], OCT), { kind: "open" });
eq(
  "an item on a submitted AFP is billed, by number",
  itemBillingState([{ itemId: "a", periodMonth: SEP, billed: true, afpNumber: "13" }], OCT),
  { kind: "billed", label: "Billed on AFP 13" },
);
eq(
  "billed without an AFP number names the month",
  itemBillingState([{ itemId: "a", periodMonth: SEP, billed: true, afpNumber: null }], OCT),
  { kind: "billed", label: "Billed September 2026" },
);
eq(
  "staged for this period is the PO's own figure and stays tickable",
  canBillItem(
    itemBillingState([{ itemId: "a", periodMonth: OCT, billed: false, afpNumber: null }], OCT),
  ),
  true,
);
eq(
  "staged for another period and never billed is blocked",
  itemBillingState([{ itemId: "a", periodMonth: SEP, billed: false, afpNumber: null }], OCT),
  { kind: "staged_elsewhere", label: "Staged for September 2026, not on an AFP yet" },
);
eq(
  "billed beats a later forecast naming the same item",
  itemBillingState(
    [
      { itemId: "a", periodMonth: OCT, billed: false, afpNumber: null },
      { itemId: "a", periodMonth: SEP, billed: true, afpNumber: "13" },
    ],
    OCT,
  ).kind,
  "billed",
);

const states = itemBillingStates(
  [
    { itemId: "billed", periodMonth: SEP, billed: true, afpNumber: "13" },
    { itemId: "mine", periodMonth: OCT, billed: false, afpNumber: null },
    { itemId: "stale", periodMonth: SEP, billed: false, afpNumber: null },
  ],
  OCT,
);
eq(
  "the server check names only the items that cannot be billed",
  blockedItems(["billed", "mine", "stale", "fresh"], states).map((b) => b.itemId),
  ["billed", "stale"],
);
eq("nothing blocked when every tick is allowed", blockedItems(["mine", "fresh"], states), []);

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
