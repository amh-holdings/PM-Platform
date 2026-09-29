// Tests for the billing cutoff day: which date a period's evidence stops at.
//
// Run: npx tsx scripts/billing/run-billing-cutoff-tests.ts

import { periodEndOf, progressAsOf } from "@/lib/billing-period";
import { milestoneTriggered } from "@/lib/progress";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
}
const d = (iso: string) => new Date(`${iso}T12:00:00Z`);

console.log("\nperiodEndOf");
{
  check("no cutoff is the month end", periodEndOf("2026-09-01") === "2026-09-30");
  check("a cutoff of 20 ends on the 20th", periodEndOf("2026-09-01", 20) === "2026-09-20");
  check("February keeps its own length", periodEndOf("2027-02-01") === "2027-02-28");
  check("a cutoff of 28 works in February", periodEndOf("2027-02-01", 28) === "2027-02-28");
  check("null behaves as no cutoff", periodEndOf("2026-09-01", null) === "2026-09-30");
  check("a cutoff past the month end falls back to the month end", periodEndOf("2026-09-01", 31) === "2026-09-30");
  check("zero and nonsense fall back", periodEndOf("2026-09-01", 0) === "2026-09-30");
}

console.log("\nprogressAsOf clamps to today as well as to the cutoff");
{
  check("mid-period, today wins",
    progressAsOf("2026-09-01", d("2026-09-10"), 20) === "2026-09-10");
  check("on the cutoff, the cutoff",
    progressAsOf("2026-09-01", d("2026-09-20"), 20) === "2026-09-20");
  check("after the cutoff, still the cutoff - this is the whole point",
    progressAsOf("2026-09-01", d("2026-09-29"), 20) === "2026-09-20",
    progressAsOf("2026-09-01", d("2026-09-29"), 20));
  check("without a cutoff the old answer is unchanged",
    progressAsOf("2026-09-01", d("2026-09-29")) === "2026-09-29");
  check("billing a closed month still sees that month's end",
    progressAsOf("2026-08-01", d("2026-09-29"), 20) === "2026-08-20");
}

console.log("\nA milestone earns only if its event happened by the cutoff");
const po = (over: Record<string, unknown> = {}) => ({
  id: "po1", po_number: "PO-017", vendor_name: "GroundWork Renewables",
  total_value: 47965, status: "active",
  signed_at: "2026-06-17", actual_delivery_date: "2026-09-24",
  milestones: [], ...over,
}) as never;
const ms = (over: Record<string, unknown> = {}) =>
  ({ milestone_name: "Net 30 upon delivery", trigger_event: "delivery", amount: 23982.5, ...over }) as never;
{
  const before = milestoneTriggered(ms(), po(), "2026-09-20");
  check("delivery on the 24th has not earned at the 20th", before.fired === false, before.why);
  check("and says why, rather than 'awaiting delivery'",
    before.why.includes("after this period closed"), before.why);

  const after = milestoneTriggered(ms(), po(), "2026-09-30");
  check("it has earned by the 30th", after.fired === true, after.why);

  const none = milestoneTriggered(ms(), po());
  check("no cutoff means the old behaviour", none.fired === true, none.why);

  const deposit = milestoneTriggered(
    ms({ milestone_name: "Deposit", trigger_event: "deposit" }), po(), "2026-09-20");
  check("a deposit still earns off a PO signed in June", deposit.fired === true, deposit.why);

  const lateSign = milestoneTriggered(
    ms({ milestone_name: "Deposit", trigger_event: "deposit" }),
    po({ signed_at: "2026-09-24" }), "2026-09-20");
  check("a PO signed after the cutoff earns nothing yet", lateSign.fired === false, lateSign.why);

  const paidLate = milestoneTriggered(
    ms({ paid_at: "2026-09-25" }), po({ actual_delivery_date: null }), "2026-09-20");
  check("paid after the cutoff is not paid yet", paidLate.fired === false, paidLate.why);

  const paidEarly = milestoneTriggered(
    ms({ paid_at: "2026-09-02" }), po({ actual_delivery_date: null }), "2026-09-20");
  check("paid before the cutoff is paid", paidEarly.fired === true, paidEarly.why);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
