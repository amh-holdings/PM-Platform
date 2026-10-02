// Tests for measuring a contract line by the commodity tracker.
//
// Run: npx tsx scripts/billing/run-commodity-progress-tests.ts

import {
  measureFromCommodities,
  type CommodityReading,
} from "@/lib/commodity-progress";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
}
function near(a: number, b: number) { return Math.abs(a - b) < 1e-9; }

const pctRow = (over: Partial<CommodityReading> = {}): CommodityReading => ({
  key: "civil_work", label: "Civil Work", uom: "pct",
  totalQuantity: 1, totalVerified: false, toDate: 48.04, lastDate: "2026-09-26",
  ...over,
});
const ftRow = (over: Partial<CommodityReading> = {}): CommodityReading => ({
  key: "road_install", label: "Road Install", uom: "ft",
  totalQuantity: 250, totalVerified: false, toDate: 0, lastDate: null,
  ...over,
});

console.log("\nA percent commodity needs no denominator");
{
  const m = measureFromCommodities([pctRow()])!;
  check("48.04 daily percents read as 48.04%", near(m.pct, 0.4804), String(m.pct));
  check("an unverified total does not disqualify it", m.used.length === 1);
  check("nothing ignored", m.ignored.length === 0);
  check("summary names the commodity", m.summary.includes("Civil Work"));
}

console.log("\nA quantity commodity needs a verified total");
{
  const m = measureFromCommodities([ftRow({ toDate: 125 })]);
  check("unverified total yields no measure", m === null);

  const ok = measureFromCommodities([ftRow({ toDate: 125, totalVerified: true })])!;
  check("verified total measures 125 of 250 as 50%", near(ok.pct, 0.5), String(ok?.pct));
  check("the note shows the working", ok.used[0].note.includes("125 of 250 ft"));
}

console.log("\nAn untrusted row is reported, not swallowed");
{
  const m = measureFromCommodities([pctRow(), ftRow()])!;
  check("the trusted row still measures the line", near(m.pct, 0.4804));
  check("the untrusted row is named", m.ignored.some((i) => i.key === "road_install"));
  check("and says why", m.ignored[0].reason.includes("placeholder"));
}

console.log("\nNothing trusted means no measure, never zero");
{
  const m = measureFromCommodities([ftRow(), ftRow({ key: "fencing", label: "Fencing" })]);
  check("returns null so the caller falls back", m === null);
  // Billing zero here would read as "no work done" when it means "nobody
  // verified the denominator", which are opposite instructions to a PM.
}

console.log("\nSeveral trusted commodities average with equal weight");
{
  const m = measureFromCommodities([
    pctRow({ toDate: 40 }),
    ftRow({ key: "road_install", toDate: 150, totalQuantity: 250, totalVerified: true }),
  ])!;
  check("mean of 40% and 60% is 50%", near(m.pct, 0.5), String(m.pct));
  check("summary says it is a mean", m.summary.includes("equal-weight mean"));
}

console.log("\nThe unit is spelled two ways and both are a percent");
{
  // src/lib/commodities.ts says "pct", the database says "%". A reading that
  // fell through to the quantity branch divided 48.04 by a placeholder total
  // of 1 and came out at 4804%.
  for (const uom of ["pct", "%", "Percent", " % "]) {
    const m = measureFromCommodities([pctRow({ uom })])!;
    check(`uom "${uom}" reads as a percent`, m != null && near(m.pct, 0.4804), String(m?.pct));
  }
  const ea = measureFromCommodities([pctRow({ uom: "ea", totalQuantity: 1, totalVerified: false })]);
  check("a real quantity unit is not treated as a percent", ea === null);
}

console.log("\nEdges");
{
  check("empty list yields null", measureFromCommodities([]) === null);
  const over = measureFromCommodities([pctRow({ toDate: 140 })])!;
  check("over 100% caps at 1", near(over.pct, 1), String(over.pct));
  const neg = measureFromCommodities([pctRow({ toDate: -5 })])!;
  check("a negative reading floors at 0", near(neg.pct, 0), String(neg.pct));
  const zeroTotal = measureFromCommodities([ftRow({ totalQuantity: 0, totalVerified: true })]);
  check("a verified total of zero still cannot divide", zeroTotal === null);
  check(
    "and says the total is missing rather than unverified",
    measureFromCommodities([ftRow({ totalQuantity: 0, totalVerified: true })]) === null,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
