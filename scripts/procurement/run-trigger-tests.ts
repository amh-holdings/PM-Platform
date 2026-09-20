// Every trigger the dropdown offers must actually fire the branch it promises.
//
// Run: npx tsx scripts/procurement/run-trigger-tests.ts

import {
  MILESTONE_TRIGGERS,
  isRecognisedTrigger,
  milestoneTriggered,
} from "@/lib/progress";

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
function eq<T>(name: string, got: T, want: T) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, g === w ? "" : `got ${g}, want ${w}`);
}
function section(t: string) {
  console.log(`\n${t}\n${"-".repeat(t.length)}`);
}

const SIGNED = {
  po_number: "PO-022",
  vendor_name: "CAB Solar",
  total_value: 100000,
  status: "active",
  signed_at: "2026-04-11",
  actual_delivery_date: null,
  milestones: [],
};
const UNSIGNED = { ...SIGNED, signed_at: null };
const DELIVERED = { ...SIGNED, actual_delivery_date: "2026-08-02" };

const ms = (trigger: string | null) => ({
  milestone_name: "m",
  trigger_event: trigger,
  amount: 1000,
  pct_of_total: null,
  paid_at: null,
});

section("Every dropdown option does what its label says");
{
  // This is the whole point of the list existing. Rename a label without
  // checking the matcher still fires and this breaks, rather than the billing.
  for (const t of MILESTONE_TRIGGERS) {
    check(
      `"${t.value}" is recognised at all`,
      isRecognisedTrigger(t.value),
      "the matcher does not know this word",
    );

    const promisesSigned = /signed/.test(t.label);
    const promisesDelivery = /delivery date/.test(t.label);
    const promisesNever = /does not earn/.test(t.label);

    if (promisesSigned) {
      eq(`"${t.value}" earns once signed`, milestoneTriggered(ms(t.value), SIGNED).fired, true);
      eq(`"${t.value}" does not earn unsigned`, milestoneTriggered(ms(t.value), UNSIGNED).fired, false);
    }
    if (promisesDelivery) {
      eq(`"${t.value}" earns once delivered`, milestoneTriggered(ms(t.value), DELIVERED).fired, true);
      eq(`"${t.value}" does not earn before delivery`, milestoneTriggered(ms(t.value), SIGNED).fired, false);
    }
    if (promisesNever) {
      eq(`"${t.value}" does not earn yet`, milestoneTriggered(ms(t.value), DELIVERED).fired, false);
    }
    check(
      `"${t.value}" label says when it earns`,
      promisesSigned || promisesDelivery || promisesNever,
      "a label that does not say when money is earned is the bug this replaced",
    );
  }
}

section("The wording that started this");
{
  // PO-022's symptom. These read fine to a person and mean nothing to the app.
  for (const bad of ["Equipment arrival", "Shipment received", "Upon invoice", ""]) {
    check(`"${bad}" is flagged as unrecognised`, !isRecognisedTrigger(bad));
    eq(`"${bad}" earns nothing`, milestoneTriggered(ms(bad || null), DELIVERED).fired, false);
  }
}

section("Legacy wording is not thrown away");
{
  // Free text already in the database that the matcher does handle must stay
  // recognised, or the editor sends somebody to fix a milestone that works.
  for (const ok of ["Delivered to site", "Delivery", "PO Release 10%", "Initial deposit"]) {
    check(`"${ok}" still counts as recognised`, isRecognisedTrigger(ok));
  }
  eq("and still fires", milestoneTriggered(ms("Delivered to site"), DELIVERED).fired, true);
}

section("A paid date beats every trigger");
{
  // The backfill route: these POs were paid on paper, and a recorded payment
  // is not a prediction to be re-derived from PO state.
  const paid = { ...ms("Equipment arrival"), paid_at: "2026-03-14" };
  eq("an unrecognised trigger still earns once paid", milestoneTriggered(paid, UNSIGNED).fired, true);
  eq("and says why", milestoneTriggered(paid, UNSIGNED).why, "already paid");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
