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

// --------------------------------------------------------------------- report

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
