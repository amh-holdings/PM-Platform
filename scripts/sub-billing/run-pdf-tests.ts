// Reading a subcontract SOV out of a PDF - known-answer test harness.
//
// Pure functions only, no PDF library and no database. The input is the same
// shape pdf.js hands back: runs of text with coordinates. That is deliberate -
// the part that can be wrong is the geometry reasoning, not the decoding, and
// keeping it separable is what makes these cases writable at all.
//
// What this code gets wrong becomes a scheduled value on a line the sub bills
// against, so the cases that matter most are the ones where two columns must
// not merge and where a wrapped description must not be lost.
//
// Run: npx tsx scripts/sub-billing/run-pdf-tests.ts

import { itemsToRows, pdfPagesToSheets, bestPageIndex, sovRowCount, type PdfTextItem } from "@/lib/sov-pdf";
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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

/**
 * Lays out a page the way a PDF writer does: each cell gets a left edge, and
 * the advance width is derived from the text so the gaps between cells are
 * realistic rather than hand-tuned to pass.
 */
const CHAR_WIDTH = 5; // ~10pt Helvetica average
function row(y: number, cells: [number, string][], fontSize = 10): PdfTextItem[] {
  return cells.map(([x, str]) => ({
    str,
    x,
    y,
    width: str.length * CHAR_WIDTH,
    height: fontSize,
  }));
}

// --------------------------- Column splitting ---------------------------
section("Columns come from the gaps, not from spaces");

eq(
  "three columns split",
  itemsToRows(row(700, [[60, "1.01"], [120, "Mobilization"], [430, "45,000.00"]])),
  [["1.01", "Mobilization", "45,000.00"]],
);

eq(
  "words inside a cell stay in that cell",
  itemsToRows(
    row(700, [
      [60, "1.02"],
      [120, "Pile"],
      [146, "installation"],
      [210, "and"],
      [232, "survey"],
      [268, "layout"],
      [430, "312,500.00"],
    ]),
  ),
  [["1.02", "Pile installation and survey layout", "312,500.00"]],
);

// A justified line can leave a wider-than-normal space between words. The
// threshold has to clear that without clearing a column gap.
eq(
  "a stretched word space does not become a column",
  itemsToRows(row(700, [[120, "Tracker"], [163, "assembly"], [430, "688,400.00"]])),
  [["Tracker assembly", "688,400.00"]],
);

// ------------------------------ Row banding ------------------------------
section("Rows come from the baselines");

eq(
  "two baselines are two rows",
  itemsToRows([
    ...row(700, [[60, "1.01"], [120, "Mobilization"], [430, "45,000.00"]]),
    ...row(676, [[60, "1.02"], [120, "Fencing"], [430, "12,000.00"]]),
  ]),
  [
    ["1.01", "Mobilization", "45,000.00"],
    ["1.02", "Fencing", "12,000.00"],
  ],
);

// Cells in one row are rarely on exactly the same baseline in a real export.
eq(
  "a baseline off by a point is still the same row",
  itemsToRows([
    ...row(700, [[60, "1.01"]]),
    ...row(699.2, [[120, "Mobilization"]]),
    ...row(700.4, [[430, "45,000.00"]]),
  ]),
  [["1.01", "Mobilization", "45,000.00"]],
);

// Reading order in the content stream is not guaranteed to be visual order.
eq(
  "items out of order are sorted into place",
  itemsToRows([
    ...row(676, [[430, "12,000.00"]]),
    ...row(700, [[120, "Mobilization"], [60, "1.01"], [430, "45,000.00"]]),
    ...row(676, [[60, "1.02"], [120, "Fencing"]]),
  ]),
  [
    ["1.01", "Mobilization", "45,000.00"],
    ["1.02", "Fencing", "12,000.00"],
  ],
);

// --------------------------- Wrapped descriptions ---------------------------
section("A description that ran onto two lines");

eq(
  "the tail is merged back onto the description",
  itemsToRows([
    ...row(700, [[60, "1.03"], [120, "Tracker assembly, torque tube and"], [430, "688,400.00"]]),
    ...row(688, [[120, "bearing install"]]),
  ]),
  [["1.03", "Tracker assembly, torque tube and bearing install", "688,400.00"]],
);

eq(
  "the tail merges onto the description, never onto the money",
  itemsToRows([
    ...row(700, [[60, "1.03"], [120, "Tracker"], [430, "688,400.00"]]),
    ...row(688, [[120, "and bearings"]]),
  ]),
  [["1.03", "Tracker and bearings", "688,400.00"]],
);

// A heading is not a wrapped description. The digit is what tells them apart,
// and getting this wrong folds a section title into the line above it.
eq(
  "a numbered heading stays its own row",
  itemsToRows([
    ...row(700, [[60, "1.03"], [120, "Tracker assembly"], [430, "688,400.00"]]),
    ...row(670, [[60, "Division 2 - Site Work"]]),
  ]),
  [["1.03", "Tracker assembly", "688,400.00"], ["Division 2 - Site Work"]],
);

// Nothing to merge onto: the row above carried no money, so the second row is
// a line in its own right, not a continuation.
eq(
  "no merge under a row with no money",
  itemsToRows([
    ...row(700, [[60, "SITE WORK"]]),
    ...row(688, [[120, "Clearing and grubbing"]]),
  ]),
  [["SITE WORK"], ["Clearing and grubbing"]],
);

// ------------------------------ Page furniture ------------------------------
section("Page furniture is dropped");

