// Contract value: the agreement versus the SOV.
//
// Run: npx tsx scripts/project-financials/run-tests.ts

import {
  coLineDescription,
  compareItemNumbers,
  costToDate,
  deriveContractValue,
  nextSovItemNumber,
} from "@/lib/project-financials";
import { groupWarnings } from "@/lib/projection-warnings";
import type { ProjectionWarning } from "@/lib/projection";

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
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, actual === expected, actual === expected ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

console.log("\nContract value\n--------------");

{
  // Sweet Springs. The agreement is $2,507,500 plus $1,279,685.94 of approved
  // change orders. The SOV totalled $8,146,994.84, and the dashboard showed
  // that as the contract with the caption "Includes approved COs".
  const c = deriveContractValue({
    originalContractValue: 2507500,
    approvedCoValue: 1279685.94,
    sovTotal: 8146994.84,
  });
  eq("the contract is the agreement, not the SOV", c.value, 3787185.94);
  eq("and says so", c.basis, "agreement");
  eq("the drift is reported", c.sovDrift, 4359808.9);
  eq("and flagged", c.sovDisagrees, true);
}

{
  // The healthy case: the SOV was built from the contract and every approved
  // CO earned its line, so the two agree and nothing is flagged.
  const c = deriveContractValue({
    originalContractValue: 2507500,
    approvedCoValue: 1279685.94,
    sovTotal: 3787185.94,
  });
  eq("a matching SOV raises nothing", c.sovDisagrees, false);
  eq("and shows no drift", c.sovDrift, 0);
}

{
  // Under as well as over. An SOV short of the contract means work with no
  // line to bill against, which is just as wrong and easier to miss.
  const c = deriveContractValue({
    originalContractValue: 1000000,
    approvedCoValue: 0,
    sovTotal: 900000,
  });
  eq("an SOV under the contract is flagged too", c.sovDisagrees, true);
  eq("with a negative drift", c.sovDrift, -100000);
}

{
  // Float noise is not a finding. A cent is.
  const noise = deriveContractValue({
    originalContractValue: 1000000,
    approvedCoValue: 0.1 + 0.2,
    sovTotal: 1000000.3,
  });
  eq("a rounding artefact does not raise a flag", noise.sovDisagrees, false);
  const cent = deriveContractValue({
    originalContractValue: 1000000,
    approvedCoValue: 0,
    sovTotal: 1000000.01,
  });
  eq("a cent does", cent.sovDisagrees, true);
}

{
  // No original price on record. The SOV is the only answer available and is
  // reported as such rather than dressed up as the contract.
  const c = deriveContractValue({
    originalContractValue: null,
    approvedCoValue: 50000,
    sovTotal: 750000,
  });
  eq("falls back to the SOV", c.value, 750000);
  eq("and says where it came from", c.basis, "sov");
  eq("with nothing to disagree with", c.sovDisagrees, false);
}

{
  // A credit change order lowers the contract.
  const c = deriveContractValue({
    originalContractValue: 1000000,
    approvedCoValue: -25000,
    sovTotal: 975000,
  });
  eq("a credit CO reduces the contract", c.value, 975000);
  eq("and the SOV still agrees", c.sovDisagrees, false);
}


console.log("\nSOV item ordering\n-----------------");

{
  // The bug: Postgres orders item_number as text, so a schedule of values that
  // runs past nine sections buries 10 through 16 between 1.09 and 2.00. To
  // anyone scrolling a picker to the bottom, the list stops at 9.
  const asText = ["9.00", "10.00", "16.00", "2.00", "1.09"].slice().sort();
  eq("text order really does put 10.00 before 2.00", asText[1], "10.00");

  const natural = ["9.00", "10.00", "16.00", "2.00", "1.09"]
    .slice()
    .sort(compareItemNumbers);
  eq("natural order starts at 1.09", natural[0], "1.09");
  eq("then 2.00", natural[1], "2.00");
  eq("then 9.00", natural[2], "9.00");
  eq("then 10.00", natural[3], "10.00");
  eq("and ends at 16.00", natural[4], "16.00");
}

{
  // Within a section. Sweet Springs pads to two digits, and past nine the text
  // sort breaks here too: "5.10" would come before "5.02".
  const s = ["5.10", "5.02", "5.08"].slice().sort(compareItemNumbers);
  eq("5.02 comes first", s[0], "5.02");
  eq("then 5.08", s[1], "5.08");
  eq("and 5.10 last, not first", s[2], "5.10");

  // Each part is compared as a NUMBER, not as a decimal fraction - the same
  // rule WBS codes use. So an unpadded "5.1" is part one and sits with "5.01",
  // which is what somebody typing it means. It is not "5.10".
  eq("an unpadded 5.1 is part one", compareItemNumbers("5.1", "5.01"), 0);
  check("and so comes before 5.02", compareItemNumbers("5.1", "5.02") < 0);
}

{
  // Anything that is not a number sorts by text rather than throwing.
  const s = ["CO-03", "2.00", "GC", "1.01"].slice().sort(compareItemNumbers);
  eq("numbered lines still lead", s[0], "1.01");
  eq("and then the next one", s[1], "2.00");
  check("the lettered ones land after, in some stable order", s.includes("CO-03") && s.includes("GC"));
  eq("comparing a line to itself is zero", compareItemNumbers("CO-03", "CO-03"), 0);
}

