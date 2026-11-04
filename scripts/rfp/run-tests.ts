/**
 * The bid analyzer: leveling, foot checks, cost code baselines, extraction
 * cleanup, bidder flags, package coverage, document checklists, state
 * profiles.
 *
 * Run: npx tsx scripts/rfp/run-tests.ts
 */

import {
  REQUIRED_DOCS,
  bidderFlags,
  cleanExtractedLines,
  costCodeBaseline,
  coverageDeadlinePassed,
  footCheck,
  level,
  missingDocs,
  packageCoverage,
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

console.log("Definitions");
const docKeys = Object.values(REQUIRED_DOCS).flatMap((l) => l.map((d) => d.key));
eq("document keys are unique across stages", new Set(docKeys).size, docKeys.length);

console.log("Leveling");
const lv = level({
  bidders: [
    { id: "a", firm: "SCS", confirmed: true },
    { id: "b", firm: "Zholares", confirmed: true },
    { id: "c", firm: "Unchecked", confirmed: false },
  ],
  lines: [
    { bidder_id: "a", package: "civil", amount: 100 },
    { bidder_id: "a", package: "civil", amount: 50 },
    { bidder_id: "a", package: "mechanical", amount: 400 },
    { bidder_id: "a", package: "mechanical", amount: null },
    { bidder_id: "b", package: "mechanical", amount: 350 },
    { bidder_id: "c", package: "civil", amount: 1 },
  ],
  packages: ["electrical"],
  baseline: new Map([["civil", 120], ["mechanical", 380]]),
  carried: new Map<string, string | null>([["civil", "a"], ["mechanical", "b"]]),
});
eq("only confirmed bidders count", lv.bidders.map((b) => b.id), ["a", "b"]);
eq("rows in package order, invited scope included", lv.rows.map((r) => r.package), ["civil", "mechanical", "electrical"]);
eq("lines sum per package, blanks skipped", lv.rows[1].cells.map((c) => c.amount), [400, 350]);
eq("a package never priced is not bid, not zero", lv.rows[0].cells[1].amount, null);
eq("low shaded only with two prices", [lv.rows[0].cells.some((c) => c.isLow), lv.rows[1].cells.find((c) => c.isLow)?.bidderId], [false, "b"]);
eq("spread needs two prices", [lv.rows[0].spread, lv.rows[1].spread], [null, 50]);
eq("carried and variance", [lv.rows[0].carried, lv.rows[0].variance, lv.rows[1].variance], [150, 30, -30]);
eq("carried total", lv.carriedTotal, 500);
eq("baseline total", lv.baselineTotal, 500);
eq("uncarried packages listed", lv.uncarried, ["electrical"]);
eq("whole-scope rule: SCS carried for civil, also priced mechanical", lv.wholeScope, [
  { bidderId: "a", firm: "SCS", carriedIn: ["civil"], pricedButNotCarried: ["mechanical"] },
]);
const lv2 = level({
  bidders: [{ id: "a", firm: "SCS", confirmed: true }],
  lines: [{ bidder_id: "a", package: "civil", amount: 10 }],
  packages: [],
  baseline: new Map(),
  carried: new Map<string, string | null>([["civil", "z"]]),
});
eq("a carry pointing at a bidder with no price is ignored", [lv2.rows[0].carried, lv2.rows[0].carriedBidderId], [null, null]);

console.log("Foot check");
eq("within a dollar foots", footCheck(100, [{ amount: 60 }, { amount: 40.5 }]), { extracted: 100.5, foots: true, difference: 0.5 });
eq("off by more flags", footCheck(100, [{ amount: 60 }]).foots, false);
eq("no printed total, no verdict", footCheck(null, [{ amount: 60 }]).foots, null);

console.log("Cost code baseline");
eq(
  "mapped codes sum by package",
  Array.from(costCodeBaseline(
    [{ package: "civil", cost_code_id: "1" }, { package: "civil", cost_code_id: "2" }, { package: "electrical", cost_code_id: "3" }],
    [{ id: "1", estimated_cost: 100 }, { id: "2", estimated_cost: 50 }, { id: "3", estimated_cost: null }],
  ).entries()),
  [["civil", 150], ["electrical", 0]],
);

console.log("Extraction cleanup");
const cleaned = cleanExtractedLines(
  [
    { package: "civil", description: "Clearing", quantity: "12", unit: "AC", amount: "$1,200.50", source_ref: "Tab 5 row 9" },
    { package: "nonsense", description: "Fence", amount: 500 },
    { description: "", amount: 5 },
    { package: "civil", description: "Survey", amount: null },
    "junk",
  ],
  "mechanical",
);
eq("money strings parse", cleaned[0].amount, 1200.5);
eq("unknown package falls back to the invited one", cleaned[1].package, "mechanical");
eq("lines with no description drop", cleaned.length, 3);
eq("blank amount stays blank (excluded)", cleaned[2].amount, null);
eq("not an array returns nothing", cleanExtractedLines({ lines: [] }, "civil"), []);

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
