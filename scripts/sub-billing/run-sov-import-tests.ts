// Subcontract SOV paste parser - known-answer test harness.
//
// Pure functions only, no database. What this parser gets wrong ends up as a
// scheduled value on a line the sub bills against, so the cases that matter
// most are the ones where a row should NOT become a line: the TOTAL row Excel
// drags along, a duplicated item number, a row with no readable money.
//
// Run: npx tsx scripts/sub-billing/run-sov-import-tests.ts

import { parsePastedSovLines } from "@/lib/sub-sov-import";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(
    name,
    actual === expected,
    actual === expected ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

// --------------------------- Positional paste ---------------------------
section("Tab-separated paste, no header");
{
  const r = parsePastedSovLines(
    ["1.01\tMobilization\t45,000.00", "1.02\tPile installation\t$312,500.00"].join("\n"),
  );
  eq("reads both lines", r.lines.length, 2);
  eq("no header assumed", r.usedHeader, false);
  eq("item number", r.lines[0].itemNumber, "1.01");
  eq("description", r.lines[0].description, "Mobilization");
  eq("strips thousands separator", r.lines[0].scheduledValue, 45000);
  eq("strips currency symbol", r.lines[1].scheduledValue, 312500);
}

section("Comma-separated paste with quoted descriptions");
{
  const r = parsePastedSovLines('1.01,"Racking, delivered",\"1,200.50\"');
  eq("one line", r.lines.length, 1);
  eq("comma inside quotes stays in the description", r.lines[0].description, "Racking, delivered");
  eq("quoted money", r.lines[0].scheduledValue, 1200.5);
}

// ------------------------------ Header row ------------------------------
section("Header row drives column order");
{
  const r = parsePastedSovLines(
    [
      "Description\tItem No\tQty\tUnit\tScheduled Value",
      "DC wire pull\t3.04\t12000\tlf\t96,000",
    ].join("\n"),
  );
  eq("header detected", r.usedHeader, true);
  eq("one data line", r.lines.length, 1);
  eq("description from its column", r.lines[0].description, "DC wire pull");
  eq("item from its column", r.lines[0].itemNumber, "3.04");
  eq("quantity", r.lines[0].quantity, 12000);
  eq("unit", r.lines[0].unit, "lf");
  eq("value", r.lines[0].scheduledValue, 96000);
}

section("Extended value missing is derived from qty x rate");
{
  const r = parsePastedSovLines(
    ["Item\tDescription\tQty\tUnit\tUnit Price\tAmount", "2.01\tPiles\t412\tea\t250\t"].join("\n"),
  );
  eq("line read", r.lines.length, 1);
  eq("derived extension", r.lines[0].scheduledValue, 103000);
  eq("unit cost kept", r.lines[0].unitCost, 250);
}

// ---------------------------- Rows to reject ----------------------------
section("Rows that must not become SOV lines");
{
  const r = parsePastedSovLines(
    [
      "1.01\tMobilization\t45,000.00",
      "1.02\tPile installation\t312,500.00",
      "\tTOTAL\t357,500.00",
    ].join("\n"),
  );
  eq("total row excluded", r.lines.length, 2);
  eq("and reported", r.skipped.length, 1);
  eq("with a reason", r.skipped[0].reason, "Looks like a total row");
  eq(
    "so the contract value is not doubled",
    r.lines.reduce((s, l) => s + l.scheduledValue, 0),
    357500,
  );
}
{
  const r = parsePastedSovLines(
    ["1.01\tMobilization\t45,000", "1.01\tMobilization again\t45,000"].join("\n"),
  );
  eq("duplicate item rejected", r.lines.length, 1);
  eq("duplicate reported", r.skipped[0].reason, "Duplicate item number 1.01");
}
{
  const r = parsePastedSovLines("1.01\tMobilization\tTBD");
  eq("unreadable money rejected", r.lines.length, 0);
  eq("reason given", r.skipped[0].reason, "No readable scheduled value");
}
{
  const r = parsePastedSovLines("1.01\t\t45,000");
  eq("blank description rejected", r.lines.length, 0);
  eq("reason given", r.skipped[0].reason, "No description");
}
{
  // A numbered total ("9 TOTAL") is a real line as far as this is concerned;
  // only an unnumbered one is treated as a range artifact.
  const r = parsePastedSovLines("9\tTotal station work\t1,000");
  eq("numbered row starting with 'total' is kept", r.lines.length, 1);
}

// ------------------------------ Shapes ---------------------------------
section("Two-column paste is description + value");
{
  const r = parsePastedSovLines(["Mobilization\t45,000", "Piles\t312,500"].join("\n"));
  eq("both read", r.lines.length, 2);
  eq("first cell is the description", r.lines[0].description, "Mobilization");
  eq("no item number invented here", r.lines[0].itemNumber, null);
  eq("value from the second cell", r.lines[0].scheduledValue, 45000);
}
{
  const r = parsePastedSovLines("");
  eq("empty paste yields nothing", r.lines.length, 0);
  eq("and no phantom skips", r.skipped.length, 0);
}
{
  const r = parsePastedSovLines(
    ["1.01\tMobilization\t45,000", "", "   ", "1.02\tPiles\t312,500"].join("\n"),
  );
  eq("blank rows ignored, not skipped", r.lines.length, 2);
  eq("nothing reported", r.skipped.length, 0);
}
{
  const r = parsePastedSovLines("1.01\tDeductive scope\t(5,000.00)");
  eq("parenthesised amount is negative", r.lines[0].scheduledValue, -5000);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