{
  // Sweet Springs: the contract runs 1.00-12.00 and the change orders that
  // were billed on paper came in as 13.00-16.00. A new CO line is the next
  // section, not a sub-line of the last one.
  const sweetSprings = [
    "1.00", "1.01", "1.09", "1.10", "1.12",
    "2.00", "3.00", "4.00", "5.00", "5.08",
    "6.00", "7.00", "8.00", "9.00", "10.00",
    "11.00", "12.00", "13.00", "14.00", "15.00", "16.00",
  ];
  eq("the next SOV number is the next section", nextSovItemNumber(sweetSprings), "17.00");

  // Text sorting is why this is worth a test at all: "9.00" reads as the max
  // to anything comparing as strings, which would hand back "10.00" - a number
  // the sheet already uses.
  eq("not fooled by 9.00 sorting last as text", nextSovItemNumber(["8.00", "9.00", "10.00"]), "11.00");

  // Same rule as nextCoNumber: a withdrawn number is not a free slot.
  eq("a gap is not reused", nextSovItemNumber(["1.00", "2.00", "4.00"]), "5.00");

  // Non-numeric lines are skipped rather than throwing or poisoning the max.
  eq("lettered lines are ignored", nextSovItemNumber(["1.00", "CO-03", "GC"]), "2.00");
  eq("an empty SOV starts at one", nextSovItemNumber([]), "1.00");
  eq("blank entries are skipped", nextSovItemNumber(["", "  ", "3.00"]), "4.00");

  // Decimal width follows the sheet rather than being imposed.
  eq("a whole-number sheet stays whole", nextSovItemNumber(["1", "2"]), "3");
  eq("a one-decimal sheet stays one", nextSovItemNumber(["1.0", "2.0"]), "3.0");

  // Sub-lines do not raise the section. 5.08 is part of section five.
  eq("sub-lines do not advance the section", nextSovItemNumber(["5.00", "5.08"]), "6.00");
}

{
  eq(
    "the line description names the CO and its scope",
    coLineDescription("CO-03", "Completion date extension"),
    "CO-03 - Completion date extension",
  );
  eq(
    "a CO with no description still names itself",
    coLineDescription("CO-03", null),
    "CO-03",
  );
  eq("whitespace is not a description", coLineDescription("CO-03", "   "), "CO-03");
}

// ------------------------- Cost to date -------------------------
// The tile this replaces subtracted the whole budget at completion from cost
// booked to date and rendered the difference green. On Sweet Springs that read
// "-$2,772,168.71 under budget" on a job 5% built, which only meant the money
// had not been spent yet. Two different measurements, subtracted.
console.log("\nCost to date, against the plan for the same months\n--------------------------------------------------");

const APR = "2026-04-01";
const MAY = "2026-05-01";
const JUN = "2026-06-01";

{
  const r = costToDate(
    [
      { period_month: APR, planned_amount: 100, actual_amount: 120 },
      { period_month: MAY, planned_amount: 200, actual_amount: 190 },
      // Ahead of the cut-off: planned, not yet due, must not count.
      { period_month: JUN, planned_amount: 500, actual_amount: 0 },
    ],
    MAY,
  );
  eq("actual is the elapsed months only", r.actual, 310);
  eq("planned is the same elapsed months", r.planned, 300);
  eq("variance compares like with like", r.variance, 10);
  eq("and a plan was found", r.hasPlan, true);
}

// The case that mattered: no cost plan entered at all. Treating that as a plan
// of zero turns every dollar spent into an overrun, which is the same mistake
// as before pointing the other way. There is no answer, so there is no number.
{
  const r = costToDate(
    [
      { period_month: APR, planned_amount: 0, actual_amount: 562462.51 },
      { period_month: MAY, planned_amount: null, actual_amount: 0 },
    ],
    MAY,
  );
  eq("spend is still reported", r.actual, 562462.51);
  eq("but no variance is claimed", r.variance, null);
  eq("and the caller can tell why", r.hasPlan, false);
}

{
  const r = costToDate([], MAY);
  eq("no rows, no spend", r.actual, 0);
  eq("no rows, no variance", r.variance, null);
}

// Over plan must read as over plan, so the tile's colour means something.
{
  const r = costToDate([{ period_month: APR, planned_amount: 100, actual_amount: 175 }], APR);
  eq("overspend is positive", r.variance, 75);
}

// ------------------------- Forecast warnings -------------------------
console.log("\nGrouping what the forecast could not account for\n------------------------------------------------");

const w = (kind: ProjectionWarning["kind"], ref: string): ProjectionWarning => ({
  kind,
  ref,
  message: `${ref} ${kind}`,
});

{
  const groups = groupWarnings([
    w("billing_line_no_link", "13.00"),
    w("po_missing_milestones", "P-002"),
    w("task_no_dates", "1.09"),
    w("po_missing_milestones", "P-004"),
    w("po_missing_milestones", "P-005"),
  ]);
  // Most damaging first: a PO with no milestones is in the forecast nowhere,
  // because the cost code tied to it is skipped on the assumption the PO
  // supplies the cost.
  eq("POs first", groups[0].kind, "po_missing_milestones");
  eq("with their count", groups[0].items.length, 3);
  eq("then undated work", groups[1].kind, "task_no_dates");
  eq("then unmapped lines", groups[2].kind, "billing_line_no_link");
  eq("nothing invented", groups.length, 3);
  eq(
    "and nothing dropped",
    groups.reduce((n, g) => n + g.items.length, 0),
    5,
  );
}

{
  eq("no warnings, no groups", groupWarnings([]).length, 0);
}

// A kind added to the projection and not to the group list must still show up,
// because silently dropping one is the exact failure this grouping fixes.
{
  const odd = { kind: "brand_new_kind", ref: "X", message: "X something" } as unknown as ProjectionWarning;
  const groups = groupWarnings([odd, w("po_missing_milestones", "P-002")]);
  eq("the unknown kind survives", groups.some((g) => g.kind === "other"), true);
  eq(
    "and every warning is still present",
    groups.reduce((n, g) => n + g.items.length, 0),
    2,
  );
}



console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
