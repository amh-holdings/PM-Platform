// Sync audit: what in a project's app record has fallen behind.
//
// The weekday Sussex Sync job runs this at 5:45 AM. It is read-only - it
// changes nothing, it only lists what needs a person - and pure, so the rules
// are tested here and scripts/sync-audit/run.ts only loads the rows.
//
// Findings come in two weights. "action" is something to do today. "watch" is
// worth knowing and does not need doing yet. Each is one line, worded for the
// Chat message and the Notion card.

import { hasBillingEvidence } from "./billing-progress";
import { leafStateOf } from "./schedule-summary-status";

export type AuditSeverity = "action" | "watch";
export type AuditArea =
  | "Email updates"
  | "Sub billing"
  | "AFPs"
  | "Change orders"
  | "COI and W-9"
  | "Field reports"
  | "Schedule"
  | "Billing";

export type AuditFinding = { area: AuditArea; severity: AuditSeverity; text: string };

export type AuditInput = {
  today: string; // YYYY-MM-DD, project time zone
  emailUpdates: { status: string; created_at: string | null; summary: string }[];
  subBills: {
    company_name: string;
    app_number: number;
    status: string;
    created_at: string | null;
    error_checks: number;
  }[];
  afps: { app_number: string; status: string | null; submitted_at: string | null; paid_at: string | null }[];
  changeOrders: { co_number: string; status: string | null; submitted_at: string | null; description: string | null }[];
  subs: { company_name: string; coi_status: string | null; w9_status: string | null; active: boolean | null }[];
  dprs: { report_date: string; status: string | null; submitted_at: string | null }[];
  tasks: {
    wbs_code: string;
    task_name: string;
    task_type: string | null;
    status: string | null;
    pct_complete: number | null;
    end_date: string | null;
    last_dpr_at: string | null;
  }[];
  billingEntries: {
    period_month: string;
    planned_amount: number | null;
    status: string | null;
    pay_application_id: string | null;
    afp_number: string | null;
  }[];
};

const DAY = 86_400_000;

export function daysSince(iso: string | null | undefined, today: string): number | null {
  if (!iso) return null;
  const a = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((b - a) / DAY) : null;
}

/** The last `n` weekdays before today, newest first. */
export function priorWeekdays(today: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${today}T00:00:00Z`);
  while (out.length < n) {
    t -= DAY;
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function money(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function list(items: string[], max = 5): string {
  return items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", ");
}

function md(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${m}/${d}`;
}

/** Day of month from which the deeper billing pass runs, ahead of the 20th. */
export const BILLING_PASS_FROM_DAY = 18;

