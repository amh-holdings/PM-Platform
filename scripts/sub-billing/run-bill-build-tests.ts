// buildSubBill: the one bill calculation shared by Record a bill and the email sweep.
import { acceptedHistory, buildSubBill, lineRows } from "../../src/lib/sub-bill-build";

let failures = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log(`FAIL  ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok    ${name}`);
}

const sov = [
  { id: "s1", item_number: "1", description: "Mobilization", scheduled_value: 10000 },
  { id: "s2", item_number: "2", description: "Grading", scheduled_value: 50000 },
];

// First bill: no history, 10% retainage from the sub.
{
  const b = buildSubBill({
    bill: { period_end: "2026-10-31", this_period: { "1": 10000, "2": 5000 } },
    subRetainagePct: 10, sovLines: sov, history: [], priorLines: [],
  });
  eq("first bill is app 1", b.appNumber, 1);
  eq("this period derived", b.header.billed_this_period, 15000);
  eq("to date derived", b.header.billed_to_date, 15000);
  eq("retainage to date 10%", b.header.retainage_to_date, 1500);
  eq("amount due = this period less retainage", b.header.amount_due, 13500);
  eq("line balance", b.lines[1].balance_to_finish, 45000);
  eq("status received", b.row.status, "received");
}

// Second bill: previous column from what AHC APPROVED, not what was billed.
{
  const history = [{ id: "a1", app_number: 1, status: "approved", retainage_to_date: 1500 }];
  const priorLines = [
    { item_number: "1", this_period: 10000, approved_this_period: 10000 },
    { item_number: "2", this_period: 5000, approved_this_period: 3000 },
  ];
  const b = buildSubBill({
    bill: { period_end: "2026-11-30", this_period: { "2": 7000 }, billed_this_period: 7000 },
    subRetainagePct: 10, sovLines: sov, history, priorLines,
  });
  eq("next app number", b.appNumber, 2);
  eq("previous uses approved", b.lines[1].from_previous, 3000);
  eq("to date on our numbers", b.lines[1].total_completed, 10000);
  eq("stated this period kept", b.header.billed_this_period, 7000);
  eq("retainage this period nets prior held", b.header.retainage_this_period, 2000 - 1500 + 0);
}

// A rejected app neither sets the baseline nor uses up its number.
{
  const history = [
    { id: "a1", app_number: 1, status: "approved", retainage_to_date: 0 },
    { id: "a2", app_number: 2, status: "rejected", retainage_to_date: 999 },
  ];
  eq("accepted skips rejected", acceptedHistory(history).map((a) => a.id), ["a1"]);
  const b = buildSubBill({
    bill: { period_end: "2026-11-30", this_period: {} }, subRetainagePct: 0, sovLines: sov, history,
    priorLines: [{ item_number: "1", this_period: 100, approved_this_period: 100 }],
  });
  eq("rejected number comes round again", b.appNumber, 2);
  eq("stated figures beat derived when given", buildSubBill({
    bill: { period_end: "2026-11-30", this_period: { "1": 1 }, billed_to_date: 42 },
    subRetainagePct: 0, sovLines: sov, history: [], priorLines: [],
  }).header.billed_to_date, 42);
}

eq("line rows carry the app id", lineRows("APP", buildSubBill({
  bill: { period_end: "2026-10-31", this_period: { "1": 1 } }, subRetainagePct: 0, sovLines: sov, history: [], priorLines: [],
}).lines)[0].sub_pay_app_id, "APP");

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
