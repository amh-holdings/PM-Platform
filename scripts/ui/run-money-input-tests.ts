/**
 * Money boxes and their commas.
 *
 * Zarina: "Can you make sure that every amounts have commas?" Every read-only
 * figure went through formatCurrency and read $192,649.74; the editable ones
 * held a bare number, so 28462.75 sat in the box directly under it. At six and
 * seven figures that is not cosmetic - 2846275 and 28462.75 look alike at a
 * glance and only one of them is the amount on the pay application.
 */

import {
  liveMoneyInput,
  moneyFormValue,
  moneyInputFrom,
  parseMoneyInput,
  settleMoneyInput,
  stripMoney,
} from "../../src/lib/money-input";

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

console.log("\nTyping into a money box");
console.log("-----------------------");

eq("thousands group as you type", liveMoneyInput("28462"), "28,462");
eq("and keep grouping past a million", liveMoneyInput("3787186"), "3,787,186");
eq("cents come through", liveMoneyInput("28462.75"), "28,462.75");
eq("a trailing point survives, or the decimal cannot be typed", liveMoneyInput("28462."), "28,462.");
eq("one cent digit is fine mid-word", liveMoneyInput("28462.7"), "28,462.7");
eq("a third cent digit is refused, not silently saved", liveMoneyInput("28462.756"), "28,462.75");
eq("commas already there are not doubled", liveMoneyInput("28,462.75"), "28,462.75");
eq("a dollar sign pasted in is dropped", liveMoneyInput("$28,462.75"), "28,462.75");
eq("letters never reach the box", liveMoneyInput("28a4b6c2"), "28,462");
eq("a second decimal point is ignored", liveMoneyInput("28.46.2"), "28.46");
eq("empty stays empty", liveMoneyInput(""), "");
eq("a lone minus is a number being started", liveMoneyInput("-"), "-");
eq("negatives group too", liveMoneyInput("-1234.5"), "-1,234.5");

console.log("\nLeaving the box");
console.log("---------------");

eq("settles to two decimals", settleMoneyInput("28,462.7"), "28,462.70");
eq("a whole number gains its cents", settleMoneyInput("28462"), "28,462.00");
eq("a trailing point is resolved", settleMoneyInput("28,462."), "28,462.00");
eq("an empty box stays empty rather than becoming zero", settleMoneyInput(""), "");
eq("so does a box holding only a point", settleMoneyInput("."), "");

console.log("\nWhat the form posts");
console.log("-------------------");

// Every server action reads the field name and calls Number() on it.
// Number("28,462.75") is NaN, so the commas must never reach the form.
eq("the raw number travels, never the commas", moneyFormValue("28,462.75"), "28462.75");
eq("and it is a number the server can parse", Number(moneyFormValue("3,787,186.00")), 3787186);
eq("an empty box posts empty, not zero", moneyFormValue(""), "");
eq("a blank and a zero stay different answers", moneyFormValue("0"), "0");
eq("negatives post intact", moneyFormValue("-1,234.56"), "-1234.56");

console.log("\nSeeding from stored data");
console.log("------------------------");

eq("a stored number arrives grouped", moneyInputFrom(28462.75), "28,462.75");
eq("and gains its cents", moneyInputFrom(28462), "28,462.00");
eq("null is an empty box", moneyInputFrom(null), "");
eq("undefined too", moneyInputFrom(undefined), "");
eq("a numeric string from the driver still works", moneyInputFrom("103036.26"), "103,036.26");
eq("zero is a real value, not an empty box", moneyInputFrom(0), "0.00");

console.log("\nParsing");
console.log("-------");

eq("commas parse away", parseMoneyInput("192,649.74"), 192649.74);
eq("empty is nothing, not zero", parseMoneyInput(""), null);
eq("a lone point is nothing", parseMoneyInput("."), null);
eq("strip keeps one point and the digits", stripMoney("$1,2a3.4.5"), "123.45");

// The three figures from the September panel, end to end.
eq("5.05 reads back", moneyInputFrom(28462.75), "28,462.75");
eq("6.02 reads back", moneyInputFrom(103036.26), "103,036.26");
eq("6.03 reads back", moneyInputFrom(61150.73), "61,150.73");

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
