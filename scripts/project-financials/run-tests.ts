// Contract value: the agreement versus the SOV.
//
// Run: npx tsx scripts/project-financials/run-tests.ts

import { deriveContractValue } from "@/lib/project-financials";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
