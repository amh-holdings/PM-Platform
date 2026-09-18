// Contract value: the agreement versus the SOV.
//
// Run: npx tsx scripts/project-financials/run-tests.ts

import { compareItemNumbers, deriveContractValue } from "@/lib/project-financials";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
