/**
 * What is on file for a sub, and whether it is still good.
 *
 * The states are the whole point: ok, expiring, expired, undated, missing.
 * Collapsing any two of them puts a sub in the clear who is not.
 *
 * Run: npx tsx scripts/subs/run-compliance-tests.ts
 */

import {
  COMPLIANCE_ITEMS,
  complianceFor,
  complianceSummary,
  daysBetween,
  describeState,
  latestForCategory,
  worstState,
  type ComplianceDoc,
} from "../../src/lib/sub-compliance";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures.push(`${name} - got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    console.log(`  FAIL  ${name} - got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  } else {
    passed++;
    console.log(`  PASS  ${name}`);
  }
}

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

const TODAY = "2026-11-02";
const SUB = "sub-pyramid";
const OTHER = "sub-sunstall";

const doc = (p: Partial<ComplianceDoc> & { category: ComplianceDoc["category"] }): ComplianceDoc => ({
  id: p.id ?? `${p.category}-1`,
  file_name: p.file_name ?? `${p.category}.pdf`,
  category: p.category,
  // Explicit null means "attached to nobody", which is a case under test.
  // `?? SUB` would quietly turn that into "attached to this sub".
  subcontractor_id: p.subcontractor_id === undefined ? SUB : p.subcontractor_id,
  valid_until: p.valid_until ?? null,
  uploaded_at: p.uploaded_at ?? null,
});

const stateOf = (docs: ComplianceDoc[], category: string) =>
  complianceFor(SUB, docs, TODAY).find((r) => r.category === category)?.state;

// ============================================================================
section("Day maths");

eq("same day is zero", daysBetween(TODAY, "2026-11-02"), 0);
eq("tomorrow is one", daysBetween(TODAY, "2026-11-03"), 1);
eq("yesterday is minus one", daysBetween(TODAY, "2026-11-01"), -1);
eq("a timestamp is read as its date", daysBetween(TODAY, "2026-11-05T23:30:00Z"), 3);
// A month boundary, and a year one. Naive 30-day arithmetic gets these wrong.
eq("across a month", daysBetween("2026-11-28", "2026-12-02"), 4);
eq("across a year", daysBetween("2026-12-30", "2027-01-02"), 3);
eq("nonsense dates do not throw", daysBetween(TODAY, "not a date"), 0);

// ============================================================================
section("What each row reads");

eq("nothing attached is missing", stateOf([], "coi"), "missing");
eq(
  "a COI good for a year is ok",
  stateOf([doc({ category: "coi", valid_until: "2027-06-30" })], "coi"),
  "ok",
);
eq(
  "a COI that lapsed is expired",
  stateOf([doc({ category: "coi", valid_until: "2026-08-31" })], "coi"),
  "expired",
);
eq(
  "inside the warning window it is expiring",
  stateOf([doc({ category: "coi", valid_until: "2026-11-20" })], "coi"),
  "expiring",
);
// Expiry is end of day. Off by one here refuses to pay a sub whose paperwork
// is fine on the day it is checked.
eq(
  "a COI expiring today is still good today",
  stateOf([doc({ category: "coi", valid_until: TODAY })], "coi"),
  "expiring",
);
eq(
  "and expired the day after",
  stateOf([doc({ category: "coi", valid_until: "2026-11-01" })], "coi"),
  "expired",
);
eq(
  "exactly 30 days out is still a warning",
  stateOf([doc({ category: "coi", valid_until: "2026-12-02" })], "coi"),
  "expiring",
);
eq(
  "31 days out is clear",
  stateOf([doc({ category: "coi", valid_until: "2026-12-03" })], "coi"),
  "ok",
);
// The state that stops this becoming coi_status all over again.
eq(
  "a COI with no expiry recorded is NOT ok",
  stateOf([doc({ category: "coi", valid_until: null })], "coi"),
  "undated",
);
eq(
  "but a W-9 needs no expiry, because it does not expire",
  stateOf([doc({ category: "w9" })], "w9"),
  "ok",
);
eq(
  "a signed subcontract reads the same way",
  stateOf([doc({ category: "subcontract" })], "subcontract"),
  "ok",
);

