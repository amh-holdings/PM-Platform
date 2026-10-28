// Email sweep: sender checks, task matching, what each event becomes, and the Chat notice.
import {
  chatNotice,
  emailAddress,
  matchTask,
  planIngest,
  planPayAppIngest,
  senderAllowed,
  type PayAppEvent,
  type ScheduleEvent,
  type SweepTask,
} from "../../src/lib/email-sweep";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) { failures++; console.log(`FAIL  ${name} ${detail}`); }
  else console.log(`ok    ${name}`);
}

const DOMAINS = ["ibtgroup.com", "sussexcountyde.gov", "state.de.us"];
const FWD = ["phorwitch@americanhelios.com"];

// --- sender ---
check("parses Name <addr>", emailAddress("Keyvan <KeyvanSangelaji@IBTgroup.com>") === "keyvansangelaji@ibtgroup.com");
check("rejects junk sender", emailAddress("not an email") === null);
check("allowlisted domain", senderAllowed("landmark@sussexcountyde.gov", DOMAINS).ok);
check("subdomain allowed", senderAllowed("dnrecemail@mail.state.de.us", DOMAINS).ok);
check("lookalike refused", !senderAllowed("x@sussexcountyde.gov.evil.com", DOMAINS).ok);
check("gmail refused", !senderAllowed("albertosanblas00@gmail.com", DOMAINS).ok);
check("bare forwarder refused", !senderAllowed("phorwitch@americanhelios.com", [...DOMAINS, "americanhelios.com"], FWD).ok);
check("other AHC staff allowed", senderAllowed("mwooley@americanhelios.com", [...DOMAINS, "americanhelios.com"], FWD).ok);

// --- tasks ---
const T = (wbs: string, name: string, over: Partial<SweepTask> = {}): SweepTask => ({
  id: `t-${wbs}`, project_id: "p1", task_name: name, wbs_code: wbs,
  task_type: "deliverable", status: "In Progress", pct_complete: 0, end_date: "2026-11-30",
  status_source: "manual", date_constraint_type: null, date_constraint_date: null, ...over,
});
const tasks: SweepTask[] = [
  T("1", "Permitting"),
  T("1.1", "Building permit issued"),
  T("1.2", "Electrical permit issued"),
  T("1.3", "Land disturbance permit"),
  T("2", "Engineering"),
  T("2.1", "Electrical IFC page turn"),
  T("2.2", "Civil IFC page turn"),
  T("3", "Piles installed", { task_type: "construction" }),
];

const m1 = matchTask("building permit", null, tasks);
check("matches building permit", m1.kind === "one" && m1.task.wbs_code === "1.1");
const m2 = matchTask("permit", null, tasks);
check("bare 'permit' is ambiguous", m2.kind === "many" && m2.candidates.length === 3);
const m3 = matchTask("electrical IFC page turn", null, tasks);
check("matches electrical page turn", m3.kind === "one" && m3.task.wbs_code === "2.1");
check("summary rows never match", matchTask("permitting", null, tasks).kind === "none");
const m4 = matchTask("whatever", "2.2", tasks);
check("quoted WBS wins", m4.kind === "one" && m4.task.wbs_code === "2.2");
check("unknown WBS falls back to name", matchTask("building permit", "9.9", tasks).kind === "one");
const m5 = matchTask("building permit approval letter", null, tasks);
check("near miss offers candidates, never picks", m5.kind === "many");
check("nothing close is none", matchTask("transformer delivery", null, tasks).kind === "none");

// --- planIngest ---
const ev = (over: Partial<ScheduleEvent> = {}): ScheduleEvent => ({
  project: "Sussex", kind: "schedule_complete", task_hint: "building permit", date: "2026-10-27",
  evidence: "Permit BP-0412 has been issued.",
  source: { message_id: "m1", from: "landmark@sussexcountyde.gov", subject: "Permit issued" },
  ...over,
});
const hasChildren = (id: string) => ["t-1", "t-2"].includes(id);
const plan = (e: ScheduleEvent) => planIngest({ event: e, projectId: "p1", tasks, hasChildren, today: "2026-10-28" });

{
  const p = plan(ev());
  check("completion auto-applies", p.action === "insert" && p.row.status === "applied" && p.row.auto_applied && !!p.apply);
  if (p.action === "insert") {
    check("applied row carries undo", p.row.undo_data?.table === "schedule_tasks" && p.row.undo_data.restore.status === "In Progress");
    check("applied row targets the task", p.row.target_id === "t-1.1");
    check("match reason quotes the email", (p.row.match_reason ?? "").includes("BP-0412"));
  }
}
{
  const p = plan(ev({ kind: "schedule_constraint", task_hint: "electrical IFC page turn", date: "2026-11-14", constraint_type: "fnlt" }));
  check("planned date is proposed, never applied", p.action === "insert" && p.row.status === "proposed" && !p.apply);
  if (p.action === "insert") check("constraint summary reads plainly", p.row.summary === "Finish no later than Nov 14, 2026");
}
{
  const p = plan(ev({ task_hint: "permit" }));
  check("ambiguous goes to unmatched", p.action === "insert" && p.row.kind === "unmatched" && p.row.target_id === null);
  if (p.action === "insert") check("unmatched lists candidates", p.row.summary.includes("1.1 Building permit issued"));
}
check("construction completion skipped", plan(ev({ task_hint: "piles installed" })).action === "skip");
check("future completion skipped", plan(ev({ date: "2026-10-30" })).action === "skip");
check("already complete skipped",
  planIngest({ event: ev(), projectId: "p1", hasChildren, today: "2026-10-28",
    tasks: tasks.map((t) => t.wbs_code === "1.1" ? { ...t, status: "Complete", pct_complete: 100 } : t) }).action === "skip");
