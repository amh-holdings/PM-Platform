// Sync audit rules.
import { auditMessages, daysSince, priorWeekdays, runAudit, type AuditInput } from "../../src/lib/sync-audit";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) { failures++; console.log(`FAIL  ${name} ${detail}`); }
  else console.log(`ok    ${name}`);
}

const base = (over: Partial<AuditInput> = {}): AuditInput => ({
  today: "2026-10-28",
  emailUpdates: [], subBills: [], afps: [], changeOrders: [], subs: [], tasks: [], billingEntries: [],
  dprs: ["2026-10-27", "2026-10-26", "2026-10-23", "2026-10-22", "2026-10-21"].map((d) => ({ report_date: d, status: "approved", submitted_at: d })),
  ...over,
});
const areas = (i: AuditInput) => runAudit(i).map((f) => `${f.severity}:${f.area}:${f.text}`);

check("weekdays skip the weekend", priorWeekdays("2026-10-26", 2).join() === "2026-10-23,2026-10-22");
check("days since", daysSince("2026-10-20T15:00:00Z", "2026-10-28") === 8);
check("clean project has no findings", runAudit(base()).length === 0);
check("clean project sends no chat", auditMessages("Sussex", []).chat === null);

check("stale email update flagged", areas(base({ emailUpdates: [{ status: "proposed", created_at: "2026-10-24T10:00:00Z", summary: "x" }] }))[0]?.startsWith("action:Email updates:1 email update"));
check("fresh email update not flagged", runAudit(base({ emailUpdates: [{ status: "proposed", created_at: "2026-10-27T10:00:00Z", summary: "x" }] })).length === 0);

const bill = { company_name: "SCS", app_number: 3, status: "received", created_at: "2026-10-26", error_checks: 0 };
check("bill failing checks flagged", areas(base({ subBills: [{ ...bill, error_checks: 2 }] }))[0]?.includes("fails 2 checks"));
check("old bill in review flagged", areas(base({ subBills: [{ ...bill, created_at: "2026-10-15" }] }))[0]?.includes("in review 13 days"));
check("approved bill ignored", runAudit(base({ subBills: [{ ...bill, status: "approved", error_checks: 3 }] })).length === 0);

check("AFP unpaid 30+ days watched", areas(base({ afps: [{ app_number: "12", status: "submitted", submitted_at: "2026-09-20", paid_at: null }] }))[0]?.startsWith("watch:AFPs:AFP 12 unpaid 38 days"));
check("paid AFP ignored", runAudit(base({ afps: [{ app_number: "12", status: "paid", submitted_at: "2026-09-01", paid_at: "2026-10-01" }] })).length === 0);
check("CO waiting 14+ days watched", areas(base({ changeOrders: [{ co_number: "5", status: "submitted", submitted_at: "2026-10-01", description: null }] }))[0]?.includes("CO 5 waiting on the owner 27 days"));

{
  const f = areas(base({ subs: [
    { company_name: "SCS", coi_status: "expired", w9_status: "received", active: true },
    { company_name: "Pyramid", coi_status: "received", w9_status: "pending", active: true },
    { company_name: "Old Sub", coi_status: "expired", w9_status: "pending", active: false },
  ] }));
  check("COI gap listed", f.some((x) => x.includes("COI missing or lapsing: SCS (expired)")));
  check("W-9 gap listed", f.some((x) => x.includes("W-9 missing: Pyramid")));
  check("inactive subs ignored", !f.some((x) => x.includes("Old Sub")));
}

check("missing field report days watched", areas(base({ dprs: [] }))[0]?.startsWith("watch:Field reports:No field report for 10/27, 10/26, 10/23, 10/22, 10/21"));
check("draft report does not count as filed", areas(base({ dprs: [{ report_date: "2026-10-27", status: "draft", submitted_at: null }] }))[0]?.includes("10/27"));
check("report waiting on review flagged", areas(base({ dprs: [...base().dprs, { report_date: "2026-10-23", status: "submitted", submitted_at: "2026-10-23" }] })).some((x) => x.includes("waiting on review")));

{
  const tasks = [
    { wbs_code: "1", task_name: "Permitting", task_type: null, status: "In Progress", pct_complete: 0, end_date: "2026-10-01", last_dpr_at: null },
    { wbs_code: "1.1", task_name: "Building permit", task_type: "deliverable", status: "In Progress", pct_complete: 0, end_date: "2026-10-20", last_dpr_at: null },
    { wbs_code: "1.2", task_name: "Electrical permit", task_type: "deliverable", status: "Complete", pct_complete: 100, end_date: "2026-10-10", last_dpr_at: null },
    { wbs_code: "2.1", task_name: "Piles", task_type: "construction", status: "In Progress", pct_complete: 40, end_date: "2026-12-01", last_dpr_at: "2026-10-10" },
  ];
  const f = areas(base({ tasks }));
  check("overdue leaf flagged, summary and done tasks not", f.some((x) => x.includes("1 task past finish and not complete: 1.1 Building permit")));
  check("quiet construction task watched", f.some((x) => x.startsWith("watch:Schedule:1 construction task")));
}

{
  const entries = [
    { period_month: "2026-10-01", planned_amount: 5000, status: "forecast", pay_application_id: null, afp_number: null },
    { period_month: "2026-10-01", planned_amount: 7000, status: "forecast", pay_application_id: "afp", afp_number: null },
  ];
  check("billing pass runs from the 18th", areas(base({ billingEntries: entries }))[0]?.includes("1 line forecast for 2026-10 not on an AFP yet, $5,000.00"));
  check("billing pass quiet before the 18th", runAudit(base({ today: "2026-10-14", billingEntries: entries, dprs: [] })).every((x) => x.area !== "Billing"));
}

{
  const { chat, card } = auditMessages("Sussex CSG 1", runAudit(base({ dprs: [], subBills: [{ ...bill, error_checks: 1 }] })), "https://app/projects/p1");
  check("chat counts to do and watch", !!chat && chat.startsWith("Sussex CSG 1 sync audit: 1 to do, 1 to watch."));
  check("chat ends with link", !!chat && chat.trim().endsWith("projects/p1"));
  check("card has both sections", card.includes("## To do") && card.includes("## Watch"));
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
