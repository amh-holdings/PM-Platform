// Change orders that raise the price of scope the SOV already carries.
//
// Run: npx tsx scripts/sov-amendments/run-tests.ts

import {
  allocatedFromLine,
  allocationBlocker,
  coSovImpact,
  effectiveLineProgress,
  rollUpAmendments,
  type AmendmentRow,
  type LineMoney,
  type SovLine,
} from "@/lib/sov-amendments";

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

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

// Sweet Springs, as the executed contract and the backfill scripts record it.
const POI: SovLine = {
  id: "l-505", itemNumber: "5.05", description: "POI Procurement",
  scheduledValue: 168335.32, changeOrderId: null,
};
const MOB: SovLine = {
  id: "l-601", itemNumber: "6.01", description: "Mobilization",
  scheduledValue: 100000, changeOrderId: null,
};
const FENCE: SovLine = {
  id: "l-603", itemNumber: "6.03", description: "Fencing/SWPPP",
  scheduledValue: 125000, changeOrderId: null,
};
const CO4_LINE: SovLine = {
  id: "l-1400", itemNumber: "14.00", description: "Change Order Four",
  scheduledValue: 67458.31, changeOrderId: "co-4",
};
const CO5_LINE: SovLine = {
  id: "l-1500", itemNumber: "15.00", description: "Piles",
  scheduledValue: 102351.52, changeOrderId: "co-5",
};
const CO2_LINE: SovLine = {
  id: "l-1700", itemNumber: "17.00", description: "CO-02 - Site work increases",
  scheduledValue: 40000, changeOrderId: "co-2",
};

const ALL = [POI, MOB, FENCE, CO4_LINE, CO5_LINE, CO2_LINE];
const CO_NUMBERS = new Map([
  ["l-1400", "CO-04"],
  ["l-1500", "CO-05"],
  ["l-1700", "CO-02"],
]);

section("The POI case, which is why this exists");
{
  // CO-04 raises POI. Before the allocation, 5.05 reads finished the moment
  // its contract value is billed.
  const none = rollUpAmendments(ALL, [], CO_NUMBERS);
  eq("with no allocation, current is the contract figure", none.get("l-505")!.currentValue, 168335.32);
  eq("and nothing is credited to it", none.get("l-505")!.sources.length, 0);

  const amendments: AmendmentRow[] = [
    { amendment_line_id: "l-1400", base_line_id: "l-505", amount: 67458.31 },
  ];
  const r = rollUpAmendments(ALL, amendments, CO_NUMBERS);
  const poi = r.get("l-505")!;
  eq("contract value is untouched", poi.contractValue, 168335.32);
  eq("the change order is added", poi.amendedValue, 67458.31);
  eq("current scope is the sum", poi.currentValue, 235793.63);
  eq("and it names the change order", poi.sources[0].coNumber, "CO-04");

  // The number Phil will actually look at.
  const billed = 168335.32;
  const pctBefore = (billed / poi.contractValue) * 100;
  const pctAfter = (billed / poi.currentValue) * 100;
  eq("billed to the contract figure used to read 100%", Math.round(pctBefore), 100);
  eq("and now reads 71%", Math.round(pctAfter), 71);
}

section("One change order across two contract lines");
{
  // CO-02 adds cost to Mobilization AND Fencing. A pointer could not express
  // this; an amount per pair can.
  const amendments: AmendmentRow[] = [
    { amendment_line_id: "l-1700", base_line_id: "l-601", amount: 25000 },
    { amendment_line_id: "l-1700", base_line_id: "l-603", amount: 15000 },
  ];
  const r = rollUpAmendments(ALL, amendments, CO_NUMBERS);
  eq("mobilization grows by its share", r.get("l-601")!.currentValue, 125000);
  eq("fencing grows by its share", r.get("l-603")!.currentValue, 140000);
  eq("the whole CO line is spoken for", allocatedFromLine("l-1700", amendments), 40000);

  const impact = coSovImpact([CO2_LINE], ALL, amendments);
  eq("the CO reads as an amendment", impact.kind, "amends");
  eq("naming both contract lines", impact.amends.map((a) => a.itemNumber), ["6.01", "6.03"]);
  eq(
    "each one says which CO line it came from, so Unlink knows what to undo",
    impact.amends.map((a) => a.fromItemNumber),
    ["17.00", "17.00"],
  );
  eq("with nothing left as new scope", impact.newScopeTotal, 0);
}

section("New scope is not a defect");
{
  // CO-05 Piles is entirely new. It allocates nothing and that is correct.
  const impact = coSovImpact([CO5_LINE], ALL, []);
  eq("a CO with an unallocated line adds scope", impact.kind, "adds");
  eq("all of it is new", impact.newScopeTotal, 102351.52);
  eq("and it amends nothing", impact.amends.length, 0);
}