check("bad constraint type skipped",
  plan(ev({ kind: "schedule_constraint", task_hint: "civil IFC page turn", constraint_type: "ASAP" })).action === "skip");
check("missing message id skipped", plan(ev({ source: { message_id: "", from: "landmark@sussexcountyde.gov" } })).action === "skip");

// --- pay applications ---
const subs = [
  { id: "scs", company_name: "Southern Commercial Solutions LLC", contact_email: "rpounds@scsofga.com" },
  { id: "pyr", company_name: "Pyramid Excavation", contact_email: "office@pyramidexc.com" },
  { id: "nomail", company_name: "Delmarva Fence Co", contact_email: null },
];
const sovItems = new Map([["scs", ["1", "2", "3"]], ["pyr", ["10"]], ["nomail", ["1"]]]);
const live = new Map([["scs", [1, 2]]]);
const pa = (over: Partial<PayAppEvent> = {}, bill: Partial<PayAppEvent["bill"]> = {}): PayAppEvent => ({
  project: "Sussex", kind: "sub_pay_app", subcontractor: "Southern Commercial Solutions",
  bill: { period_end: "2026-10-31", app_number: 3, billed_this_period: 12500, ...bill },
  lines: [{ item_number: "1", this_period: 10000 }, { item_number: "2", this_period: 2500 }],
  source: { message_id: "pa1", from: "Rebekah <redwards@scsofga.com>", subject: "SCS Pay App 3" },
  ...over,
});
const payPlan = (e: PayAppEvent) => planPayAppIngest({ event: e, subs, sovItems, liveAppNumbers: live });

{
  const p = payPlan(pa());
  check("clean pay app is entered", p.action === "enter" && p.sub.id === "scs" && p.row.status === "applied");
  if (p.action === "enter") {
    check("bill carries the G703 by item", p.bill.this_period["1"] === 10000 && p.bill.this_period["2"] === 2500);
    check("entered row says Received", p.row.summary.includes("entered as Received"));
  }
}
check("rounding within a dollar is fine", payPlan(pa({}, { billed_this_period: 12500.6 })).action === "enter");
check("lines not adding up are parked", payPlan(pa({}, { billed_this_period: 13000 })).action === "unmatched");
check("missing G702 total is parked", payPlan(pa({}, { billed_this_period: null })).action === "unmatched");
check("unknown item is parked", payPlan(pa({ lines: [{ item_number: "9", this_period: 12500 }] })).action === "unmatched");
check("duplicate item is parked", payPlan(pa({ lines: [{ item_number: "1", this_period: 6250 }, { item_number: "1", this_period: 6250 }] })).action === "unmatched");
check("negative line is parked", payPlan(pa({ lines: [{ item_number: "1", this_period: 15000 }, { item_number: "2", this_period: -2500 }] })).action === "unmatched");
check("no lines is parked", payPlan(pa({ lines: [] })).action === "unmatched");
check("unknown sub is parked", payPlan(pa({ subcontractor: "Acme Paving" })).action === "unmatched");
check("sender not the sub is parked", payPlan(pa({ source: { message_id: "pa1", from: "mwooley@americanhelios.com" } })).action === "unmatched");
check("sub with no contact email is parked",
  payPlan(pa({ subcontractor: "Delmarva Fence", lines: [{ item_number: "1", this_period: 12500 }] })).action === "unmatched");
check("app number already on file is skipped", payPlan(pa({}, { app_number: 2 })).action === "skip");
check("no app number still enters (next number)", payPlan(pa({}, { app_number: null })).action === "enter");
check("bad period end is parked", payPlan(pa({}, { period_end: "Oct 31" })).action === "unmatched");
{
  const p = payPlan(pa({}, { billed_this_period: 13000 }));
  check("parked row says why and to enter by hand",
    p.action === "unmatched" && p.row.summary.includes("$13,000.00") && p.row.summary.includes("Enter it by hand"));
}

// --- chat notice ---
check("nothing waiting, no message", chatNotice({ projectName: "Sussex", waiting: [], appliedThisRun: 2 }) === null);
{
  const msg = chatNotice({ projectName: "Sussex", waiting: [{ summary: "Finish no later than Nov 14, 2026", target: "2.1 Electrical IFC page turn" }], appliedThisRun: 1, link: "https://x/projects/p1/email-updates" }) ?? "";
  check("message counts and lists", msg.startsWith("Sussex: 1 email update needs review.") && msg.includes("2.1 Electrical IFC page turn"));
  check("message mentions auto-applied", msg.includes("1 applied automatically"));
  check("message ends with link", msg.trim().endsWith("email-updates"));
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
