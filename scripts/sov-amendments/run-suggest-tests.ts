// Reading a change order's cost buildup to propose SOV allocations.
//
// Run: npx tsx scripts/sov-amendments/run-suggest-tests.ts

import {
  leadingItemNumber,
  normalizeDescription,
  suggestAllocations,
  type BuildupLine,
  type ContractLine,
} from "@/lib/sov-amendment-suggest";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}
function eq<T>(name: string, got: T, want: T) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, g === w ? "" : `got ${g}, want ${w}`);
}
function section(t: string) {
  console.log(`\n${t}\n${"-".repeat(t.length)}`);
}

// CO-02's real buildup, read off the change order page on 2026-09-19.
const CO2: BuildupLine[] = [
  { id: "c1", description: "6.01 Mobilization", extendedCost: 220762.92 },
  { id: "c2", description: "6.02 Civil, Roads and Landscaping if applicable", extendedCost: 63045.92 },
  { id: "c3", description: "6.03 Fencing/SWPPP", extendedCost: 78835.79 },
  { id: "c4", description: "7.01 Inverters Installed (mounted only)", extendedCost: 31534.32 },
  { id: "c5", description: "7.02 AC/DC Wire (Trenching and Concrete Pad Installed)", extendedCost: 96431.94 },
  { id: "c6", description: "7.03 Transformers Installed", extendedCost: 15138.24 },
  { id: "c7", description: "7.04 POI Installed", extendedCost: 55500.40 },
  { id: "c8", description: "8.01 Piles and Racking Installed", extendedCost: 123499.62 },
  { id: "c9", description: "8.02 Modules Installed", extendedCost: 25227.45 },
];

// The contract SOV, as executed.
const SOV: ContractLine[] = [
  { id: "l601", itemNumber: "6.01", description: "Mobilization" },
  { id: "l602", itemNumber: "6.02", description: "Civil, Roads and Landscaping if applicable" },
  { id: "l603", itemNumber: "6.03", description: "Fencing/SWPPP" },
  { id: "l701", itemNumber: "7.01", description: "Inverters Installed (mounted only)" },
  { id: "l702", itemNumber: "7.02", description: "AC/DC Wire (Trenching and Concrete Pad Installed)" },
  { id: "l703", itemNumber: "7.03", description: "Transformers Installed" },
  { id: "l704", itemNumber: "7.04", description: "POI Installed" },
  { id: "l801", itemNumber: "8.01", description: "Piles and Racking Installed" },
  { id: "l802", itemNumber: "8.02", description: "Modules Installed" },
  { id: "l505", itemNumber: "5.05", description: "POI Procurement" },
];

const CO2_VALUE = 709976.60;

section("CO-02, the case this was built for");
{
  const s = suggestAllocations(CO2, SOV, CO2_VALUE);
  eq("all nine lines match", s.matched.length, 9);
  eq("nothing is left unmatched", s.unmatched.length, 0);
  eq(
    "every one matched on the item number the pricer wrote down",
    Array.from(new Set(s.matched.map((m) => m.basis))),
    ["item-number"],
  );
  eq(
    "in SOV order",
    s.matched.map((m) => m.baseItemNumber),
    ["6.01", "6.02", "6.03", "7.01", "7.02", "7.03", "7.04", "8.01", "8.02"],
  );
  eq("Mobilization gets its own figure", s.matched[0].amount, 220762.92);
  eq("Modules gets its own figure", s.matched[8].amount, 25227.45);
  eq("the whole change order is allocated", s.matchedTotal, CO2_VALUE);
  eq("with nothing left as new scope", s.remainder, 0);
  check("no scaling needed - this CO has no markup", s.scaled === false);
}

section("Markup: the owner pays more than the cost");
{
  // Same buildup, but the SOV line carries 10% markup. Splitting by raw cost
  // would allocate $709,976.60 of a $780,974.26 line and invent $70,997.66 of
  // new scope that does not exist.
  const withMarkup = round2(CO2_VALUE * 1.1);
  const s = suggestAllocations(CO2, SOV, withMarkup);
  check("shares are scaled", s.scaled === true);
  // 220,762.92 x 1.1 rounds to 242,839.21 on its own. The extra cent is the
  // rounding drift from all nine shares, landed on the largest row so the
  // total is exact. An exact total matters more than an exactly-rounded row:
  // a stray cent of "new scope" on a change order is a question nobody can
  // answer.
  eq("Mobilization is scaled up too", s.matched[0].amount, 242839.22);
  eq("the whole line is still allocated", s.matchedTotal, withMarkup);
  eq("and nothing is invented", s.remainder, 0);
}

