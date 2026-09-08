// Change order buildup + Exhibit H - known-answer test harness.
//
// Pure functions only, no database. The numbers here are the ones that go on a
// document AHC signs and the owner counter-signs, so a rounding slip is not a
// cosmetic bug - it is a contract price that does not tie out.
//
// The Exhibit H cases are modelled on the Dimension Energy "Exhibit H - Form of
// Change Order" template, using Sweet Springs figures. They are an arithmetic
// answer key for the derivation, not a record of any executed change order.
//
// Run: npx tsx scripts/change-orders/run-tests.ts

import {
  addDays,
  canTransition,
  countsTowardContract,
  deriveExhibitH,
  nextCoNumber,
  parsePastedCostLines,
  priceBuildup,
  type CostLine,
  type ExhibitHProject,
} from "@/lib/change-order-pricing";

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

function line(over: Partial<CostLine> = {}): CostLine {
  return {
    id: over.id ?? "l1",
    sortOrder: 10,
    category: "material",
    description: "Line",
    vendorName: null,
    quantity: 1,
    unit: "ls",
    unitCost: 0,
    markupPct: null,
    costCodeId: null,
    notes: null,
    ...over,
  };
}

// ============================================================================
section("Buildup - markup inheritance");

{
  const b = priceBuildup({
    lines: [
      line({ id: "a", unitCost: 1000 }),
      line({ id: "b", unitCost: 1000, markupPct: 5 }),
    ],
    defaultMarkupPct: 10,
    bondPct: null,
    taxPct: null,
  });
  eq("a line with no markup inherits the CO default", b.lines[0].effectiveMarkupPct, 10);
  eq("the inherited flag is set", b.lines[0].markupInherited, true);
  eq("a line with its own markup overrides the default", b.lines[1].effectiveMarkupPct, 5);
  eq("the override is not flagged as inherited", b.lines[1].markupInherited, false);
  eq("direct cost sums the lines", b.directCost, 2000);
  eq("markup mixes both rates", b.markup, 150);
  eq("billable is cost plus markup", b.billable, 2150);
  eq("profit equals the markup", b.profit, 150);
}

{
  // A CO with no default markup and no line markup must not invent margin.
  const b = priceBuildup({
    lines: [line({ unitCost: 500 })],
    defaultMarkupPct: null,
    bondPct: null,
    taxPct: null,
  });
  eq("no default and no override means zero markup", b.markup, 0);
  eq("billable equals cost", b.billable, 500);
  eq("margin is zero, not null, when there is cost", b.effectiveMarginPct, 0);
}

{
  const b = priceBuildup({ lines: [], defaultMarkupPct: 10, bondPct: 2, taxPct: 7 });
  eq("an empty buildup bills nothing", b.billable, 0);
  eq("an empty buildup has no margin percentage", b.effectiveMarginPct, null);
}

section("Buildup - quantity, bond and tax");

{
  const b = priceBuildup({
    lines: [line({ quantity: 40, unit: "hr", unitCost: 87.5, category: "labor" })],
    defaultMarkupPct: 10,
    bondPct: null,
    taxPct: null,
  });
  eq("quantity times unit cost extends", b.lines[0].extendedCost, 3500);
  eq("markup applies to the extended cost", b.markup, 350);
}

{
  const b = priceBuildup({
    lines: [line({ unitCost: 10000 })],
    defaultMarkupPct: 10,
    bondPct: 2,
    taxPct: 0,
  });
  // Bond is a percent of cost + markup, not of bare cost.
  eq("bond is taken on the marked-up subtotal", b.bond, 220);
  eq("bond raises the billable", b.billable, 11220);
  // The critical one: bond is an outlay, so it must land in cost and NOT be
  // counted as profit. A naive billable - directCost would report $1,220.
  eq("bond lands in cost, not profit", b.totalCost, 10220);
  eq("profit stays equal to the markup", b.profit, 1000);
}

{
  const b = priceBuildup({
    lines: [line({ unitCost: 10000 })],
    defaultMarkupPct: 10,
    bondPct: null,
    taxPct: 7,
  });
  eq("tax is taken on the marked-up subtotal", b.tax, 770);
  eq("tax lands in cost, not profit", b.totalCost, 10770);
  eq("profit stays equal to the markup", b.profit, 1000);
}

section("Buildup - category roll-up");

