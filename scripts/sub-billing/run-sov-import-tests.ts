// Subcontract SOV paste parser - known-answer test harness.
//
// Pure functions only, no database. What this parser gets wrong ends up as a
// scheduled value on a line the sub bills against, so the cases that matter
// most are the ones where a row should NOT become a line: the TOTAL row Excel
// drags along, a duplicated item number, a row with no readable money.
//
// Run: npx tsx scripts/sub-billing/run-sov-import-tests.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// ------------------- A percent-of-total column -------------------
// Lumina Energy Services sent Description / % of contract / Amount. Read
// positionally that files the description under the item number and the
// percentage under the description, and the result looks plausible enough to
// save - which is what happened. These are their real numbers.
section("Description / % of contract / Amount");

const LUMINA: [string, string, string][] = [
  ["General Conditions", "0.1622044391", "78,179.80"],
  ["Trenching, Boring and Backfill", "0.09516516046", "45,868.00"],
  ["DC Collection System", "0.2515486902", "121,242.22"],
  ["AC Collection System", "0.182344066", "87,886.76"],
  ["Medium Voltage System", "0.1705942974", "82,223.57"],
  ["Communications and SCADA", "0.1151342419", "55,492.76"],
  ["Commissioning and Closeout", "0.02300910503", "11,090.00"],
];
const tsv = (rows: string[][]) => rows.map((r) => r.join("\t")).join("\n");

{
  const r = parsePastedSovLines(tsv(LUMINA));
  eq("seven lines", r.lines.length, 7);
  eq("the description is the scope, not the percentage", r.lines[0].description, "General Conditions");
  eq("the value is the money", r.lines[0].scheduledValue, 78179.8);
  eq("no item number is invented from the scope", r.lines[0].itemNumber, null);
  eq("last line reads through", r.lines[6].description, "Commissioning and Closeout");
  // The number that proves it: the lines tie to the SOV total on the sheet.
  eq(
    "the lines tie to the contract total",
    Math.round(r.lines.reduce((s, l) => s + l.scheduledValue, 0) * 100) / 100,
    481983.11,
  );
  eq("nothing skipped", r.skipped.length, 0);
}

// A heading row that matches no alias used to leave the percent column in
// place. Taking the column off before the headings are read fixes both.
{
  const r = parsePastedSovLines(tsv([["Scope of Work", "% of Contract", "Value"], ...LUMINA]));
  eq("unmatched heading: seven lines", r.lines.length, 7);
  eq("unmatched heading: description intact", r.lines[0].description, "General Conditions");
  eq("unmatched heading: value intact", r.lines[0].scheduledValue, 78179.8);
}

// Percents written as percents, with a heading that does match.
{
  const asPct = LUMINA.map(([d, p, v]) => [d, `${(Number(p) * 100).toFixed(2)}%`, v]);
  const r = parsePastedSovLines(tsv([["Description", "%", "Amount"], ...asPct]));
  eq("percent form: seven lines", r.lines.length, 7);
  eq("percent form: description intact", r.lines[0].description, "General Conditions");
  eq("percent form: value intact", r.lines[0].scheduledValue, 78179.8);
}

// Excel drags the TOTAL row along, and it carries its own 100%. Left in the
// sample, the column sums to two wholes and the detection fails on exactly
// the sheets that most need it.
{
  const r = parsePastedSovLines(tsv([...LUMINA, ["TOTAL", "1.00", "481,983.11"]]));
  eq("with a total row: seven lines", r.lines.length, 7);
  eq("with a total row: description intact", r.lines[0].description, "General Conditions");
  eq("with a total row: the total is skipped", r.skipped[0]?.reason, "Looks like a total row");
}

// An item column in front of it still works.
{
  const numbered = LUMINA.map(([d, p, v], i) => [`${i + 1}.00`, d, p, v]);
  const r = parsePastedSovLines(tsv(numbered));
  eq("numbered: seven lines", r.lines.length, 7);
  eq("numbered: item number kept", r.lines[0].itemNumber, "1.00");
  eq("numbered: description intact", r.lines[0].description, "General Conditions");
  eq("numbered: value intact", r.lines[0].scheduledValue, 78179.8);
}

section("What must NOT be taken for a percent column");

// Summing to one whole is not enough. A quantity column can add to 100 by
// coincidence, and taking it off would lose the quantities. What makes a
// column a share of the total is that it tracks the money line by line, and
// 60/100 against 30,000/66,000 does not. Columns are item, description,
// value, qty, unit, unit cost.
{
  const r = parsePastedSovLines(
    tsv([
      ["1.01", "Piles", "30,000.00", "60", "EA", "500.00"],
      ["1.02", "Racking", "36,000.00", "40", "EA", "900.00"],
    ]),
  );
  eq("a quantity column summing to 100 is kept", r.lines.length, 2);
  eq("value survives", r.lines[0].scheduledValue, 30000);
  eq("quantity survives", r.lines[0].quantity, 60);
  eq("unit survives", r.lines[0].unit, "EA");
  eq("unit cost survives", r.lines[0].unitCost, 500);
}

// Two money columns where one sums near 100 dollars: no 10x gap, no drop.
{
  const r = parsePastedSovLines(
    tsv([
      ["1.01", "Small item", "60.00", "70.00"],
      ["1.02", "Another", "40.00", "50.00"],
    ]),
  );
  eq("a small money column is kept", r.lines.length, 2);
  eq("the third cell is still read as the value", r.lines[0].scheduledValue, 60);
}

