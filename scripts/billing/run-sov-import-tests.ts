// Owner SOV importer - known-answer test harness.
//
// Pure functions only, no database. The cases that matter most are the ones
// where a row must NOT become a billing line, because a bad line here lands on
// a G703 that goes to the owner: the Totals and Retainage rows Excel drags
// along, a duplicated item number, a row with no item number to key on.
//
// Run: npx tsx scripts/billing/run-sov-import-tests.ts

import {
  buildSovRows,
  diffSov,
  guessSovColumns,
  parseMoney,
  parseSovGrid,
  planFromDiff,
  type ExistingLine,
  type SovColumnKey,
} from "@/lib/sov-import";

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

// --------------------------------- money ---------------------------------
section("Money parsing");

eq("plain number", parseMoney("22580.68"), 22580.68);
eq("currency with commas and padding", parseMoney(" $22,580.68 "), 22580.68);
eq("Excel zero renders as a lone dash", parseMoney(" $-   "), 0);
eq("bare dash is zero", parseMoney("-"), 0);
eq("parenthesised deduct is negative", parseMoney("(1,200.00)"), -1200);
eq("signed negative", parseMoney("-1200"), -1200);
eq("empty is null", parseMoney(""), null);
eq("prose is null, not zero", parseMoney("TBD"), null);

// ------------------------- header + column guessing -------------------------
section("Column guessing on the real cash-flow header");

// Exactly the shape XLSX hands back for the "Cash - In " sheet: the
// description column's header cell is a single blank space.
const realHeader = ["Item Number", "Type", " ", "Schedule of Value", "April 2024"];
const realRows = [
  ["1.01", "LNTP", "LNTP Execution Engineering", " $22,580.68 ", " $-   "],
  ["1.02", "LNTP", "Electrical 30% Design", " $11,290.34 ", " $-   "],
  ["2.00", "EPC Contract", "EPC Contract", " $85,017.50 ", " $-   "],
];
const realMap = guessSovColumns(realHeader, realRows);
eq("item number from header", realMap[0], "item_number");
eq("type from header", realMap[1], "type");
eq("blank-header description found by shape", realMap[2], "description");
eq("scheduled value from 'Schedule of Value'", realMap[3], "scheduled_value");
check(
  "a month column is not mistaken for the scheduled value",
  realMap[4] === null,
  `got ${realMap[4]}`,
);

section("Header row is detected, not eaten as data");

const pasted = [
  "Item Number\tType\t\tSchedule of Value",
  "1.01\tLNTP\tLNTP Execution Engineering\t $22,580.68 ",
  "1.02\tLNTP\tElectrical 30% Design\t $11,290.34 ",
].join("\n");
const grid = parseSovGrid(pasted);
eq("header detected", grid.headers?.[0], "Item Number");
eq("two data rows", grid.rows.length, 2);

section("A header carrying month columns is still a header");

// The regression this guards: the "SOV" tab of the real cash-flow workbook has
// month columns written "Jan-26". The schedule importer treats any row holding
// a date as a data row, which made the SOV header leak in as a billing line
// called "Item Number". An SOV header legitimately carries months.
const monthly = parseSovGrid(
  [
    "Item Number\tType\tDescription\tSchedule of Value\tJan-26\tFeb-26\tTotals",
    "1.01\tLNTP\tLNTP Execution Engineering\t $22,580.68 \t $-   \t $-   \t $-   ",
    "2.00\tEPC Contract\tEPC Contract\t $85,017.50 \t $-   \t $-   \t $-   ",
  ].join("\n"),
);
eq("header detected despite the month columns", monthly.headers?.[0], "Item Number");
eq("the header did not become a line", monthly.rows.length, 2);
const monthlyMap = guessSovColumns(monthly.headers, monthly.rows);
eq("scheduled value comes off the named column", monthlyMap[3], "scheduled_value");
check(
  "a month column is left on Ignore",
  monthlyMap[4] === null && monthlyMap[5] === null,
  `got ${monthlyMap[4]}, ${monthlyMap[5]}`,
);
check(
  "a trailing Totals column does not steal the scheduled value",
  monthlyMap[6] === null,
  `got ${monthlyMap[6]}`,
);