section("A change order that moves no money");
{
  // CO-03 is a completion-date change. No lines, no allocations.
  const impact = coSovImpact([], ALL, []);
  eq("reads as no SOV impact, not as a gap", impact.kind, "none");
  eq("no amendments", impact.amends.length, 0);
  eq("no lines", impact.lines.length, 0);
}

section("A change order that does both");
{
  const amendments: AmendmentRow[] = [
    { amendment_line_id: "l-1700", base_line_id: "l-601", amount: 25000 },
  ];
  const impact = coSovImpact([CO2_LINE], ALL, amendments);
  eq("half against a contract line, half new", impact.kind, "mixed");
  eq("the amended half", impact.amendedTotal, 25000);
  eq("the new half", impact.newScopeTotal, 15000);
  eq("the line reports its own split", impact.lines[0].newScope, 15000);
}

section("Totals never move");
{
  // The point of allocating rather than rewriting: the SOV still sums to the
  // same number, because nothing was added or removed.
  const amendments: AmendmentRow[] = [
    { amendment_line_id: "l-1400", base_line_id: "l-505", amount: 67458.31 },
    { amendment_line_id: "l-1700", base_line_id: "l-601", amount: 25000 },
  ];
  const sovTotal = ALL.reduce((s, l) => s + l.scheduledValue, 0);
  const r = rollUpAmendments(ALL, amendments, CO_NUMBERS);
  let contractSideTotal = 0;
  r.forEach((v, id) => {
    // A change order line's own value plus what it handed to contract lines
    // would double count, so sum current value on contract lines and
    // UNALLOCATED value on change order lines.
    const line = ALL.find((l) => l.id === id)!;
    contractSideTotal +=
      line.changeOrderId == null
        ? v.currentValue
        : line.scheduledValue - allocatedFromLine(id, amendments);
  });
  eq("allocating moves no money", Math.round(contractSideTotal * 100), Math.round(sovTotal * 100));
}

section("Allocations that must be refused");
{
  const base = {
    amendmentLineValue: 67458.31,
    allocatedElsewhere: 0,
    targetIsChangeOrderLine: false,
    targetIsSameLine: false,
  };
  eq("a clean allocation passes", allocationBlocker({ ...base, amount: 67458.31 }), null);
  check(
    "a line cannot amend itself",
    /cannot amend itself/.test(allocationBlocker({ ...base, amount: 100, targetIsSameLine: true }) ?? ""),
  );
  check(
    "chains are refused",
    /another change order/.test(
      allocationBlocker({ ...base, amount: 100, targetIsChangeOrderLine: true }) ?? "",
    ),
  );
  check(
    "over-allocating is refused, not warned about",
    /left to allocate/.test(allocationBlocker({ ...base, amount: 80000 }) ?? ""),
  );
  check(
    "and refused against what is already spoken for",
    /left to allocate/.test(
      allocationBlocker({ ...base, amount: 40000, allocatedElsewhere: 40000 }) ?? "",
    ),
  );
  eq(
    "allocating exactly the remainder passes",
    allocationBlocker({ ...base, amount: 27458.31, allocatedElsewhere: 40000 }),
    null,
  );
  check("zero is not an allocation", allocationBlocker({ ...base, amount: 0 }) !== null);
  check(
    "a positive allocation off a credit line is refused",
    /opposite way/.test(
      allocationBlocker({ ...base, amount: 500, amendmentLineValue: -5000 }) ?? "",
    ),
  );
  eq(
    "a credit allocates a credit",
    allocationBlocker({ ...base, amount: -500, amendmentLineValue: -5000 }),
    null,
  );
}

section("Rough edges");
{
  // An allocation pointing at a line that is gone must not take the page down.
  const r = rollUpAmendments(ALL, [
    { amendment_line_id: "l-1400", base_line_id: "l-deleted", amount: 1000 },
  ]);
  eq("an orphan allocation is ignored", r.size, ALL.length);
  eq("and changes nothing", r.get("l-505")!.currentValue, 168335.32);

  // Numerics come back from PostgREST as strings.
  const asText = rollUpAmendments(ALL, [
    { amendment_line_id: "l-1400", base_line_id: "l-505", amount: "67458.31" },
  ]);
  eq("a string amount is read as money", asText.get("l-505")!.currentValue, 235793.63);

  const nulled = rollUpAmendments(ALL, [
    { amendment_line_id: "l-1400", base_line_id: "l-505", amount: null },
  ]);
  eq("a null amount is zero", nulled.get("l-505")!.currentValue, 168335.32);

  // Every line gets an entry so the caller never branches on undefined.
  const all = rollUpAmendments(ALL, []);
  eq("every line is present", all.size, ALL.length);
}

