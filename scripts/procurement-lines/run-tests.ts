// PO line items - known-answer test harness.
//
// Pure functions only, no database. These numbers become procurement_orders
// .total_value, which milestone amounts are computed off, which billing
// allocations split, which the cash projection draws. A rounding slip here
// does not stay here.
//
// Run: npx tsx scripts/procurement-lines/run-tests.ts

import {
  extendedPrice,
  parseAmount,
  parsePoLines,
  parsePoLinesField,
  poLinesTotal,
  round2,
  unpricedLineCount,
  type PoLineInput,
} from "@/lib/po-lines";

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
    actual === expected
      ? ""
      : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

function row(over: Partial<PoLineInput> = {}): PoLineInput {
  return {
    description: over.description ?? "Item",
    quantity: over.quantity ?? "1",
    unit: over.unit ?? "ea",
    unitPrice: over.unitPrice ?? "100",
    notes: over.notes,
  };
}

function okLines(rows: PoLineInput[]) {
  const r = parsePoLines(rows);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.lines;
}

// ---------------------------------------------------------------- parseAmount

section("parseAmount");

eq("blank is null, not zero", parseAmount(""), null);
eq("whitespace is null", parseAmount("   "), null);
eq("undefined is null", parseAmount(undefined), null);
eq("plain integer", parseAmount("12"), 12);
eq("decimal", parseAmount("12.5"), 12.5);
eq("currency and grouping stripped", parseAmount("$1,234.56"), 1234.56);
eq("explicit zero is zero, not null", parseAmount("0"), 0);
eq("negative survives for a credit line", parseAmount("-250"), -250);
eq("garbage is null", parseAmount("twelve"), null);

// -------------------------------------------------------------- extendedPrice

section("extendedPrice");

eq("quantity times unit price", extendedPrice(12, 4150), 49800);
eq("null quantity yields null, not 0", extendedPrice(null, 4150), null);
eq("null unit price yields null, not 0", extendedPrice(12, null), null);
eq("zero price is a real zero", extendedPrice(3, 0), 0);
// 3 x 19.99 is 59.97 in decimal and 59.969999999999999 in float.
eq("rounds to cents", extendedPrice(3, 19.99), 59.97);
eq("half-cent rounds up", round2(0.005), 0.01);

// ---------------------------------------------------------------- parsePoLines

section("parsePoLines");

{
  const lines = okLines([
    row({ description: "SMA SHP-150 inverter", quantity: "12", unitPrice: "4150" }),
    row({ description: "Freight", quantity: "1", unit: "ls", unitPrice: "3800" }),
  ]);
  eq("two lines kept", lines.length, 2);
  eq("line_no assigned from position", lines[0].lineNo, 1);
  eq("second line numbered 2", lines[1].lineNo, 2);
  eq("extension computed", lines[0].extendedPrice, 49800);
  eq("total is the sum", poLinesTotal(lines), 53600);
}

{
  // A row the user tabbed through and never filled.
  const lines = okLines([
    row({ description: "Transformer", quantity: "1", unitPrice: "412000" }),
    { description: "", quantity: "", unit: "", unitPrice: "" },
  ]);
  eq("blank row dropped", lines.length, 1);
  eq("numbering closes the gap", lines[0].lineNo, 1);
  eq("total unaffected", poLinesTotal(lines), 412000);
}

{
  const lines = okLines([
    row({ description: "Priced", quantity: "2", unitPrice: "100" }),
    { description: "Spare parts kit - price TBD", quantity: "", unit: "", unitPrice: "" },
  ]);
  eq("described-but-unpriced row kept", lines.length, 2);
  eq("its extension is null", lines[1].extendedPrice, null);
  eq("it contributes nothing to the total", poLinesTotal(lines), 200);
  eq("and is counted as unpriced", unpricedLineCount(lines), 1);
}

{
  const lines = okLines([row({ unit: "" })]);
  eq("empty unit becomes null", lines[0].unit, null);
}

{
  const r = parsePoLines([
    { description: "", quantity: "10", unit: "ea", unitPrice: "84000" },
  ]);
  check(
    "a figure with no description is rejected",
    !r.ok && r.error === "Line 1 needs a description",
    r.ok ? "accepted it" : r.error,
  );
}

{
  const r = parsePoLines([row({ quantity: "twelve" })]);
  check(
    "non-numeric quantity is rejected, not silently dropped",
    !r.ok && r.error === "Line 1: quantity is not a number",
    r.ok ? "accepted it" : r.error,
  );
}

{
  const r = parsePoLines([row({ unitPrice: "abc" })]);
  check(
    "non-numeric unit price is rejected",
    !r.ok && r.error === "Line 1: unit price is not a number",
    r.ok ? "accepted it" : r.error,
  );
}

{
  const r = parsePoLines([row({ quantity: "-3" })]);
  check(
    "negative quantity is rejected",
    !r.ok && r.error === "Line 1: quantity cannot be negative",
    r.ok ? "accepted it" : r.error,
  );
}

{
  // The error numbers the line the user sees, which is the position AFTER
  // blank rows are dropped - not the raw array index.
  const r = parsePoLines([
    { description: "", quantity: "", unit: "", unitPrice: "" },
    { description: "", quantity: "5", unit: "ea", unitPrice: "10" },
  ]);
  check(
    "error numbering matches what the form shows",
    !r.ok && r.error === "Line 1 needs a description",
    r.ok ? "accepted it" : r.error,
  );
}

// ----------------------------------------------------------- poLinesTotal

section("poLinesTotal");

{
  const lines = okLines([]);
  eq("no lines is zero", poLinesTotal(lines), 0);
}

{
  // Each extension already rounds to cents, so the sum cannot drift.
  const lines = okLines([
    row({ description: "A", quantity: "3", unitPrice: "19.99" }),
    row({ description: "B", quantity: "7", unitPrice: "0.07" }),
  ]);
  eq("sum of rounded extensions", poLinesTotal(lines), round2(59.97 + 0.49));
  eq("and that is 60.46", poLinesTotal(lines), 60.46);
}

// ------------------------------------------------------- parsePoLinesField

section("parsePoLinesField");

{
  const r = parsePoLinesField(null);
  check("absent field is an empty set, not an error", r.ok && r.lines.length === 0);
}

{
  const r = parsePoLinesField("");
  check("empty string is an empty set", r.ok && r.lines.length === 0);
}

{
  const r = parsePoLinesField("{not json");
  check("malformed JSON is rejected", !r.ok, r.ok ? "accepted it" : "");
}

{
  const r = parsePoLinesField('{"description":"not an array"}');
  check("a non-array payload is rejected", !r.ok, r.ok ? "accepted it" : "");
}

{
  const payload = JSON.stringify([
    { description: "Recloser", quantity: "2", unit: "ea", unitPrice: "31,450.00" },
  ]);
  const r = parsePoLinesField(payload);
  check("round-trips a real payload", r.ok && r.lines.length === 1);
  if (r.ok) {
    eq("with the grouping stripped", r.lines[0].unitPrice, 31450);
    eq("and the extension right", r.lines[0].extendedPrice, 62900);
  }
}

// --------------------------------------------------------------------- report

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