section("A paste with no header still maps by shape");

const noHeader = parseSovGrid(
  ["1.01\tLNTP\tLNTP Execution Engineering\t $22,580.68 ",
   "1.02\tLNTP\tElectrical 30% Design\t $11,290.34 "].join("\n"),
);
eq("no header claimed", noHeader.headers, null);
eq("both rows are data", noHeader.rows.length, 2);
const shapeMap = guessSovColumns(noHeader.headers, noHeader.rows);
eq("item number by code shape", shapeMap[0], "item_number");
eq("description by text shape", shapeMap[2], "description");
eq("scheduled value by money shape", shapeMap[3], "scheduled_value");
// Type has no distinguishing shape - a short repeated word looks like nothing
// in particular - so it is left for the user to map rather than guessed at.
eq("type is left unmapped with no header", shapeMap[1], null);

// --------------------------------- rows ---------------------------------
section("Rows that must not become billing lines");

const MAP: (SovColumnKey | null)[] = [
  "item_number",
  "type",
  "description",
  "scheduled_value",
];
const messy = parseSovGrid(
  [
    "Item Number\tType\tDescription\tSchedule of Value",
    "1.01\tLNTP\tLNTP Execution Engineering\t $22,580.68 ",
    "\t\t\t",
    "\tTotals\t\t $3,787,185.91 ",
    "\tRetainage\t\t $189,359.30 ",
    "2.00\tEPC Contract\tEPC Contract\t $85,017.50 ",
    "\tSite Work\tOrphan row with no item number\t $500.00 ",
  ].join("\n"),
);
const built = buildSovRows(messy, MAP);
eq("only the two real lines survive", built.rows.map((r) => r.itemNumber), ["1.01", "2.00"]);
eq("orphan row is rejected, not dropped silently", built.rejected.length, 1);
eq("orphan reason names the cause", built.rejected[0].reason.includes("no item number"), true);
check(
  "totals and retainage are reported as skipped",
  built.notes.some((n) => /total or retainage/i.test(n)),
  built.notes.join(" | "),
);
eq("money read off a padded currency cell", built.rows[0].values.scheduled_value, 22580.68);
eq("sheet order stamped when no sort column", built.rows.map((r) => r.values.sort_order), [10, 20]);

section("Unreadable value is flagged, and the row still imports");

const badMoney = buildSovRows(
  parseSovGrid(
    ["Item Number\tType\tDescription\tSchedule of Value",
     "3.00\tEngineering\tIFC Engineering\tTBD"].join("\n"),
  ),
  MAP,
);
eq("row kept", badMoney.rows.length, 1);
eq("value left unset rather than guessed", badMoney.rows[0].values.scheduled_value, undefined);
eq("issue recorded", badMoney.rows[0].issues.length, 1);

// --------------------------------- diff ---------------------------------
section("Diff against existing lines");

const existing: ExistingLine[] = [
  {
    id: "id-101",
    item_number: "1.01",
    type: "LNTP",
    description: "LNTP Execution Engineering",
    scheduled_value: 22580.68,
    sort_order: 10,
    notes: null,
    change_order_id: null,
  },
  {
    id: "id-co5",
    item_number: "CO-05",
    type: "CO",
    description: "Added basin grading",
    scheduled_value: 100000,
    sort_order: 900,
    notes: null,
    change_order_id: "co-uuid",
  },
];