{
  const b = priceBuildup({
    lines: [
      line({ id: "a", category: "labor", unitCost: 1000 }),
      line({ id: "b", category: "labor", unitCost: 500 }),
      line({ id: "c", category: "subcontractor", unitCost: 2000, markupPct: 5 }),
    ],
    defaultMarkupPct: 10,
    bondPct: null,
    taxPct: null,
  });
  eq("only categories in use are reported", b.byCategory.length, 2);
  const labor = b.byCategory.find((c) => c.category === "labor")!;
  const sub = b.byCategory.find((c) => c.category === "subcontractor")!;
  eq("labor cost rolls up", labor.cost, 1500);
  eq("labor billable carries the default markup", labor.billable, 1650);
  eq("sub billable carries its own markup", sub.billable, 2100);
}

section("Exhibit H - contract price lines");

const sweetSprings: ExhibitHProject = {
  name: "Sweet Springs Solar",
  client: "Dimension Energy",
  contractorLegalName: "American Helios Constructors (AHC)",
  agreementDate: "2024-06-28",
  originalContractValue: 2507500,
  contractValue: 2876175.48,
  guaranteedMechanicalCompletionDate: "2024-11-29",
  guaranteedSubstantialCompletionDate: "2025-02-28",
};

{
  // First CO on the job, so line 2 is blank: original $2,507,500.00 plus a
  // $368,675.48 change order gives a new price of $2,876,175.48.
  const h = deriveExhibitH(
    sweetSprings,
    {
      coNumber: "CO-01",
      dateOfChangeOrder: "2025-10-31",
      billable: 368675.48,
      mechCompletionDeltaDays: 0,
      substCompletionDeltaDays: 0,
    },
    [],
  );
  eq("line 1 is the original contract price", h.originalContractPrice, 2507500);
  eq("line 2 is zero with no prior COs", h.netPreviousChangeOrders, 0);
  eq("line 3 equals line 1 with no prior COs", h.contractPricePriorToThisCo, 2507500);
  eq("line 4 is this CO", h.thisChangeOrderAmount, 368675.48);
  eq("line 4 reads as an increase", h.direction, "increased");
  eq("line 5 ties out", h.newContractPrice, 2876175.48);
  eq("nothing is missing when the project is filled in", h.missing.length, 0);
}

{
  // Line 2 counts APPROVED COs only. A submitted CO is not "previously
  // authorized" and must not move the contract price.
  const h = deriveExhibitH(
    sweetSprings,
    {
      coNumber: "CO-03",
      dateOfChangeOrder: "2026-01-15",
      billable: 100000,
      mechCompletionDeltaDays: null,
      substCompletionDeltaDays: null,
    },
    [
      { id: "1", coNumber: "CO-01", coValue: 368675.48, status: "approved" },
      { id: "2", coNumber: "CO-02", coValue: 50000, status: "submitted" },
    ],
  );
  eq("only the approved CO counts in line 2", h.netPreviousChangeOrders, 368675.48);
  eq("the submitted CO is not listed", h.previousChangeOrderNumbers.join(","), "CO-01");
  eq("line 3 adds the approved prior CO", h.contractPricePriorToThisCo, 2876175.48);
  eq("line 5 stacks this CO on top", h.newContractPrice, 2976175.48);
}

{
  // CO numbers must sort naturally, so CO-10 lands after CO-9 on the form.
  const h = deriveExhibitH(
    sweetSprings,
    { coNumber: "CO-11", dateOfChangeOrder: null, billable: 0, mechCompletionDeltaDays: null, substCompletionDeltaDays: null },
    [
      { id: "c", coNumber: "CO-10", coValue: 1, status: "approved" },
      { id: "a", coNumber: "CO-2", coValue: 1, status: "approved" },
      { id: "b", coNumber: "CO-9", coValue: 1, status: "approved" },
    ],
  );
  eq("prior CO numbers sort numerically", h.previousChangeOrderNumbers.join(","), "CO-2,CO-9,CO-10");
}

{
  const h = deriveExhibitH(
    sweetSprings,
    {
      coNumber: "CO-04",
      dateOfChangeOrder: "2026-02-01",
      billable: -25000,
      mechCompletionDeltaDays: null,
      substCompletionDeltaDays: null,
    },
    [],
  );
  eq("a credit CO reads as a decrease", h.direction, "decreased");
  eq("a credit CO lowers the new contract price", h.newContractPrice, 2482500);
}

section("Exhibit H - schedule adjustment");

