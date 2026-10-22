/**
 * Editing a sub bill's header: what changes, what the audit line says.
 */

import { canEditHeader, headerEditNote, planHeaderEdit } from "../../src/lib/sub-bill-header-edit";

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

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Pyramid application 4 as it was keyed.
const current = {
  invoice_number: "1416",
  period_end: "2026-10-15",
  payment_terms_days: 60,
  billed_previous: 310236.89,
  billed_this_period: 104479.06,
  billed_to_date: 104479.06,
  retainage_this_period: 5223.95,
  amount_due: 99255.11,
  lien_waiver_received: false,
};
const derived = { billed_previous: 310236.89, billed_this_period: 104479.06, billed_to_date: 414715.95 };
const asPosted = (over: Record<string, string>) => ({
  invoice_number: "1416",
  period_end: "2026-10-15",
  payment_terms_days: "60",
  billed_previous: "310,236.89",
  billed_this_period: "104,479.06",
  billed_to_date: "104,479.06",
  retainage_this_period: "5223.95",
  amount_due: "$99,255.11",
  ...over,
});

const fix = planHeaderEdit({
  current,
  input: asPosted({ billed_to_date: "414,715.95" }),
  derived,
  money,
});
eq(
  "correcting the to-date figure changes only that field",
  fix.ok ? fix.patch : null,
  { billed_to_date: 414715.95 },
);
eq(
  "and says what it was and what it is now",
  fix.ok ? fix.changes : null,
  ["Total completed to date: $104,479.06 to $414,715.95"],
);

const untouched = planHeaderEdit({ current, input: asPosted({}), derived, money });
eq("saving an untouched form changes nothing", untouched.ok ? untouched.changes : null, []);

const cleared = planHeaderEdit({ current, input: asPosted({ billed_to_date: "" }), derived, money });
eq(
  "clearing a total falls back to our line math, as on entry",
  cleared.ok ? cleared.patch : null,
  { billed_to_date: 414715.95 },
);

eq(
  "period end cannot be cleared",
  planHeaderEdit({ current, input: asPosted({ period_end: "" }), derived, money }),
  { ok: false, error: "Period end date is required" },
);

const waiver = planHeaderEdit({
  current,
  input: asPosted({ lien_waiver_received: "on", lien_waiver_amount: "99255.11" }),
  derived,
  money,
});
eq(
  "the lien waiver can be recorded after the fact",
  waiver.ok ? waiver.patch : null,
  { lien_waiver_received: true, lien_waiver_amount: 99255.11 },
);

eq(
  "the audit line names who, when and every change",
  headerEditNote({
    changes: ["Total completed to date: $104,479.06 to $414,715.95"],
    who: "Zarina",
    whenIso: "2026-10-22T19:00:00Z",
  }),
  "Header edited 2026-10-22 by Zarina. Total completed to date: $104,479.06 to $414,715.95.",
);

eq(
  "received and under review bills can be edited, decided ones cannot",
  ["received", "under_review", "cm_recommended", "approved", "rejected", "paid"].map(canEditHeader),
  [true, true, true, false, false, false],
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
