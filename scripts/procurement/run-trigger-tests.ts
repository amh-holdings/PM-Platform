// Every trigger the dropdown offers must actually fire the branch it promises.
//
// Run: npx tsx scripts/procurement/run-trigger-tests.ts

import {
  MILESTONE_TRIGGERS,
  MILESTONE_TRIGGER_GROUPS,
  estimateProcurementProgress,
  isRecognisedTrigger,
  milestoneTriggered,
  ownerBillingMilestones,
  recordedPayment,
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

// ------------- Recording a payment that already happened -------------
// A PO paid before anyone was entering milestones has its cost in the forecast
// nowhere at all: the projection skips a cost code tied to a PO on the
// assumption the PO's milestones supply it, so with no milestones neither side
// counts it. Recording it used to take two actions, add then mark paid.
section("A payment recorded as already made");

{
  const r = recordedPayment(78179.8, "2026-03-14");
  check("it is accepted", r.ok === true);
  if (r.ok) {
    eq("dated when it was paid", r.paid_at, "2026-03-14");
    eq("and states what was paid", r.paid_amount, 78179.8);
  }
}

// The projection drops a payment whose amount is not above zero, silently.
// For a payment being recorded as already made that throws away the entire
// point of recording it, so it is refused rather than stored as nothing.
{
  const r = recordedPayment(null, "2026-03-14");
  check("no amount is refused", r.ok === false);
  if (!r.ok) check("and says why", r.error.includes("count as zero"));
}

{
  const r = recordedPayment(0, "2026-03-14");
  check("zero is refused too", r.ok === false);
}

// No paid date is the ordinary case: a milestone expected, not yet paid.
{
  const r = recordedPayment(null, null);
  check("an unpaid milestone is fine with no amount", r.ok === true);
  if (r.ok) {
    eq("nothing is dated", r.paid_at, null);
    eq("and nothing is claimed paid", r.paid_amount, null);
  }
}

{
  const r = recordedPayment(45000, null);
  check("an unpaid milestone with an amount is fine", r.ok === true);
  if (r.ok) eq("but it is not marked paid", r.paid_amount, null);
}


// ---------------------------------------------------------------------------
// Two schedules on one PO: what we pay the vendor, what we bill the owner
// ---------------------------------------------------------------------------
//
// PO-022 is the case that forced the split. The vendor gets 50% on deposit and
// 50% on delivery. The owner is billed 50% of the PO total the day the PO is
// issued, whatever the vendor terms say. Both live on the same PO.

const PO_022 = {
  po_number: "PO-022",
  vendor_name: "Matthews Power",
  total_value: 8960.49,
  status: "active",
  signed_at: "2026-08-25",
  actual_delivery_date: null,
};

const vendorTerms = [
  { milestone_name: "Deposit", trigger_event: "Deposit", pct_of_total: 50, amount: 3975.25, side: "vendor" },
  { milestone_name: "Delivery", trigger_event: "Delivery to site", amount: 4985.24, side: "vendor" },
];

const ownerTerms = [
  { milestone_name: "Owner - 50% on PO", trigger_event: "PO signed", pct_of_total: 50, amount: 4480.25, side: "owner" },
  { milestone_name: "Owner - balance on delivery", trigger_event: "Delivery to site", pct_of_total: 50, amount: 4480.24, side: "owner" },
];

{
  const r = ownerBillingMilestones([...vendorTerms, ...ownerTerms]);
  eq("owner rows win outright when they exist", r.milestones.length, 2);
  eq("and it is not a fallback", r.usingVendorTerms, false);
  check("no vendor row leaks in", r.milestones.every((m) => m.side === "owner"));
}

{
  const r = ownerBillingMilestones(vendorTerms);
  eq("vendor terms stand in when no owner rows exist", r.milestones.length, 2);
  eq("and it says so", r.usingVendorTerms, true);
}

{
  // Rows predating 0055 carry no side at all. They are vendor rows.
  const r = ownerBillingMilestones([
    { milestone_name: "Deposit", trigger_event: "Deposit", amount: 100 },
  ]);
  eq("a row with no side is a vendor row", r.usingVendorTerms, true);
  eq("and it still stands in", r.milestones.length, 1);
}

{
  eq("no milestones at all is still a vendor fallback of nothing",
     ownerBillingMilestones([]).milestones.length, 0);
}

{
  // The number Zarina asked for: $4,480.25 on the AFP the day the PO is
  // signed, while the vendor has only been paid its $3,975.25 deposit.
  const withOwner = estimateProcurementProgress(
    { scheduled_value: 100000 },
    [{ ...PO_022, milestones: [...vendorTerms, ...ownerTerms] }],
  );
  eq("the owner is billed half the PO on signing", withOwner.earnedValue, 4480.25);

  const vendorOnly = estimateProcurementProgress(
    { scheduled_value: 100000 },
    [{ ...PO_022, milestones: vendorTerms }],
  );
  eq("without owner terms it falls back to the vendor deposit",
     vendorOnly.earnedValue, 3975.25);
  check(
    "and the fallback is stated in the working",
    vendorOnly.detail.some((d) => /no owner billing terms/i.test(d)),
    vendorOnly.detail.join(" | "),
  );
}

{
  // Delivery has not happened, so the owner's second half is not earned yet
  // even though its trigger is recognised.
  const r = estimateProcurementProgress(
    { scheduled_value: 100000 },
    [{ ...PO_022, milestones: ownerTerms }],
  );
  eq("the balance waits for delivery", r.earnedValue, 4480.25);

  const delivered = estimateProcurementProgress(
    { scheduled_value: 100000 },
    [{ ...PO_022, actual_delivery_date: "2026-11-20", milestones: ownerTerms }],
  );
  eq("and lands once it is delivered", delivered.earnedValue, 8960.49);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