{
  const h = deriveExhibitH(
    sweetSprings,
    {
      coNumber: "CO-02",
      dateOfChangeOrder: "2025-01-02",
      billable: 1000,
      mechCompletionDeltaDays: 14,
      substCompletionDeltaDays: 0,
    },
    [],
  );
  eq("mechanical completion shifts by the delta", h.mechanical.revisedDate, "2024-12-13");
  eq("a positive delta reads as an increase", h.mechanical.direction, "increased");
  eq("a zero delta reads as unchanged", h.substantial.direction, "unchanged");
  eq("a zero delta leaves the date alone", h.substantial.revisedDate, "2025-02-28");
}

{
  // A null delta means the CO does not touch that date. The form still needs
  // the current date printed, so it must survive rather than come back null.
  const h = deriveExhibitH(
    sweetSprings,
    { coNumber: "CO-05", dateOfChangeOrder: null, billable: 0, mechCompletionDeltaDays: null, substCompletionDeltaDays: null },
    [],
  );
  eq("a null delta keeps the current date", h.mechanical.revisedDate, "2024-11-29");
  eq("a null delta reads as unchanged", h.mechanical.direction, "unchanged");
}

{
  eq("addDays crosses a month boundary", addDays("2024-11-29", 14), "2024-12-13");
  eq("addDays crosses a year boundary", addDays("2024-12-28", 7), "2025-01-04");
  eq("addDays handles a leap day", addDays("2024-02-28", 1), "2024-02-29");
  eq("addDays goes backwards", addDays("2025-03-01", -1), "2025-02-28");
}

section("Exhibit H - missing project data");

{
  const bare: ExhibitHProject = {
    name: "New Project",
    client: null,
    contractorLegalName: null,
    agreementDate: null,
    originalContractValue: null,
    contractValue: 1000000,
    guaranteedMechanicalCompletionDate: null,
    guaranteedSubstantialCompletionDate: null,
  };
  const h = deriveExhibitH(
    bare,
    { coNumber: "CO-01", dateOfChangeOrder: null, billable: 5000, mechCompletionDeltaDays: null, substCompletionDeltaDays: null },
    [],
  );
  eq("line 1 falls back to the current contract value", h.originalContractPrice, 1000000);
  eq("the fallback is flagged so the form is not signed blind", h.originalContractPriceIsFallback, true);
  eq("every missing field is reported", h.missing.length, 5);
  eq("the contractor name defaults to AHC", h.contractor, "American Helios Constructors (AHC)");
}

section("Workflow");

{
  eq("draft goes to internal review", canTransition("draft", "internal_review"), true);
  eq("draft cannot jump straight to approved", canTransition("draft", "approved"), false);
  eq("draft cannot be submitted without review", canTransition("draft", "submitted"), false);
  eq("internal review goes back to draft", canTransition("internal_review", "draft"), true);
  eq("submitted can be approved", canTransition("submitted", "approved"), true);
  eq("submitted can be rejected", canTransition("submitted", "rejected"), true);
  eq("a rejected CO can be reworked", canTransition("rejected", "internal_review"), true);
  eq("an approved CO cannot be silently voided", canTransition("approved", "void"), true);
  eq("an unknown status transitions nowhere", canTransition("bogus", "draft"), false);
}

{
  eq("only approved counts toward contract", countsTowardContract("approved"), true);
  eq("submitted does not count toward contract", countsTowardContract("submitted"), false);
  eq("rejected does not count toward contract", countsTowardContract("rejected"), false);
}


section("Bulk paste - column mapping");

{
  // The common case: copy straight out of Excel, tabs between cells.
  const r = parsePastedCostLines(
    [
      "Description\tQty\tUnit\tUnit Cost\tMarkup",
      "Racking storage\t3\tmo\t$1,250.00\t10",
      "Transformer storage\t3\tmo\t$980.50\t",
    ].join("\n"),
  );
  eq("the header row is detected", r.usedHeader, true);
  eq("both data rows parse", r.lines.length, 2);
  eq("nothing is skipped", r.skipped.length, 0);
  eq("currency formatting is stripped", r.lines[0].unitCost, 1250);
  eq("quantity parses", r.lines[0].quantity, 3);
  eq("unit carries through", r.lines[0].unit, "mo");
  eq("markup parses", r.lines[0].markupPct, 10);
  eq("a blank markup inherits rather than reading as zero", r.lines[1].markupPct, null);
}

{
  // Column order must come from the header, not from position.
  const r = parsePastedCostLines(
    ["Unit Cost\tDescription\tQty", "500\tPile driving\t12"].join("\n"),
  );
  eq("reordered columns still map", r.lines[0].description, "Pile driving");
  eq("reordered unit cost maps", r.lines[0].unitCost, 500);
  eq("reordered quantity maps", r.lines[0].quantity, 12);
}

