// Every trigger the dropdown offers must actually fire the branch it promises.
//
// Run: npx tsx scripts/procurement/run-trigger-tests.ts

import {
  MILESTONE_TRIGGERS,
  MILESTONE_TRIGGER_GROUPS,
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

    // Driven by the declared group rather than the label, so a label reword
    // cannot quietly stop the assertion applying.
    const promisesSigned = t.group === "signed";
    const promisesDelivery = t.group === "delivered";
    const promisesNever = t.group === "later";

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
      /earns|does not earn/.test(t.label),
      "a label that does not say when money is earned is the bug this replaced",
    );
  }
}

section("PO Signed - the wording the old form told people to use");
{
  // The box this replaced carried the placeholder "PO signed / Delivered".
  // It suggested the one wording the matcher refused, and PO-022 sat unbilled
  // on exactly that.
  for (const v of ["PO Signed", "PO signed", "PO signed 04/11", "Signed"]) {
    check(`"${v}" is recognised`, isRecognisedTrigger(v));
    eq(`"${v}" earns once signed`, milestoneTriggered(ms(v), SIGNED).fired, true);
    eq(`"${v}" does not earn unsigned`, milestoneTriggered(ms(v), UNSIGNED).fired, false);
  }
  // Order still matters: the delivery and commissioning branches are checked
  // first, so a trigger mentioning both does not collapse to signature.
  eq(
    "\"Delivery signed off\" is still a delivery",
    milestoneTriggered(ms("Delivery signed off"), SIGNED).fired,
    false,
  );
  eq(
    "and fires once delivered",
    milestoneTriggered(ms("Delivery signed off"), DELIVERED).fired,
    true,
  );
  eq(
    "\"Commissioning signed\" still waits",
    milestoneTriggered(ms("Commissioning signed"), DELIVERED).fired,
    false,
  );
}

section("Every group has a heading and every option has a group");
{
  const keys = new Set(MILESTONE_TRIGGER_GROUPS.map((g) => g.key));
  for (const t of MILESTONE_TRIGGERS) {
    check(`"${t.value}" sits in a group that has a heading`, keys.has(t.group));
  }
  for (const g of MILESTONE_TRIGGER_GROUPS) {
    check(
      `group "${g.key}" has at least one option`,
      MILESTONE_TRIGGERS.some((t) => t.group === g.key),
      "an empty heading renders as a blank line in the picker",
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
