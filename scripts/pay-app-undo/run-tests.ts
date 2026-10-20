// Undoing an AFP - known-answer test harness.
//
// Pure functions only, no database. The guard is the whole feature: undoing a
// draft is a convenience, and undoing something the owner is holding is a
// document going out of step with the copy on their desk. Every refusal case
// below is one that must stay refused.
//
// Run: npx tsx scripts/pay-app-undo/run-tests.ts

import {
  billedElsewhereMessage,
  canUndoPayApplication,
  type PayApplicationState,
} from "@/lib/pay-app-undo";
import { payAppLabel, payAppNeighbours } from "@/lib/pay-app-nav";

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
    actual === expected
      ? ""
      : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

function app(over: Partial<PayApplicationState> = {}): PayApplicationState {
  return {
    app_number: over.app_number !== undefined ? over.app_number : "12",
    status: over.status !== undefined ? over.status : "draft",
    submitted_at: over.submitted_at ?? null,
    approved_at: over.approved_at ?? null,
    paid_at: over.paid_at ?? null,
  };
}

function refusal(state: PayApplicationState): string | null {
  const r = canUndoPayApplication(state);
  return r.ok ? null : r.reason;
}

// ------------------------------------------------------------ what can undo

section("canUndoPayApplication - allowed");

check("a plain draft can be undone", canUndoPayApplication(app()).ok);

check(
  "a null status is treated as draft, since that is the column default",
  canUndoPayApplication(app({ status: null })).ok,
);

check(
  "an empty status is treated as draft too",
  canUndoPayApplication(app({ status: "   " })).ok,
);

check(
  "an AFP with no number can still be undone",
  canUndoPayApplication(app({ app_number: null })).ok,
);

// --------------------------------------------------------- what cannot undo

section("canUndoPayApplication - refused");

check(
  "submitted is refused",
  !canUndoPayApplication(app({ status: "submitted" })).ok,
);
check(
  "approved is refused",
  !canUndoPayApplication(app({ status: "approved" })).ok,
);
check("paid is refused", !canUndoPayApplication(app({ status: "paid" })).ok);

check(
  "an unrecognised status is refused rather than assumed safe",
  !canUndoPayApplication(app({ status: "void" })).ok,
);

// The timestamps are the harder evidence. A status can be edited back to
// draft; a submitted_at is a record that the document went out.
check(
  "a submitted_at refuses even when the status reads draft",
  !canUndoPayApplication(
    app({ status: "draft", submitted_at: "2026-09-10T14:00:00Z" }),
  ).ok,
);
check(
  "an approved_at refuses even when the status reads draft",
  !canUndoPayApplication(
    app({ status: "draft", approved_at: "2026-09-12T14:00:00Z" }),
  ).ok,
);
check(
  "a paid_at refuses even when the status reads draft",
  !canUndoPayApplication(
    app({ status: "draft", paid_at: "2026-09-30T14:00:00Z" }),
  ).ok,
);

// ---------------------------------------------------- the refusals say which

section("refusal wording");

check(
  "paid outranks the rest, so the reader is told the strongest fact",
  (refusal(
    app({
      status: "draft",
      submitted_at: "2026-09-10T14:00:00Z",
      approved_at: "2026-09-12T14:00:00Z",
      paid_at: "2026-09-30T14:00:00Z",
    }),
  ) ?? "").includes("has been paid"),
);

check(
  "approved outranks submitted",
  (refusal(
    app({
      status: "draft",
      submitted_at: "2026-09-10T14:00:00Z",
      approved_at: "2026-09-12T14:00:00Z",
    }),
  ) ?? "").includes("approved by the owner"),
);

check(
  "a submitted AFP is told how to get to undoable",
  (refusal(app({ submitted_at: "2026-09-10T14:00:00Z" })) ?? "").includes(
    "Retract it on the pay app page first",
  ),
);

check(
  "the refusal names the AFP",
  (refusal(app({ app_number: "12", status: "paid" })) ?? "").includes("AFP 12"),
);

check(
  "and falls back to a generic label with no number",
  (refusal(app({ app_number: null, status: "paid" })) ?? "").startsWith(
    "This AFP",
  ),
);

// ------------------------------------------------------- the empty state text

section("billedElsewhereMessage");

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

eq(
  "names the period, the AFP, the count and the amount",
  billedElsewhereMessage({
    periodLabel: "Sep 2026",
    appNumber: "12",
    lineCount: 4,
    amount: 80892,
    formatAmount: money,
  }),
  "Sep 2026 is already on AFP 12 - 4 lines, $80,892.",
);

