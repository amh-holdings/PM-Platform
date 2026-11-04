/**
 * The RFP workspace: runbook progress, bidder flags, package coverage,
 * document checklists, state profiles.
 *
 * Run: npx tsx scripts/rfp/run-tests.ts
 */

import {
  ALL_STEP_KEYS,
  REQUIRED_DOCS,
  RFP_PHASES,
  bidderFlags,
  coverageDeadlinePassed,
  currentPhase,
  missingDocs,
  packageCoverage,
  phaseProgress,
  stateCode,
  stateProfileGaps,
  type BidderLite,
} from "../../src/lib/rfp";

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

const bidder = (extra: Partial<BidderLite> = {}): BidderLite => ({
  id: "b1",
  firm: "Power Ray",
  package: "mechanical",
  kind: "sub",
  status: "invited",
  invited_on: "2026-10-01",
  last_contact_on: null,
  validity_date: null,
  license_verified_on: "2026-10-01",
  ...extra,
});

console.log("Runbook definition");
eq("step keys are unique", new Set(ALL_STEP_KEYS).size, ALL_STEP_KEYS.length);
eq("step keys carry their phase prefix", RFP_PHASES.every((p) => p.steps.every((s) => s.key.startsWith(`${p.key}.`))), true);
const docKeys = Object.values(REQUIRED_DOCS).flatMap((l) => l.map((d) => d.key));
eq("document keys are unique across stages", new Set(docKeys).size, docKeys.length);
eq("state profile is the second phase", RFP_PHASES[1].key, "state");
eq("every Phil review gate is a step", ["package.phil_review", "price.frozen", "proposal.submitted"].every((k) => ALL_STEP_KEYS.includes(k)), true);

console.log("Progress");
eq("nothing done starts at intake", currentPhase([])?.key, "intake");
const intakeDone = RFP_PHASES[0].steps.map((s) => s.key);
eq("intake done moves to the state profile", currentPhase(intakeDone)?.key, "state");
eq("all done means no current phase", currentPhase(ALL_STEP_KEYS), null);
eq("a skipped step holds the phase open", currentPhase([...intakeDone.slice(1)])?.key, "intake");
eq("unknown keys are ignored", phaseProgress(["retired.step"]).reduce((n, p) => n + p.done, 0), 0);
eq("intake counts all six", phaseProgress(intakeDone)[0], { key: "intake", done: 6, total: 6, complete: true });

console.log("Bidder flags");
eq("13 days quiet is fine", bidderFlags(bidder({ invited_on: "2026-10-01" }), "2026-10-14"), []);
eq("14 days quiet is silent", bidderFlags(bidder({ invited_on: "2026-10-01" }), "2026-10-15"), [{ kind: "silent", days: 14 }]);
eq("last contact resets the clock", bidderFlags(bidder({ last_contact_on: "2026-10-10" }), "2026-10-15"), []);
eq("a received bid is never silent", bidderFlags(bidder({ status: "received" }), "2026-12-01"), []);
eq("a decline raises nothing", bidderFlags(bidder({ status: "declined", license_verified_on: null }), "2026-12-01"), []);
eq("validity inside two weeks warns", bidderFlags(bidder({ status: "received", validity_date: "2026-10-20" }), "2026-10-10"), [{ kind: "validity_soon", days: 10 }]);
eq("lapsed validity flags", bidderFlags(bidder({ status: "carried", validity_date: "2026-10-04" }), "2026-10-10"), [{ kind: "validity_lapsed", days: 6 }]);
eq("unverified license on a sub", bidderFlags(bidder({ license_verified_on: null, last_contact_on: "2026-10-10" }), "2026-10-12"), [{ kind: "license_unverified" }]);
eq("suppliers need no license", bidderFlags(bidder({ kind: "supplier", license_verified_on: null, last_contact_on: "2026-10-10" }), "2026-10-12"), []);
eq("silence counts across a month end", bidderFlags(bidder({ invited_on: "2026-09-25" }), "2026-10-09"), [{ kind: "silent", days: 14 }]);

console.log("Coverage");
const cov = packageCoverage([
  bidder({ id: "1", package: "electrical" }),
  bidder({ id: "2", package: "mechanical" }),
  bidder({ id: "3", package: "mechanical", status: "received" }),
  bidder({ id: "4", package: "mechanical", status: "declined" }),
  bidder({ id: "5", package: "medium_voltage", status: "declined" }),
]);
eq("packages come back in runbook order", cov.map((c) => c.package), ["mechanical", "electrical", "medium_voltage"]);
eq("one live electrical bidder is thin", cov.find((c) => c.package === "electrical")?.thin, true);
eq("two live mechanical is not thin but below target", [cov[0].live, cov[0].thin, cov[0].belowTarget], [2, false, true]);
eq("received is counted", cov[0].received, 1);
eq("a package with only declines has zero live", cov.find((c) => c.package === "medium_voltage")?.live, 0);
eq("coverage alarm inside two weeks of due", coverageDeadlinePassed("2026-10-20", "2026-10-06"), true);
eq("coverage alarm quiet before that", coverageDeadlinePassed("2026-10-21", "2026-10-06"), false);
eq("no due date, no alarm", coverageDeadlinePassed(null, "2026-10-06"), false);

console.log("Documents");
eq("a sub owes 16 items with the bid", missingDocs("sub", "with_bid", []).length, 16);
eq("checked items drop off", missingDocs("sub", "with_bid", ["bid_sheet", "coi_current"]).length, 14);
eq("a supplier owes no sub documents", missingDocs("supplier", "with_bid", []).length, 0);
eq("a supplier owes the quote list", missingDocs("supplier", "supplier", []).length, 8);
eq("a sub owes no supplier list", missingDocs("sub", "supplier", []).length, 0);

console.log("State profiles");
eq("state code upper-cases", stateCode(" de "), "DE");
eq("full names are not codes", stateCode("Delaware"), null);
eq("blank is null", stateCode(""), null);
eq("no profile lacks every required field", stateProfileGaps(null), ["labor", "licensing", "contractor_bond_tax", "sales_tax"]);
eq("whitespace counts as blank", stateProfileGaps({ labor: "IRA", licensing: " ", contractor_bond_tax: "6%", sales_tax: "x" }), ["licensing"]);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