// Two columns only: nothing to take off, and taking one would leave nothing.
{
  const r = parsePastedSovLines(tsv([["Mobilization", "0.5"], ["Fencing", "0.5"]]));
  eq("a two-column paste is left alone", r.lines.length, 2);
  eq("and read as description plus value", r.lines[0].description, "Mobilization");
  eq("with the number as the value", r.lines[0].scheduledValue, 0.5);
}

// One row is not a pattern.
{
  const r = parsePastedSovLines(tsv([["General Conditions", "1.00", "78,179.80"]]));
  eq("a single row is not enough to call a column", r.lines.length, 1);
  eq("so it reads positionally", r.lines[0].itemNumber, "General Conditions");
}

// ------------------- A real executed exhibit -------------------
// Exhibit E from the Lumina electrical subcontract, as the file actually is:
// five title rows above the headings, four section headings, 34 lines under
// them, a grand total and the retainage arithmetic below it. Every earlier
// case in this file is a shape I reasoned about; this one is a sheet someone
// signed, and it is here because each fix below was found by running it.
section("Exhibit E, as executed");

{
  const csv = readFileSync(
    join(__dirname, "fixtures", "lumina-exhibit-e.csv"),
    "utf8",
  );
  const r = parsePastedSovLines(csv);

  // The headings are on row 7. Reading only row 1 finds the exhibit's title
  // instead, falls back to reading by position, and files the description
  // under the item number.
  eq("the headings are found below the title block", r.usedHeader, true);
  eq("every line is read", r.lines.length, 34);

  // "Item No." carries a full stop. An alias list that matches "item no" but
  // not "item no." leaves every line unnumbered and auto-numbered 1..34,
  // which throws away the sub's own numbering for good.
  eq("the sub's own item numbers survive", r.lines[0].itemNumber, "1.01");
  eq("and to the end of the sheet", r.lines[33].itemNumber, "4.10");
  eq("descriptions are the scope", r.lines[0].description, "Payment and Performance Bond");
  eq("units come through", r.lines[0].unit, "LS");
  eq("values come through", r.lines[0].scheduledValue, 10713.8);

  // The one number that proves the import: the lines tie to the contract.
  eq(
    "the lines tie to the executed total",
    Math.round(r.lines.reduce((s, l) => s + l.scheduledValue, 0) * 100) / 100,
    481983.11,
  );

  // "Agreed % of Subcontract" is dropped, so it cannot shift the columns.
  check("no line is priced off the percentage", r.lines.every((l) => l.scheduledValue > 100));

  // Section headings carry no money. Reported as skipped they read like four
  // lost lines; recognised, they say which section each line belongs to.
  eq("sections are picked up", r.lines[0].sectionName, "GENERAL CONDITIONS");
  eq("and they change", r.lines[8].sectionName, "ELECTRICAL INSTALLATION");
  eq("and again", r.lines[15].sectionName, "TEST REPORTS");
  eq("and again", r.lines[24].sectionName, "COMPLETION TEST REPORTS");
  eq(
    "every line is under one",
    r.lines.filter((l) => l.sectionName == null).length,
    0,
  );

  // One skipped row, and it is the grand total. "Less: Retainage (10%)" and
  // "Net Payable This Application" sit below it and are the exhibit's own
  // arithmetic, not lines - four noisy skips on every import is how people
  // learn to ignore the list that would show a real lost line.
  eq("exactly one row skipped", r.skipped.length, 1);
  eq("and it is the total", r.skipped[0].reason, "Looks like a total row");

  eq("no duplicate item numbers", r.lines.length - new Set(r.lines.map((l) => l.itemNumber)).size, 0);
}

section("Headings, sections and footers in isolation");

// Punctuation on a heading must not defeat it.
{
  const r = parsePastedSovLines(
    ["Item #\tDescription\tAmount", "1.01\tMobilization\t45,000.00"].join("\n"),
  );
  eq("a hash on the item heading still matches", r.lines[0]?.itemNumber, "1.01");
}

// A row that merely looks like a line with its value missing is still
// reported. Suppressing it would be the one failure mode that matters.
{
  const r = parsePastedSovLines(
    [
      "Item No.\tDescription of Work\tScheduled Value",
      "1.01\tMobilization\t45,000.00",
      "1.02\tFencing\t",
    ].join("\n"),
  );
  eq("a line with no value is reported, not swallowed", r.skipped.length, 1);
  eq("with the reason", r.skipped[0].reason, "No readable scheduled value");
}

// A lower-case one-cell row is not a section heading - no number, no capitals.
{
  const r = parsePastedSovLines(
    [
      "Item No.\tDescription of Work\tScheduled Value",
      "1.01\tMobilization\t45,000.00",
      "\tsomething went wrong here\t",
    ].join("\n"),
  );
  eq("an ordinary stray row is still reported", r.skipped.length, 1);
}

// Below the total, only rows with no money at all are suppressed.
{
  const r = parsePastedSovLines(
    [
      "Item No.\tDescription of Work\tScheduled Value",
      "1.01\tMobilization\t45,000.00",
      "\tTOTAL\t45,000.00",
      "\tLess: Retainage (10%)\t",
      "1.02\tFencing\t12,000.00",
    ].join("\n"),
  );
  eq("the retainage line is not reported", r.skipped.length, 1);
  eq("and the total is", r.skipped[0].reason, "Looks like a total row");
  // A line below the total still has money, so it is still a line.
  eq("a real line after the total is still read", r.lines.length, 2);
  eq("with its value", r.lines[1].scheduledValue, 12000);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