eq(
  "singular line reads as one line",
  billedElsewhereMessage({
    periodLabel: "Sep 2026",
    appNumber: "12",
    lineCount: 1,
    amount: 1200,
    formatAmount: money,
  }),
  "Sep 2026 is already on AFP 12 - 1 line, $1,200.",
);

eq(
  "an unnumbered AFP still reads as a sentence",
  billedElsewhereMessage({
    periodLabel: "Oct 2026",
    appNumber: null,
    lineCount: 2,
    amount: 500,
    formatAmount: money,
  }),
  "Oct 2026 is already on a draft AFP - 2 lines, $500.",
);

check(
  "it never repeats the old claim that nothing was billable",
  !billedElsewhereMessage({
    periodLabel: "Sep 2026",
    appNumber: "12",
    lineCount: 4,
    amount: 80892,
    formatAmount: money,
  }).includes("Nothing to bill"),
);

// ------------------------------------------------------- stepping between AFPs
// Zarina: "Like an arrow for right and left so we can view the next AFP or
// the previous AFP in this page."
{
  const a = (id: string, num: string | null, end: string | null, created = "") => ({
    id,
    app_number: num,
    period_end: end,
    created_at: created,
  });

  // Deliberately out of order, and deliberately NOT sortable by app_number:
  // "AFP 10" sorts before "AFP 2" as a string, which is the bug this avoids.
  const apps = [
    a("c", "AFP 10", "2026-08-31"),
    a("a", "AFP 2", "2026-01-31"),
    a("b", "AFP 9", "2026-07-31"),
  ];

  const mid = payAppNeighbours(apps, "b");
  check("NAV-01 left is the earlier period", mid.prev?.id === "a", `got ${mid.prev?.id}`);
  check("NAV-02 right is the later period", mid.next?.id === "c", `got ${mid.next?.id}`);
  check("NAV-03 and AFP 10 is not sorted as a string before AFP 2", mid.next?.app_number === "AFP 10");
  check("NAV-04 position counts from the oldest", mid.position === 2, `got ${mid.position}`);
  check("NAV-05 and knows the total", mid.total === 3);

  const first = payAppNeighbours(apps, "a");
  check("NAV-06 the earliest has nothing to its left", first.prev === null);
  check("NAV-07 but still has a next", first.next?.id === "b");
  const last = payAppNeighbours(apps, "c");
  check("NAV-08 the latest has nothing to its right", last.next === null);

  // A link to an application that has since been deleted must still render.
  const gone = payAppNeighbours(apps, "zzz");
  check("NAV-09 an unknown id yields no neighbours", gone.prev === null && gone.next === null);
  check("NAV-10 and position zero rather than a guess", gone.position === 0);
  check("NAV-11 while still reporting the total", gone.total === 3);

  // One application on the project: both arrows are dead ends.
  const only = payAppNeighbours([a("x", "AFP 1", "2026-01-31")], "x");
  check("NAV-12 a lone application has neither neighbour", only.prev === null && only.next === null);
  check("NAV-13 and reads 1 of 1", only.position === 1 && only.total === 1);

  // A draft with no period sorts first, not after the newest real one.
  const withDraft = payAppNeighbours([...apps, a("d", null, null)], "a");
  check("NAV-14 a periodless draft sorts before the earliest real one", withDraft.prev?.id === "d");

  // Same period end: created_at breaks the tie, so the order is stable.
  const sameDay = [
    a("late", "AFP 4b", "2026-03-31", "2026-04-02T00:00:00Z"),
    a("early", "AFP 4a", "2026-03-31", "2026-04-01T00:00:00Z"),
  ];
  check(
    "NAV-15 a tie on period end falls back to when it was entered",
    payAppNeighbours(sameDay, "late").prev?.id === "early",
  );

  check("NAV-16 an unnumbered application still has something to click", payAppLabel(a("z", "  ", null)) === "Untitled");
  check("NAV-17 and a numbered one reads as itself", payAppLabel(a("z", "AFP 12", null)) === "AFP 12");
  check("NAV-18 no neighbour means no label", payAppLabel(null) === "");

  // Sorting must not mutate what it was handed - the page renders from the
  // same array it passes in.
  check("NAV-19 the source list is left alone", apps[0].id === "c");
}

// --------------------------------------------------------------------- report

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
