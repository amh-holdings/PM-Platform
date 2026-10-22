/**
 * The billed-items ledger: which PO items can still go on this period's AFP.
 */

import {
  blockedItems,
  canBillItem,
  itemBillingState,
  itemBillingStates,
  poBillingPosition,
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


// What the PO has already billed, and how much of it covered every item.
const half = poBillingPosition({
  poTotal: 47339.72,
  contributions: [{ entryId: "e13", amount: 23669.86, periodMonth: SEP, billed: true }],
  itemEntryIds: [],
  periodMonth: OCT,
});
eq("half the PO billed PO-wide is half of every item", half.billedFraction, 0.5);
eq("and leaves the other half on the PO", half.remaining, 23669.86);
const mine = poBillingPosition({
  poTotal: 1000,
  contributions: [{ entryId: "eOct", amount: 500, periodMonth: OCT, billed: false }],
  itemEntryIds: [],
  periodMonth: OCT,
});
eq(
  "this period's own staged figure is not counted against itself",
  [mine.billedFraction, mine.remaining],
  [0, 1000],
);
const mixed = poBillingPosition({
  poTotal: 1000,
  contributions: [
    { entryId: "eSep", amount: 500, periodMonth: SEP, billed: true },
    { entryId: "eAug", amount: 200, periodMonth: "2026-08-01", billed: true },
    { entryId: "eNov", amount: 100, periodMonth: "2026-11-01", billed: false },
  ],
  itemEntryIds: ["eAug"],
  periodMonth: OCT,
});
eq(
  "item-specific billing is left out of the PO-wide share",
  [mixed.poWide, mixed.billedFraction],
  [600, 0.6],
);
eq(
  "but everything billed or staged elsewhere comes off what is left",
  [mixed.billedToDate, mixed.stagedElsewhere, mixed.remaining],
  [700, 100, 200],
);
eq(
  "an over-billed PO leaves nothing, never a negative",
  poBillingPosition({
    poTotal: 100,
    contributions: [{ entryId: "e", amount: 150, periodMonth: SEP, billed: true }],
    itemEntryIds: [],
    periodMonth: OCT,
  }).remaining,
  0,
);


eq(
  "each application the PO is on is named, oldest first",
  poBillingPosition({
    poTotal: 1000,
    contributions: [
      { entryId: "eNov", amount: 100, periodMonth: "2026-11-01", billed: false },
      { entryId: "eSep", amount: 300, periodMonth: SEP, billed: true, afpNumber: "13" },
      { entryId: "eSep2", amount: 200, periodMonth: SEP, billed: true, afpNumber: "13" },
      { entryId: "eAug", amount: 50, periodMonth: "2026-08-01", billed: true, afpNumber: null },
    ],
    itemEntryIds: [],
    periodMonth: OCT,
  }).byApplication,
  [
    { label: "Billed August 2026", amount: 50, billed: true },
    { label: "AFP 13 (September 2026)", amount: 500, billed: true },
    { label: "Staged for November 2026", amount: 100, billed: false },
  ],
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
