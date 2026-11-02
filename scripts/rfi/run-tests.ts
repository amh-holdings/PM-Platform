/**
 * The RFI log - known-answer tests.
 *
 * The state is derived from dates rather than stored, so the derivation is the
 * thing that has to be right: get it wrong and a question sits on the wrong
 * desk, which is the one failure a log exists to prevent.
 *
 * Run: npx tsx scripts/rfi/run-tests.ts
 */

import {
  compareRfis,
  daysBetween,
  daysOpen,
  daysWithEor,
  isOverdue,
  nextRfiNumber,
  rfiState,
  sortRfis,
  summarise,
  wasLate,
  type RfiRow,
} from "../../src/lib/rfi-log";

let passed = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name} - got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    console.log(`  FAIL  ${name} - got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

function check(name: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
  }
}

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

const TODAY = "2026-11-02";

const rfi = (p: Partial<RfiRow> = {}): RfiRow => ({
  id: p.id ?? "r1",
  rfi_number: p.rfi_number ?? "RFI-001",
  subject: p.subject ?? "Pile embedment at the swale",
  question: p.question ?? "Confirm embedment where cover is under 18 inches.",
  discipline: p.discipline ?? "Civil",
  wbs_code: p.wbs_code ?? null,
  subcontractor_id: p.subcontractor_id ?? "sub-scs",
  raised_by: p.raised_by ?? "Ret Tucker",
  eor_firm: p.eor_firm ?? "Exactus",
  eor_contact: p.eor_contact ?? null,
  received_at: p.received_at ?? "2026-10-20",
  sent_to_eor_at: p.sent_to_eor_at ?? null,
  answered_at: p.answered_at ?? null,
  closed_at: p.closed_at ?? null,
  response_needed_by: p.response_needed_by ?? null,
  answer: p.answer ?? null,
  cost_impact: p.cost_impact ?? false,
  schedule_impact: p.schedule_impact ?? false,
});

// ============================================================================
section("Whose desk is it on");

eq("just received, it is ours to forward", rfiState(rfi()), "with_us");
eq(
  "forwarded, it is the engineer's",
  rfiState(rfi({ sent_to_eor_at: "2026-10-21" })),
  "with_eor",
);
eq(
  "answered, it is ours to pass back",
  rfiState(rfi({ sent_to_eor_at: "2026-10-21", answered_at: "2026-10-28" })),
  "answered",
);
eq(
  "closed is closed",
  rfiState(
    rfi({ sent_to_eor_at: "2026-10-21", answered_at: "2026-10-28", closed_at: "2026-10-29" }),
  ),
  "closed",
);
// Read backwards from the end, or a question answered on the phone and
// written up afterwards goes back on the to-do list.
eq(
  "an answer with no sent date is still answered",
  rfiState(rfi({ answered_at: "2026-10-28" })),
  "answered",
);
eq(
  "and a closed one with no answer date is still closed",
  rfiState(rfi({ closed_at: "2026-10-29" })),
  "closed",
);

// ============================================================================
section("How long");

eq("same day is zero", daysBetween(TODAY, TODAY), 0);
eq("across a month", daysBetween("2026-10-28", "2026-11-02"), 5);
eq("across a year", daysBetween("2026-12-30", "2027-01-02"), 3);
eq("nonsense does not throw", daysBetween(TODAY, "soon"), 0);

eq("an open one counts to today", daysOpen(rfi({ received_at: "2026-10-20" }), TODAY), 13);
// To answered, not to closed: our delay in passing it on should not flatter
// the engineer's turnaround.
eq(
  "an answered one stops at the answer, not the close",
  daysOpen(rfi({ received_at: "2026-10-20", answered_at: "2026-10-27", closed_at: "2026-11-02" }), TODAY),
  7,
);
eq("never negative", daysOpen(rfi({ received_at: "2026-11-10" }), TODAY), 0);

eq("not sent yet, nothing to report", daysWithEor(rfi(), TODAY), null);
eq(
  "sent and waiting, counted to today",
  daysWithEor(rfi({ sent_to_eor_at: "2026-10-26" }), TODAY),
  7,
);
eq(
  "sent and answered, counted to the answer",
  daysWithEor(rfi({ sent_to_eor_at: "2026-10-26", answered_at: "2026-10-30" }), TODAY),
  4,
);

// ============================================================================
section("Overdue versus late");

check("no need-by date is never overdue", !isOverdue(rfi(), TODAY));
check(
  "past the date and unanswered is overdue",
  isOverdue(rfi({ response_needed_by: "2026-10-30" }), TODAY),
);
check(
  "due today is not overdue yet",
  !isOverdue(rfi({ response_needed_by: TODAY }), TODAY),
);
// The distinction that keeps the morning list honest: overdue means somebody
// has to chase it TODAY. An answer that arrived late is history.
check(
  "answered late is not overdue",
  !isOverdue(rfi({ response_needed_by: "2026-10-30", answered_at: "2026-11-01" }), TODAY),
);
check(
  "closed without an answer is not overdue either",
  !isOverdue(rfi({ response_needed_by: "2026-10-30", closed_at: "2026-11-01" }), TODAY),
);
check(
  "but it is recorded as late",
  wasLate(rfi({ response_needed_by: "2026-10-30", answered_at: "2026-11-01" })),
);
check(
  "on time is not late",
  !wasLate(rfi({ response_needed_by: "2026-10-30", answered_at: "2026-10-29" })),
);
check(
  "answered on the day is not late",
  !wasLate(rfi({ response_needed_by: "2026-10-30", answered_at: "2026-10-30" })),
);

// ============================================================================
section("Numbering");

eq("an empty log starts at one", nextRfiNumber([]), "RFI-001");
eq("it follows the series", nextRfiNumber(["RFI-001", "RFI-002"]), "RFI-003");
eq("gaps do not reset it", nextRfiNumber(["RFI-001", "RFI-007"]), "RFI-008");
eq("order does not matter", nextRfiNumber(["RFI-007", "RFI-001"]), "RFI-008");
// The sub's own numbering is kept, so the next one looks like the last one
// rather than the app imposing a house style on somebody else's paperwork.
eq("a project prefix is carried", nextRfiNumber(["SUS-RFI-014"]), "SUS-RFI-015");
eq("padding is carried", nextRfiNumber(["RFI-0007"]), "RFI-0008");
eq("ten does not become nine", nextRfiNumber(["RFI-009", "RFI-010"]), "RFI-011");
eq("unnumbered entries are skipped", nextRfiNumber(["Pile question"]), "RFI-001");
eq("a bare number works", nextRfiNumber(["7"]), "008");

// ============================================================================
section("The headline");

const LOG = [
  rfi({ id: "a", rfi_number: "RFI-001", received_at: "2026-08-01", sent_to_eor_at: "2026-08-02", answered_at: "2026-08-20", closed_at: "2026-08-21" }),
  rfi({ id: "b", rfi_number: "RFI-002", received_at: "2026-10-01", sent_to_eor_at: "2026-10-02", response_needed_by: "2026-10-15" }),
  rfi({ id: "c", rfi_number: "RFI-003", received_at: "2026-10-28" }),
  rfi({ id: "d", rfi_number: "RFI-004", received_at: "2026-10-10", sent_to_eor_at: "2026-10-11", answered_at: "2026-10-31" }),
];

eq("the counts", summarise(LOG, TODAY), {
  open: 3,
  withUs: 1,
  withEor: 1,
  answered: 1,
  overdue: 1,
  closed: 1,
});
eq("an empty log is all zeros", summarise([], TODAY), {
  open: 0,
  withUs: 0,
  withEor: 0,
  answered: 0,
  overdue: 0,
  closed: 0,
});

// ============================================================================
section("What leads the list");

// Overdue leads, then the two states where WE are the holdup, then the chase,
// then closed. b is overdue with the engineer; c is ours to forward; d is
// answered and waiting to go back; a is done.
eq(
  "overdue first, then our own work, then the chase, closed last",
  sortRfis(LOG, TODAY).map((r) => r.id),
  ["b", "c", "d", "a"],
);
// Within a state, the one waiting longest leads. Sorting by number buries the
// question nobody has answered since August.
eq(
  "oldest first inside a state",
  sortRfis(
    [
      rfi({ id: "new", rfi_number: "RFI-009", received_at: "2026-10-30" }),
      rfi({ id: "old", rfi_number: "RFI-002", received_at: "2026-09-01" }),
    ],
    TODAY,
  ).map((r) => r.id),
  ["old", "new"],
);
eq(
  "a tie falls back to the number, numerically",
  sortRfis(
    [
      rfi({ id: "ten", rfi_number: "RFI-010", received_at: "2026-10-01" }),
      rfi({ id: "nine", rfi_number: "RFI-009", received_at: "2026-10-01" }),
    ],
    TODAY,
  ).map((r) => r.id),
  ["nine", "ten"],
);
check("sorting does not mutate the log", (() => {
  const before = LOG.map((r) => r.id).join(",");
  sortRfis(LOG, TODAY);
  return LOG.map((r) => r.id).join(",") === before;
})());
eq("comparing a row with itself is a tie", compareRfis(LOG[0], LOG[0], TODAY), 0);

// ============================================================================
console.log("\n" + "=".repeat(60));
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(60));
process.exit(failures.length > 0 ? 1 : 0);