// Another sub's paperwork must never clear this one.
eq(
  "a COI belonging to another sub does not count",
  stateOf([doc({ category: "coi", valid_until: "2027-01-01", subcontractor_id: OTHER })], "coi"),
  "missing",
);
// Nor must a loose project document with no owner.
eq(
  "an unattached COI does not count either",
  stateOf([doc({ category: "coi", valid_until: "2027-01-01", subcontractor_id: null })], "coi"),
  "missing",
);

// ============================================================================
section("Renewals");

const renewed = [
  doc({ id: "old", category: "coi", valid_until: "2026-08-31" }),
  doc({ id: "new", category: "coi", valid_until: "2027-08-31" }),
];
eq(
  "the current certificate wins over last year's",
  latestForCategory(renewed, SUB, "coi")?.id,
  "new",
);
eq("so the row is clear, not expired", stateOf(renewed, "coi"), "ok");
eq(
  "order on the way in does not matter",
  latestForCategory([renewed[1], renewed[0]], SUB, "coi")?.id,
  "new",
);
eq(
  "a dated certificate beats an undated one",
  latestForCategory(
    [doc({ id: "undated", category: "coi" }), doc({ id: "dated", category: "coi", valid_until: "2027-01-01" })],
    SUB,
    "coi",
  )?.id,
  "dated",
);
eq(
  "with neither dated, the newest upload wins",
  latestForCategory(
    [
      doc({ id: "first", category: "w9", uploaded_at: "2026-01-01T00:00:00Z" }),
      doc({ id: "second", category: "w9", uploaded_at: "2026-09-01T00:00:00Z" }),
    ],
    SUB,
    "w9",
  )?.id,
  "second",
);

// ============================================================================
section("The badge on the sub");

const rows = (docs: ComplianceDoc[]) => complianceFor(SUB, docs, TODAY);
const full = [
  doc({ category: "coi", valid_until: "2027-06-30" }),
  doc({ category: "w9" }),
  doc({ category: "subcontract" }),
];
eq("everything on file reads ok", worstState(rows(full)), "ok");
eq("one missing item outranks two good ones", worstState(rows(full.slice(0, 2))), "missing");
eq(
  "expired outranks expiring",
  worstState(
    rows([
      doc({ id: "a", category: "coi", valid_until: "2026-08-01" }),
      doc({ category: "w9" }),
      doc({ category: "subcontract" }),
    ]),
  ),
  "expired",
);
eq(
  "undated outranks expiring, since nobody knows if it is good at all",
  worstState([
    { category: "coi", label: "COI", state: "undated", document: null, validUntil: null, daysLeft: null },
    { category: "w9", label: "W-9", state: "expiring", document: null, validUntil: null, daysLeft: 5 },
  ]),
  "undated",
);
eq("no rows at all is not an alarm", worstState([]), "ok");

eq("every required item is checked", rows(full).length, COMPLIANCE_ITEMS.length);

// ============================================================================
section("What it says");

eq(
  "a lapsed certificate says how long ago",
  describeState(rows([doc({ category: "coi", valid_until: "2026-10-03" })])[0]),
  "Expired 30d ago",
);
eq(
  "one expiring today says so plainly",
  describeState(rows([doc({ category: "coi", valid_until: TODAY })])[0]),
  "Expires today",
);
eq(
  "an undated one says what is wrong with it",
  describeState(rows([doc({ category: "coi" })])[0]),
  "On file, no expiry recorded",
);
eq("a missing one is blunt", describeState(rows([])[0]), "Not on file");

eq(
  "the summary counts subs, not documents",
  complianceSummary(["ok", "ok", "expired", "missing"]),
  { clear: 2, attention: 2, total: 4 },
);
eq("nothing to report is not a warning", complianceSummary([]), {
  clear: 0,
  attention: 0,
  total: 0,
});

// ============================================================================
console.log("\n" + "=".repeat(60));
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(60));
process.exit(failures.length > 0 ? 1 : 0);
