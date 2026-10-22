/**
 * The PO and equipment sub-rows under a procurement line on the Bill this
 * period panel. Run: npm run test:bill-po-detail
 */

import { buildPoBillDetail, splitByValue } from "../../src/lib/bill-po-detail";
import { amountForPoItems } from "../../src/lib/billing-progress";

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

const item = (id: string, ext: number | null, deliveredOn: string | null = null) => ({
  id,
  description: id.toUpperCase(),
  quantity: 1,
  units: "EA",
  unitPrice: null,
  extendedPrice: ext,
  deliveredOn,
});

const PO = (id: string) => ({
  label: id === "po-19" ? "PO-019" : "PO-017",
  vendor: id === "po-19" ? "Grid Power Solutions" : "GroundWork",
  total: id === "po-19" ? 33074.52 : 47965,
});

console.log("splitByValue");
eq("splits by value", splitByValue(100, [1, 3]), [25, 75]);
eq("shares add to the cent", (() => {
  const s = splitByValue(8268.63, [3, 3, 3]);
  return Math.round(s.reduce((a, b) => a + b, 0) * 100) / 100;
})(), 8268.63);
eq("no values splits evenly", splitByValue(10, [0, 0]), [5, 5]);
eq("nothing to split", splitByValue(10, []), []);

console.log("buildPoBillDetail");
const itemsByPo = new Map([
  ["po-19", [item("goab", 6000, "2026-09-12"), item("arresters", 2000, "2026-09-12"), item("mpc", 8000)]],
  ["po-17", [item("met", 47965, "2026-08-20")]],
]);

const [gps] = buildPoBillDetail({
  entryId: "oct",
  contributions: [{ poId: "po-19", amount: 4000 }],
  po: PO,
  itemsByPo,
  tickedIds: new Set(["goab", "arresters"]),
  earlier: [
    { poId: "po-19", entryId: "sep", amount: 16537.26, billed: true, afpNumber: "13" },
    { poId: "po-19", entryId: "nov", amount: 500, billed: false, afpNumber: null },
    { poId: "po-19", entryId: "oct", amount: 4000, billed: false, afpNumber: null },
  ],
});
eq("ticked items only, in PO order", gps.items.map((i) => i.id), ["goab", "arresters"]);
eq("amount split across ticked items by value", gps.items.map((i) => i.share), [3000, 1000]);
eq("unticked items counted", gps.otherItemCount, 1);
eq("delivery carried through", gps.items[0].deliveredOn, "2026-09-12");
eq("only billed entries count as earlier billing", gps.billedEarlier, 16537.26);
eq("earlier AFPs named", gps.earlierAfps, ["13"]);
eq("items recorded", gps.itemsRecorded, true);

const [whole] = buildPoBillDetail({
  entryId: "oct",
  contributions: [{ poId: "po-17", amount: 23982.5 }],
  po: PO,
  itemsByPo,
  tickedIds: new Set(),
  earlier: [],
});
eq("nothing ticked reads as a whole-PO figure", whole.itemsRecorded, false);
eq("nothing ticked lists no items", whole.items.length, 0);

console.log("matches Add to AFP pricing");
// Ticked items priced the way Add to AFP prices them, then split back out:
// each item lands on its own value plus its share of tax, less what was
// already billed.
const priced = amountForPoItems({
  items: [
    { id: "goab", quantity: 1, unitPrice: null, extendedPrice: 6000 },
    { id: "arresters", quantity: 1, unitPrice: null, extendedPrice: 2000 },
    { id: "mpc", quantity: 1, unitPrice: null, extendedPrice: 8000 },
  ],
  selectedIds: ["goab", "arresters"],
  salesTax: 800,
  freight: 0,
  billedFraction: 0.5,
});
const [split] = buildPoBillDetail({
  entryId: "oct",
  contributions: [{ poId: "po-19", amount: priced.total }],
  po: PO,
  itemsByPo,
  tickedIds: new Set(["goab", "arresters"]),
  earlier: [],
});
eq("Add to AFP total", priced.total, 4200);
eq("per-item shares match per-item pricing", split.items.map((i) => i.share), [3150, 1050]);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