section("Scope and billing move together");
{
  // Sweet Springs actually billed CO-04 on line 14.00, on AFP 9. Crediting
  // 5.05 with the scope while leaving the billing on 14.00 would show 5.05
  // further behind than it is and 14.00 impossibly ahead.
  const billed = new Map<string, LineMoney>([
    ["l-505", { previous: 168335.32, current: 0 }],
    ["l-1400", { previous: 67458.31, current: 0 }],
  ]);
  const amendments: AmendmentRow[] = [
    { amendment_line_id: "l-1400", base_line_id: "l-505", amount: 67458.31 },
  ];
  const e = effectiveLineProgress(ALL, amendments, billed, CO_NUMBERS);

  const poi = e.get("l-505")!;
  eq("POI absorbs the change order's scope", poi.scope, 235793.63);
  eq("and its billing with it", poi.billed, 235793.63);
  eq("so POI reads fully billed, correctly", Math.round((poi.billed / poi.scope) * 100), 100);

  const co4 = e.get("l-1400")!;
  eq("the CO line keeps no scope of its own", co4.scope, 0);
  eq("and it can say how many lines it went to", co4.allocatedToCount, 1);
  eq("and no billing of its own", co4.billed, 0);

  // The invariant that makes this safe.
  let scope = 0;
  let paid = 0;
  e.forEach((v) => {
    scope += v.scope;
    paid += v.billed;
  });
  eq(
    "total scope is still the SOV total",
    Math.round(scope * 100),
    Math.round(ALL.reduce((s2, l) => s2 + l.scheduledValue, 0) * 100),
  );
  eq("and total billed is still what was billed", Math.round(paid * 100), Math.round(235793.63 * 100));
}

{
  // A CO line split across two contract lines sends each its own share of the
  // billing, not all of it to whichever was allocated first.
  const billed = new Map<string, LineMoney>([
    ["l-1700", { previous: 20000, current: 0 }],
  ]);
  const amendments: AmendmentRow[] = [
    { amendment_line_id: "l-1700", base_line_id: "l-601", amount: 30000 },
    { amendment_line_id: "l-1700", base_line_id: "l-603", amount: 10000 },
  ];
  const e = effectiveLineProgress(ALL, amendments, billed, CO_NUMBERS);
  eq("mobilization takes three quarters of the billing", e.get("l-601")!.billed, 15000);
  eq("fencing takes the other quarter", e.get("l-603")!.billed, 5000);
  eq("and the CO line is left with none", e.get("l-1700")!.billed, 0);
  eq("split across two lines, and it says two", e.get("l-1700")!.allocatedToCount, 2);
  eq("nor any scope", e.get("l-1700")!.scope, 0);
}

{
  // Partially allocated: the unallocated half stays on the CO line, billing
  // included.
  const billed = new Map<string, LineMoney>([["l-1700", { previous: 40000, current: 0 }]]);
  const amendments: AmendmentRow[] = [
    { amendment_line_id: "l-1700", base_line_id: "l-601", amount: 25000 },
  ];
  const e = effectiveLineProgress(ALL, amendments, billed, CO_NUMBERS);
  eq("the CO line keeps its new-scope half", e.get("l-1700")!.scope, 15000);
  eq("and that half's billing", e.get("l-1700")!.billed, 15000);
  eq("mobilization takes the rest", e.get("l-601")!.billed, 25000);
}

{
  // Previous and Current move as separate columns, so the table's two money
  // columns keep agreeing with the percentage beside them.
  const billed = new Map<string, LineMoney>([
    ["l-1400", { previous: 40000, current: 27458.31 }],
  ]);
  const e = effectiveLineProgress(
    ALL,
    [{ amendment_line_id: "l-1400", base_line_id: "l-505", amount: 67458.31 }],
    billed,
    CO_NUMBERS,
  );
  const poi = e.get("l-505")!;
  eq("previous moves as previous", poi.previous, 40000);
  eq("current moves as current", poi.current, 27458.31);
  eq("and they still add up", poi.billed, 67458.31);
  eq("the CO line is emptied of both", [e.get("l-1400")!.previous, e.get("l-1400")!.current], [0, 0]);
}

{
  // With no allocations the function is the identity, which is what keeps the
  // page correct before migration 0054 is applied.
  const billed = new Map<string, LineMoney>([["l-505", { previous: 100000, current: 20000 }]]);
  const e = effectiveLineProgress(ALL, [], billed);
  eq("no allocations, no movement in scope", e.get("l-505")!.scope, 168335.32);
  eq("no allocations, no movement in billing", e.get("l-505")!.billed, 120000);
  eq("a line nobody billed reads zero", e.get("l-601")!.billed, 0);

  // An orphan must not take money off one side and drop it.
  const orphan = effectiveLineProgress(
    ALL,
    [{ amendment_line_id: "l-1400", base_line_id: "l-gone", amount: 5000 }],
    billed,
  );
  eq("an orphan allocation moves nothing", orphan.get("l-1400")!.scope, 67458.31);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
