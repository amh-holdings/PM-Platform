/**
 * Retainage-exempt SOV lines on a pay application.
 *
 * Sussex's Exhibit E holds 5% on every payment except Item 1.01, the LNTP.
 * One application billing an LNTP plan set and the NTP line together has to
 * withhold on the NTP line only.
 */

import { buildPayAppLines, type PayAppBillingLine, type PayAppEntry } from "../../src/lib/pay-app-lines";

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

const lines: PayAppBillingLine[] = [
  { id: "lntp", item_number: "1.01.2", description: "Civil 30% Plan Set", scheduled_value: 40445.88, sort_order: 20, retainage_exempt: true },
  { id: "ntp", item_number: "2.00", description: "EPC Contract - NTP", scheduled_value: 238903.44, sort_order: 110 },
  { id: "legacy", item_number: "3.00", description: "No flag at all", scheduled_value: 59725.86, sort_order: 120, retainage_exempt: null },
];
const entry = (id: string, line: string, amount: number): PayAppEntry => ({
  id,
  billing_line_id: line,
  period_month: "2026-10-01",
  actual_amount: amount,
  planned_amount: null,
  pay_application_id: null,
  status: "approved",
  afp_number: null,
});

const built = buildPayAppLines({
  lines,
  entries: [entry("e1", "lntp", 40445.88), entry("e2", "ntp", 238903.44), entry("e3", "legacy", 59725.86)],
  amendments: [],
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  retainagePct: 5,
});

if (!built.ok) {
  console.log(`  FAIL  builder refused: ${built.error}`);
  process.exit(1);
}
const ret = (id: string) => built.lines.find((l) => l.billing_line_id === id)?.retainage_amount;

eq("exempt LNTP line withholds nothing", ret("lntp"), 0);
eq("NTP line withholds 5%", ret("ntp"), 11945.17);
eq("a line with no flag still withholds 5%", ret("legacy"), 2986.29);
eq("total retainage is the non-exempt lines only", built.totals.total_retainage, 14931.46);
eq("exempt line still bills its full amount", built.lines.find((l) => l.billing_line_id === "lntp")?.work_completed_this_period, 40445.88);

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