section("What it refuses to guess");
{
  const odd: BuildupLine[] = [
    { id: "a", description: "6.01 Mobilization", extendedCost: 100 },
    { id: "b", description: "Site trailer rental", extendedCost: 50 },
    { id: "c", description: "9.99 Line that is not on the SOV", extendedCost: 25 },
  ];
  const s = suggestAllocations(odd, SOV, 175);
  eq("only the one it was told about matches", s.matched.length, 1);
  eq("the other two are handed back, not guessed", s.unmatched.length, 2);
  eq("and the remainder is honest", s.remainder, 75);
  check(
    "a near-miss description is NOT treated as a match",
    s.unmatched.some((u) => u.from[0].description === "Site trailer rental"),
  );
}

section("Matching on description when there is no item number");
{
  const noNumbers: BuildupLine[] = [
    { id: "a", description: "Mobilization", extendedCost: 100 },
    { id: "b", description: "Fencing/SWPPP", extendedCost: 50 },
  ];
  const s = suggestAllocations(noNumbers, SOV, 150);
  eq("both match", s.matched.length, 2);
  eq(
    "and say they matched on the description, not the number",
    Array.from(new Set(s.matched.map((m) => m.basis))),
    ["description"],
  );
}

{
  // Two contract lines sharing a description make the description useless as
  // a key. Refuse rather than pick one.
  const ambiguous: ContractLine[] = [
    { id: "x", itemNumber: "6.01", description: "Mobilization" },
    { id: "y", itemNumber: "9.01", description: "Mobilization" },
  ];
  const s = suggestAllocations(
    [{ id: "a", description: "Mobilization", extendedCost: 100 }],
    ambiguous,
    100,
  );
  eq("an ambiguous description matches nothing", s.matched.length, 0);
  eq("it is handed to a person instead", s.unmatched.length, 1);
}

section("Several buildup lines onto one contract line");
{
  const twice: BuildupLine[] = [
    { id: "a", description: "6.01 Mobilization", extendedCost: 100 },
    { id: "b", description: "6.01 Mobilization - second crew", extendedCost: 40 },
  ];
  const s = suggestAllocations(twice, SOV, 140);
  eq("they merge into one allocation", s.matched.length, 1);
  eq("for the sum", s.matched[0].amount, 140);
  eq("and both sources are named", s.matched[0].from.length, 2);
}

section("Rough edges");
{
  eq("item number is read off the front", leadingItemNumber("6.01 Mobilization"), "6.01");
  eq("a bare number is not an item number", leadingItemNumber("6.01"), null);
  eq("prose is not an item number", leadingItemNumber("Mobilization"), null);
  eq("a date is not an item number", leadingItemNumber("2026 crew costs"), "2026");
  eq(
    "description normalizing drops the number and the punctuation",
    normalizeDescription("7.02 AC/DC Wire (Trenching and Concrete Pad Installed)"),
    "ac dc wire trenching and concrete pad installed",
  );

  const empty = suggestAllocations([], SOV, 1000);
  eq("no buildup, no suggestions", empty.matched.length, 0);
  eq("and the whole line is the remainder", empty.remainder, 1000);

  const zeroCost = suggestAllocations(
    [{ id: "a", description: "6.01 Mobilization", extendedCost: 0 }],
    SOV,
    500,
  );
  eq("a zero-cost buildup proposes zero, not NaN", zeroCost.matched[0].amount, 0);

  // Rounding: three equal thirds of a penny-odd total must still add up.
  const thirds = suggestAllocations(
    [
      { id: "a", description: "6.01 Mobilization", extendedCost: 33.33 },
      { id: "b", description: "6.02 Civil, Roads and Landscaping if applicable", extendedCost: 33.33 },
      { id: "c", description: "6.03 Fencing/SWPPP", extendedCost: 33.34 },
    ],
    SOV,
    100.01,
  );
  eq("rounding drift is absorbed, not left as phantom scope", thirds.remainder, 0);
  eq("and the total is exact", thirds.matchedTotal, 100.01);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