export function runAudit(input: AuditInput): AuditFinding[] {
  const { today } = input;
  const out: AuditFinding[] = [];
  const add = (area: AuditArea, severity: AuditSeverity, text: string) => out.push({ area, severity, text });

  // Email updates waiting on a decision for more than two days.
  const stale = input.emailUpdates.filter((u) => u.status === "proposed" && (daysSince(u.created_at, today) ?? 0) > 2);
  if (stale.length) add("Email updates", "action", `${stale.length} email update${stale.length === 1 ? "" : "s"} waiting more than 2 days`);

  // Sub bills sitting in review.
  for (const b of input.subBills) {
    if (b.status !== "received" && b.status !== "under_review") continue;
    const age = daysSince(b.created_at, today) ?? 0;
    if (b.error_checks > 0) {
      add("Sub billing", "action", `${b.company_name} application ${b.app_number} fails ${b.error_checks} check${b.error_checks === 1 ? "" : "s"}`);
    } else if (age > 5) {
      add("Sub billing", "action", `${b.company_name} application ${b.app_number} in review ${age} days`);
    }
  }

  // AFPs out with the owner a month or more.
  for (const a of input.afps) {
    if ((a.status ?? "").toLowerCase() !== "submitted" && (a.status ?? "").toLowerCase() !== "approved") continue;
    if (a.paid_at) continue;
    const age = daysSince(a.submitted_at, today);
    if (age != null && age >= 30) add("AFPs", "watch", `AFP ${a.app_number} unpaid ${age} days after submittal`);
  }

  // Change orders waiting on the owner two weeks or more.
  for (const c of input.changeOrders) {
    if ((c.status ?? "").toLowerCase() !== "submitted") continue;
    const age = daysSince(c.submitted_at, today);
    if (age != null && age >= 14) add("Change orders", "watch", `CO ${c.co_number} waiting on the owner ${age} days`);
  }

  // COI and W-9 on active subs.
  const coiGaps = input.subs
    .filter((s) => s.active !== false)
    .filter((s) => ["pending", "expired", "expiring", ""].includes((s.coi_status ?? "").toLowerCase()))
    .map((s) => `${s.company_name} (${s.coi_status || "not set"})`);
  if (coiGaps.length) add("COI and W-9", "action", `COI missing or lapsing: ${list(coiGaps)}`);
  const w9Gaps = input.subs
    .filter((s) => s.active !== false)
    .filter((s) => ["pending", ""].includes((s.w9_status ?? "").toLowerCase()))
    .map((s) => s.company_name);
  if (w9Gaps.length) add("COI and W-9", "action", `W-9 missing: ${list(w9Gaps)}`);

  // Field reports: filed every weekday, and reviewed promptly.
  const filed = new Set(input.dprs.filter((d) => d.status !== "draft").map((d) => d.report_date));
  const missing = priorWeekdays(today, 5).filter((d) => !filed.has(d));
  if (missing.length) add("Field reports", "watch", `No field report for ${list(missing.map(md))}`);
  const waiting = input.dprs.filter((d) => d.status === "submitted" && (daysSince(d.submitted_at, today) ?? 0) > 2);
  if (waiting.length) add("Field reports", "action", `${waiting.length} field report${waiting.length === 1 ? "" : "s"} waiting on review more than 2 days`);

  // Schedule: leaf tasks past their finish and not done, and construction
  // work in progress with no field report in a week.
  const leaves = input.tasks.filter((t) => !input.tasks.some((o) => o.wbs_code.startsWith(`${t.wbs_code}.`)));
  const done = (t: (typeof leaves)[number]) => leafStateOf(t.status) === "complete" || (t.pct_complete ?? 0) >= 100;
  const overdue = leaves.filter((t) => t.end_date && t.end_date < today && !done(t));
  if (overdue.length) {
    add("Schedule", "action", `${overdue.length} task${overdue.length === 1 ? "" : "s"} past finish and not complete: ${list(overdue.map((t) => `${t.wbs_code} ${t.task_name}`), 4)}`);
  }
  const quiet = leaves.filter(
    (t) => t.task_type === "construction" && leafStateOf(t.status) === "inProgress" && !done(t) && (daysSince(t.last_dpr_at, today) ?? 99) > 7,
  );
  if (quiet.length) add("Schedule", "watch", `${quiet.length} construction task${quiet.length === 1 ? "" : "s"} in progress with no field report in 7 days`);

  // From the 18th, ahead of the AFP: this month's forecast not on an AFP yet.
  if (Number(today.slice(8, 10)) >= BILLING_PASS_FROM_DAY) {
    const month = `${today.slice(0, 7)}-01`;
    const open = input.billingEntries.filter(
      (e) => e.period_month.slice(0, 7) === today.slice(0, 7) && Number(e.planned_amount ?? 0) > 0 && !hasBillingEvidence(e),
    );
    if (open.length) {
      const total = open.reduce((s, e) => s + Number(e.planned_amount ?? 0), 0);
      add("Billing", "action", `${open.length} line${open.length === 1 ? "" : "s"} forecast for ${month.slice(0, 7)} not on an AFP yet, ${money(total)}`);
    }
  }

  return out;
}

/** The Chat message and the Notion card body, from one set of findings. */
export function auditMessages(projectName: string, findings: AuditFinding[], link?: string | null) {
  const actions = findings.filter((f) => f.severity === "action");
  const watch = findings.filter((f) => f.severity === "watch");
  const chat = findings.length
    ? [
        `${projectName} sync audit: ${actions.length} to do, ${watch.length} to watch.`,
        ...actions.map((f) => `- ${f.area}: ${f.text}`),
        ...(watch.length ? ["Watch:", ...watch.map((f) => `- ${f.area}: ${f.text}`)] : []),
        ...(link ? [link] : []),
      ].join("\n")
    : null;
  const card = [
    "## To do",
    ...(actions.length ? actions.map((f) => `- **${f.area}**: ${f.text}`) : ["- Nothing"]),
    "",
    "## Watch",
    ...(watch.length ? watch.map((f) => `- **${f.area}**: ${f.text}`) : ["- Nothing"]),
  ].join("\n");
  return { chat, card };
}
