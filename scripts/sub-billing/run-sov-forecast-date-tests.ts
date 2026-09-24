/**
 * Which month a subcontractor SOV line's cost belongs in.
 *
 * Zarina, on Lumina's seven lines reading "all mapped" while the forecast
 * reported them as unmapped: "It is mapped." She was right. The sub billing
 * page counts a line mapped when its EVIDENCE source is set; the forecast
 * needed a SCHEDULE link. Both are called mapping, they are different columns,
 * and $481,983.11 of subcontract cost sat outside the curve on the difference.
 */

import {
  describeSovDateGap,
  describeSovDateSource,
  resolveSovMonth,
  type FinishResolver,
} from "../../src/lib/sov-forecast-date";

let passed = 0;
const failures: string[] = [];

function same(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name} - got ${a}, want ${b}`);
    console.log(`  FAIL  ${name} - got ${a}, want ${b}`);
  }
}

function check(name: string, cond: boolean) {
  same(name, cond, true);
}

// A small schedule. Every code here resolves; anything else does not.
const FINISHES: Record<string, string> = {
  "3.1": "2026-10-01",
  "3.2": "2026-11-01",
  "4.1": "2026-12-01",
  "5.1": "2027-01-01",
};
const finishOf: FinishResolver = (code) =>
  FINISHES[code] ? { wbs: code, month: FINISHES[code] } : null;

console.log("\nThe strongest mapping wins\n");

same(
  "an explicit milestone beats everything under it",
  resolveSovMonth({
    line: {
      itemNumber: "7",
      verificationMethod: "milestone",
      milestoneTaskWbsCode: "5.1",
      linkedTaskWbsCodes: ["3.1"],
      linkedCommodityIds: ["c1"],
    },
    finishOf,
    wbsByCommodityId: new Map([["c1", ["4.1"]]]),
  }),
  { month: "2027-01-01", source: "milestone", via: "5.1", why: null },
);

same(
  "a direct task link beats the commodities",
  resolveSovMonth({
    line: {
      itemNumber: "3",
      verificationMethod: "commodity",
      linkedTaskWbsCodes: ["4.1"],
      linkedCommodityIds: ["c1"],
    },
    finishOf,
    wbsByCommodityId: new Map([["c1", ["3.1"]]]),
  }).source,
  "tasks",
);

// A milestone naming a task that is not on the schedule must not swallow the
// line. The weaker mappings still get their turn.
same(
  "a milestone pointing at nothing falls through rather than blocking",
  resolveSovMonth({
    line: {
      itemNumber: "3",
      verificationMethod: "commodity",
      milestoneTaskWbsCode: "9.9",
      linkedCommodityIds: ["c1"],
    },
    finishOf,
    wbsByCommodityId: new Map([["c1", ["4.1"]]]),
  }).source,
  "commodity",
);

console.log("\nCommodities reach the schedule\n");

// This is the Lumina case. Mapped to commodity quantities, no direct task
// link, and the commodity is linked to a task through commodity_task_links.
same(
  "a commodity-mapped line is dated from the task its commodity links to",
  resolveSovMonth({
    line: { itemNumber: "2", verificationMethod: "commodity", linkedCommodityIds: ["c1"] },
    finishOf,
    wbsByCommodityId: new Map([["c1", ["3.1"]]]),
  }),
  { month: "2026-10-01", source: "commodity", via: "3.1", why: null },
);

// The line is not finished until every commodity it measures is, the same way
// a summary resolves to the last deliverable under it.
same(
  "across several commodities the latest finish wins",
  resolveSovMonth({
    line: {
      itemNumber: "4",
      verificationMethod: "commodity",
      linkedCommodityIds: ["c1", "c2"],
    },
    finishOf,
    wbsByCommodityId: new Map([
      ["c1", ["3.1"]],
      ["c2", ["4.1", "3.2"]],
    ]),
  }).month,
  "2026-12-01",
);

same(
  "commodity tasks that are not on the schedule are skipped, not fatal",
  resolveSovMonth({
    line: { itemNumber: "5", verificationMethod: "commodity", linkedCommodityIds: ["c1"] },
    finishOf,
    wbsByCommodityId: new Map([["c1", ["9.9", "3.2"]]]),
  }).via,
  "3.2",
);

console.log("\nMobilization\n");

same(
  "a mobilization line is dated to the first field report",
  resolveSovMonth({
    line: { itemNumber: "1", verificationMethod: "on_site" },
    finishOf,
    onSiteDate: "2026-08-04",
  }),
  { month: "2026-08-01", source: "on_site", via: null, why: null },
);

// A mob line that also carries a task link should use the task: the link is a
// deliberate statement and the field report is a fallback.
same(
  "a task link on a mob line still wins",
  resolveSovMonth({
    line: { itemNumber: "1", verificationMethod: "on_site", linkedTaskWbsCodes: ["3.1"] },
    finishOf,
    onSiteDate: "2026-08-04",
  }).source,
  "tasks",
);

same(
  "no field report yet means no date",
  resolveSovMonth({
    line: { itemNumber: "1", verificationMethod: "on_site" },
    finishOf,
    onSiteDate: null,
  }).month,
  null,
);

console.log("\nWhat it says when it cannot find a date\n");

// The old message said "has no dated task" for every case. On a line mapped to
// commodities that is false, and true-sounding enough that nobody checked.
const commodityGap = resolveSovMonth({
  line: { itemNumber: "2", verificationMethod: "commodity", linkedCommodityIds: ["c1"] },
  finishOf,
  wbsByCommodityId: new Map([["c1", ["9.9"]]]),
});
check(
  "a commodity line names the commodity mapping, not a missing task",
  (commodityGap.why ?? "").includes("no commodity on it is linked to a schedule task"),
);

check(
  "a commodity line with no commodity chosen says so the same way",
  (resolveSovMonth({
    line: { itemNumber: "2", verificationMethod: "commodity", linkedCommodityIds: [] },
    finishOf,
  }).why ?? "").includes("commodity quantities"),
);

check(
  "a mob line with no report says what is missing",
  (resolveSovMonth({
    line: { itemNumber: "1", verificationMethod: "on_site" },
    finishOf,
  }).why ?? "").includes("no field report"),
);

check(
  "a manual line says nothing in the app knows when it lands",
  (resolveSovMonth({
    line: { itemNumber: "6", verificationMethod: "manual" },
    finishOf,
  }).why ?? "").includes("by hand each period"),
);

check(
  "an unmapped line still reads as unmapped",
  (resolveSovMonth({ line: { itemNumber: "6", verificationMethod: "unmapped" }, finishOf }).why ?? "")
    .includes("no evidence source"),
);

check(
  "a method nobody recognises is treated as unmapped rather than crashing",
  (resolveSovMonth({ line: { itemNumber: "6", verificationMethod: "wingdings" }, finishOf }).why ?? "")
    .includes("no evidence source"),
);

const gap = describeSovDateGap({
  subName: "Lumina Energy Services, LLC",
  line: { itemNumber: "2", verificationMethod: "commodity" },
  at: commodityGap,
  remaining: 45868,
});
check("the warning names the sub", gap.includes("Lumina"));
check("the warning names the line", gap.includes("line 2"));
check("the warning names the money", gap.includes("45,868"));
check("the warning names the real cause", gap.includes("commodity"));

console.log("\nAnd when a weaker mapping supplied the date, it says so\n");

check(
  "a commodity-dated line is reported with the task it came from",
  (describeSovDateSource({
    subName: "Lumina",
    line: { itemNumber: "2" },
    at: resolveSovMonth({
      line: { itemNumber: "2", verificationMethod: "commodity", linkedCommodityIds: ["c1"] },
      finishOf,
      wbsByCommodityId: new Map([["c1", ["3.1"]]]),
    }),
  }) ?? "").includes("3.1"),
);

check(
  "a mob line is reported with the month",
  (describeSovDateSource({
    subName: "Lumina",
    line: { itemNumber: "1" },
    at: resolveSovMonth({
      line: { itemNumber: "1", verificationMethod: "on_site" },
      finishOf,
      onSiteDate: "2026-08-04",
    }),
  }) ?? "").includes("2026-08"),
);

// A direct task link is the ordinary case and needs no explaining.
same(
  "a plain task link is not reported",
  describeSovDateSource({
    subName: "Lumina",
    line: { itemNumber: "3" },
    at: resolveSovMonth({
      line: { itemNumber: "3", linkedTaskWbsCodes: ["3.1"] },
      finishOf,
    }),
  }),
  null,
);

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
