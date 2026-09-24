/**
 * Line items on a purchase order, worked against the real PO-023.
 *
 * Zarina: "I need to have option to add line items for PO forms. See PO form
 * we used." Every number below is off that document.
 */

import {
  derivedExtended,
  describeTotalAgreement,
  lineExtended,
  nextLineNo,
  poTotals,
  totalAgreement,
} from "../../src/lib/procurement-lines";

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
function check(name: string, ok: boolean, note = "") {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${note ? ` (${note})` : ""}`); console.log(`  FAIL  ${name}`); }
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// PO-023, Elevated Steel, 08 20 2026.
const PO_023 = [
  { line_no: 1, quantity: 71, description: 'Domestic Beam W6x25 cut @ (3.3m) 10\'.83"', units: "71", unit_price: 938.29, extended_price: 66618.59 },
  { line_no: 2, quantity: 410, description: 'Domestic Beam W6x9: cut @ (3.39m) 11\'.13"', units: "410", unit_price: 347.0, extended_price: 142270.0 },
  { line_no: 3, quantity: 1, description: "Domestic Beam W6x9 Cut @ (3.66m) 12'", units: "1", unit_price: 347.0, extended_price: 347.0 },
  { line_no: 4, quantity: 10, description: "Domestic Beam W6x15 Cut @ (3.66m) 12'", units: "10", unit_price: 624.39, extended_price: 6243.9 },
  { line_no: 5, quantity: 1, description: "HDG Included in pricing", units: "1", unit_price: null, extended_price: null },
  { line_no: 6, quantity: 1, description: "Freight to Orange, VA 22960- 3 trucks", units: "1", unit_price: 22444.5, extended_price: null },
];

console.log("\nPO-023 as it is printed");
console.log("-----------------------");

eq("line 1 derives from quantity and unit price", derivedExtended(PO_023[0]), 66618.59);
eq("line 2 as well", derivedExtended(PO_023[1]), 142270);
eq("line 4 carries its cents", derivedExtended(PO_023[2 + 1]), 6243.9);
eq("a line with no unit price derives nothing", derivedExtended(PO_023[4]), null);

const t = poTotals({ lines: PO_023, salesTax: null, freight: 22444.5 });
eq("the subtotal is the extended prices, nothing else", t.subtotal, 215479.49);
eq("a tax-exempt project reads zero tax", t.salesTax, 0);
eq("freight sits below the subtotal, not inside it", t.freight, 22444.5);
eq("and the total is what the document says", t.total, 237923.99);

eq(
  "the freight line is counted as priced but not extended, not silently dropped",
  t.pricedButNotExtended,
  1,
);

check(
  "freight is never counted twice",
  t.subtotal + t.freight === t.total && t.subtotal < 22444.5 + t.subtotal,
);

eq("a line with no extended price contributes nothing", lineExtended(PO_023[5]), 0);
eq("and one with an extended price contributes it", lineExtended(PO_023[0]), 66618.59);

console.log("\nAdding lines");
console.log("------------");

eq("the next line follows the highest", nextLineNo(PO_023), 7);
eq("an empty PO starts at 1", nextLineNo([]), 1);
eq("gaps do not reset the count", nextLineNo([{ line_no: 3 }, { line_no: 9 }]), 10);
eq("unnumbered lines still yield a first number", nextLineNo([{ line_no: null }]), 1);

console.log("\nAgainst the PO value");
console.log("--------------------");

eq("no lines is nothing to reconcile", totalAgreement({ lines: [] }), { state: "no_lines" });

eq(
  "an unset PO value simply takes the lines",
  totalAgreement({ lines: PO_023, freight: 22444.5, poValue: 0 }),
  { state: "adopt", total: 237923.99 },
);

eq(
  "a matching value is left alone",
  totalAgreement({ lines: PO_023, freight: 22444.5, poValue: 237923.99 }),
  { state: "agrees", total: 237923.99 },
);

eq(
  "a cent of rounding still agrees",
  totalAgreement({ lines: PO_023, freight: 22444.5, poValue: 237923.994 }).state,
  "agrees",
);

const off = totalAgreement({ lines: PO_023, freight: 22444.5, poValue: 215479.49 });
eq("a real gap is reported, not applied", off.state, "disagrees");
check(
  "and the gap is named to the cent",
  off.state === "disagrees" && off.difference === 22444.5,
  JSON.stringify(off),
);

check(
  "the sentence names both figures and says nothing has moved",
  (() => {
    const line = describeTotalAgreement(off, money) ?? "";
    return (
      line.includes("$237,923.99") &&
      line.includes("$215,479.49") &&
      line.includes("$22,444.50") &&
      line.includes("Nothing is changed")
    );
  })(),
);

eq("agreement says nothing", describeTotalAgreement({ state: "agrees", total: 1 }, money), null);
eq("and neither does an empty table", describeTotalAgreement({ state: "no_lines" }, money), null);

check(
  "an unset value explains that saving will fill it",
  (describeTotalAgreement({ state: "adopt", total: 237923.99 }, money) ?? "").includes("not set"),
);

console.log("\nEdge cases");
console.log("----------");

eq("an empty table totals zero, not NaN", poTotals({ lines: [] }).total, 0);
eq(
  "tax and freight alone still total",
  poTotals({ lines: [], salesTax: 100, freight: 50 }).total,
  150,
);
eq(
  "a zero extended price is a real zero, not a missing one",
  poTotals({ lines: [{ unit_price: 10, extended_price: 0 }] }).pricedButNotExtended,
  0,
);
eq(
  "fractional quantities round to the cent",
  derivedExtended({ quantity: 3.333, unit_price: 10 }),
  33.33,
);
eq("a negative line is allowed, for a credit", poTotals({ lines: [{ extended_price: -500 }] }).subtotal, -500);

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