eq(
  "a page number line is dropped",
  itemsToRows([
    ...row(700, [[60, "1.01"], [120, "Mobilization"], [430, "45,000.00"]]),
    ...row(60, [[280, "Page 1 of 4"]]),
  ]),
  [["1.01", "Mobilization", "45,000.00"]],
);

eq(
  "a bare page number is dropped",
  itemsToRows([
    ...row(700, [[60, "1.01"], [120, "Mobilization"], [430, "45,000.00"]]),
    ...row(60, [[300, "3"]]),
  ]),
  [["1.01", "Mobilization", "45,000.00"]],
);

// A line item numbered 12 with a value is not page furniture.
eq(
  "a numbered line with money survives",
  itemsToRows(row(700, [[60, "12"], [120, "Fencing"], [430, "9,000.00"]])),
  [["12", "Fencing", "9,000.00"]],
);

// ------------------------------ Page selection ------------------------------
section("Landing on the page that holds the SOV");

const wordyPage = {
  num: 1,
  items: [
    ...row(700, [[60, "This Subcontract Agreement is entered into by and between"]]),
    ...row(688, [[60, "American Helios Constructors and the Subcontractor named"]]),
    ...row(676, [[60, "below, subject to the terms and conditions set out herein."]]),
    ...row(664, [[60, "The Subcontractor shall furnish all labor and materials."]]),
    ...row(652, [[60, "Payment shall be made in accordance with Exhibit B hereto."]]),
  ],
};
const sovPage = {
  num: 2,
  items: [
    ...row(700, [[60, "Item"], [120, "Description"], [430, "Scheduled Value"]]),
    ...row(688, [[60, "1.01"], [120, "Mobilization"], [430, "45,000.00"]]),
    ...row(676, [[60, "1.02"], [120, "Fencing"], [430, "12,000.00"]]),
  ],
};

const sheets = pdfPagesToSheets([wordyPage, sovPage]);
eq("pages become sheets", sheets.map((s) => s.name), ["Page 1", "Page 2"]);
check("the wordy page has more rows", sheets[0].filledRows > sheets[1].filledRows);
eq("but no priced rows", sovRowCount(sheets[0]), 0);
eq("the SOV page has priced rows", sovRowCount(sheets[1]), 2);
eq("so the SOV page is the one to land on", bestPageIndex(sheets), 1);

// With no priced rows anywhere, fall back to the fullest page rather than
// dumping the reviewer on page 1 by default.
eq(
  "no priced rows anywhere falls back to the fullest page",
  bestPageIndex(pdfPagesToSheets([{ num: 1, items: row(700, [[60, "Cover"]]) }, wordyPage])),
  1,
);

// --------------------------- Through the real parser ---------------------------
section("The rows go through the paste parser unchanged");

const page = {
  num: 1,
  items: [
    ...row(720, [[60, "Item"], [120, "Description"], [430, "Scheduled Value"]]),
    ...row(696, [[60, "1.01"], [120, "Mobilization"], [430, "45,000.00"]]),
    ...row(672, [[60, "1.02"], [120, "Pile installation and survey layout"], [430, "312,500.00"]]),
    ...row(648, [[60, "1.03"], [120, "Tracker assembly, torque tube and"], [430, "688,400.00"]]),
    ...row(636, [[120, "bearing install"]]),
    ...row(612, [[60, "1.04"], [120, "Module install"], [430, "1,204,000.00"]]),
    ...row(588, [[60, "TOTAL"], [430, "2,249,900.00"]]),
    ...row(60, [[280, "Page 1 of 1"]]),
  ],
};
const tsv = itemsToRows(page.items).map((r) => r.join("\t")).join("\n");
const parsed = parsePastedSovLines(tsv);

eq("the header row is recognised", parsed.usedHeader, true);
eq("four lines", parsed.lines.length, 4);
eq("item numbers", parsed.lines.map((l) => l.itemNumber), ["1.01", "1.02", "1.03", "1.04"]);
eq(
  "the wrapped description survived the round trip",
  parsed.lines[2].description,
  "Tracker assembly, torque tube and bearing install",
);
eq(
  "values",
  parsed.lines.map((l) => l.scheduledValue),
  [45000, 312500, 688400, 1204000],
);
// The single number that proves the import: the lines add up to the sheet.
eq("the lines add up to the printed total", parsed.lines.reduce((s, l) => s + l.scheduledValue, 0), 2249900);
eq("exactly one row skipped", parsed.skipped.length, 1);
eq("and it is the total row", parsed.skipped[0].reason, "Looks like a total row");

// The reason matters. Before, a TOTAL row whose label sat in the item column
// was rejected for having no readable value - true, but it sends whoever is
// reviewing the import hunting for a problem that is not there.
section("A total row labelled in the item column");
const totalInItemCol = parsePastedSovLines(
  ["Item\tDescription\tScheduled Value", "1.01\tMobilization\t45,000.00", "TOTAL\t45,000.00"].join("\n"),
);
eq("one line", totalInItemCol.lines.length, 1);
eq("the total row is named as such", totalInItemCol.skipped[0]?.reason, "Looks like a total row");

// And a line legitimately numbered is still a line.
const legit = parsePastedSovLines(
  ["Item\tDescription\tScheduled Value", "5.00\tTotal station survey\t8,000.00"].join("\n"),
);
eq("a line whose scope reads like a total is kept", legit.lines.length, 1);

// ------------------------------- Degenerate -------------------------------
section("Nothing to read");

eq("no items, no rows", itemsToRows([]), []);
eq("only blanks, no rows", itemsToRows(row(700, [[60, "   "], [200, ""]])), []);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