{
  // Header aliases, because nobody labels the column "unitCost".
  const r = parsePastedCostLines(
    ["Item\tQuantity\tUOM\tRate\tOH&P\tSubcontractor\tType",
     "Trenching\t100\tlf\t42.50\t5\tACME Civil\tsub"].join("\n"),
  );
  eq("alias headers map", r.lines[0].description, "Trenching");
  eq("rate maps to unit cost", r.lines[0].unitCost, 42.5);
  eq("OH&P maps to markup", r.lines[0].markupPct, 5);
  eq("vendor maps", r.lines[0].vendorName, "ACME Civil");
  eq("category alias resolves", r.lines[0].category, "subcontractor");
}

section("Bulk paste - headerless and messy input");

{
  // No header, so fall back to the documented positional order.
  const r = parsePastedCostLines("Crane rental\t2\tday\t3500");
  eq("no header is detected", r.usedHeader, false);
  eq("the first row is treated as data, not a header", r.lines.length, 1);
  eq("positional description", r.lines[0].description, "Crane rental");
  eq("positional unit cost", r.lines[0].unitCost, 3500);
}

{
  const r = parsePastedCostLines("Lump sum scope,,,\t\t\t7500");
  eq("a blank quantity defaults to one", r.lines[0].quantity, 1);
}

{
  // CSV with a comma inside a quoted description must not split.
  const r = parsePastedCostLines('"Racking, delivered and stored",3,mo,1250');
  eq("a quoted comma does not split the row", r.lines[0].description, "Racking, delivered and stored");
  eq("the following columns still line up", r.lines[0].unitCost, 1250);
}

{
  // Credits show up as parentheses in every estimating package.
  const r = parsePastedCostLines("Deleted fencing\t1\tls\t(4,200.00)");
  eq("parentheses read as a credit", r.lines[0].unitCost, -4200);
}

section("Bulk paste - rows that cannot be used");

{
  // A row that cannot be read must be reported. Dropping it silently is how a
  // change order goes to the owner short a line.
  const r = parsePastedCostLines(
    [
      "Description\tQty\tUnit\tUnit Cost",
      "Good line\t1\tls\t100",
      "\t5\tea\t50",
      "No price here\t1\tls\tTBD",
      "",
      "Another good one\t2\tea\t25",
    ].join("\n"),
  );
  eq("only the readable rows become lines", r.lines.length, 2);
  eq("both bad rows are reported", r.skipped.length, 2);
  eq("the missing description is named", r.skipped[0].reason, "No description");
  eq("the unreadable price is named", r.skipped[1].reason, "No readable unit cost");
  eq("skipped rows report their real row number", r.skipped[0].row, 3);
  eq("blank rows are ignored, not reported", r.skipped.length, 2);
}

{
  const r = parsePastedCostLines("");
  eq("empty input parses to nothing", r.lines.length, 0);
  eq("empty input reports nothing skipped", r.skipped.length, 0);
}

{
  const r = parsePastedCostLines("Sitework\t1\tls\t1000", "labor");
  eq("the default category applies when none is given", r.lines[0].category, "labor");
}


section("Numbering");

{
  eq("the first CO on a project", nextCoNumber([]), "CO-01");
  eq("follows the existing sequence", nextCoNumber(["CO-01", "CO-02"]), "CO-03");
  // Sweet Springs is missing CO-03. That number was used and withdrawn, so
  // handing it out again would put two scopes under one number for the owner.
  eq(
    "skips gaps rather than reusing them",
    nextCoNumber(["CO-01", "CO-02", "CO-04", "CO-05", "CO-06"]),
    "CO-07",
  );
  eq("order of the input does not matter", nextCoNumber(["CO-06", "CO-01"]), "CO-07");
  eq("keeps a different prefix", nextCoNumber(["PCO 1", "PCO 2"]), "PCO 3");
  eq("keeps three-digit padding", nextCoNumber(["CO-001"]), "CO-002");
  eq("padding does not truncate past its width", nextCoNumber(["CO-99"]), "CO-100");
  eq("ignores entries with no number", nextCoNumber(["Draft CO", "CO-04"]), "CO-05");
  eq("falls back cleanly when nothing is numbered", nextCoNumber(["Draft"]), "CO-01");
  eq("tolerates whitespace", nextCoNumber([" CO-07 "]), "CO-08");
}

// ============================================================================
console.log("\n" + "=".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