const incoming = buildSovRows(
  parseSovGrid(
    [
      "Item Number\tType\tDescription\tSchedule of Value",
      "1.01\tLNTP\tLNTP Execution Engineering\t $22,580.68 ",
      "1.02\tLNTP\tElectrical 30% Design\t $11,290.34 ",
      "CO-05\tCO\tAdded basin grading\t $125,000.00 ",
    ].join("\n"),
  ),
  MAP,
);
const diff = diffSov(existing, incoming, MAP);
eq("one genuinely new line", diff.adds.map((a) => a.itemNumber), ["1.02"]);
// 1.01 matches on every mapped field AND on the sheet-order sort it would be
// stamped with, so it is a no-op. Re-importing an unchanged sheet must not
// produce a wall of phantom updates.
eq("identical line counts as unchanged", diff.unchangedCount, 1);
eq(
  "identical line produces no update",
  diff.changes.some((c) => c.existing.item_number === "1.01"),
  false,
);
eq(
  "changed scheduled value is caught",
  diff.changes
    .find((c) => c.existing.item_number === "CO-05")
    ?.fields.filter((f) => f.field === "scheduled_value")
    .map((f) => f.to),
  [125000],
);
check(
  "editing a CO-owned line warns that the CO is not updated",
  diff.warnings.some((w) => /change order/i.test(w)),
  diff.warnings.join(" | "),
);
eq("nothing blocking", diff.blocking, []);

section("Blocking conditions");

const dupe = diffSov(
  existing,
  buildSovRows(
    parseSovGrid(
      ["Item Number\tType\tDescription\tSchedule of Value",
       "9.01\tSite Work\tGrading\t $1,000.00 ",
       "9.01\tSite Work\tGrading again\t $2,000.00 "].join("\n"),
    ),
    MAP,
  ),
  MAP,
);
check(
  "duplicate item number inside one import blocks",
  dupe.blocking.some((b) => /duplicate item number/i.test(b)),
  dupe.blocking.join(" | "),
);

const noKey = diffSov(existing, incoming, ["type", "description", "scheduled_value", null]);
check(
  "no item-number column blocks",
  noKey.blocking.some((b) => /item number/i.test(b)),
  noKey.blocking.join(" | "),
);

const noDesc = diffSov(
  existing,
  buildSovRows(
    parseSovGrid(["Item Number\tSchedule of Value", "7.00\t $5,000.00 "].join("\n")),
    ["item_number", "scheduled_value"],
  ),
  ["item_number", "scheduled_value"],
);
check(
  "a new line with no description blocks - the column is NOT NULL",
  noDesc.blocking.some((b) => /description/i.test(b)),
  noDesc.blocking.join(" | "),
);

section("Plan handed to the server");

const plan = planFromDiff(diff, MAP);
eq("plan adds only the new line", plan.adds.map((a) => a.item_number), ["1.02"]);
eq("add carries its description", plan.adds[0].description, "Electrical 30% Design");
eq(
  "change patch touches only changed fields",
  Object.keys(
    plan.changes.find((c) => c.id === "id-co5")?.patch ?? {},
  ).sort(),
  ["scheduled_value", "sort_order"],
);
check(
  "no delete side exists on the plan at all",
  !("deleteIds" in (plan as Record<string, unknown>)),
);

section("Re-importing the same sheet is a no-op");

// The importer is run more than once by definition - the workbook is the
// source of truth and it changes. A second run of an unchanged sheet must not
// produce a wall of phantom updates.
const roundTripMap: (SovColumnKey | null)[] = [
  "item_number",
  "type",
  "description",
  "scheduled_value",
];
const sheet = parseSovGrid(
  [
    "Item Number\tType\tDescription\tSchedule of Value",
    "1.01\tLNTP\tLNTP Execution Engineering\t $22,580.68 ",
    "2.00\tEPC Contract\tEPC Contract\t $85,017.50 ",
  ].join("\n"),
);
const firstPass = buildSovRows(sheet, roundTripMap);
const asExisting: ExistingLine[] = firstPass.rows.map((r, i) => ({
  id: `rt-${i}`,
  item_number: r.itemNumber,
  type: r.values.type ?? null,
  description: r.values.description ?? "",
  scheduled_value: r.values.scheduled_value ?? null,
  sort_order: r.values.sort_order ?? null,
  notes: null,
  change_order_id: null,
}));
const second = diffSov(asExisting, buildSovRows(sheet, roundTripMap), roundTripMap);
eq("no adds on re-import", second.adds.length, 0);
eq("no changes on re-import", second.changes.length, 0);
eq("everything reads as unchanged", second.unchangedCount, 2);

// --------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
