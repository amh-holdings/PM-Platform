// The Sussex sync audit, read-only. Loads the project's rows and prints what
// has fallen behind.
//
// Usage:
//   npx tsx scripts/sync-audit/run.ts --project Sussex
//
// Prints one JSON report: { project, findings, chat, card }. "chat" is the
// Google Chat message (null when there is nothing to report) and "card" is the
// Notion card body. Every rule lives in src/lib/sync-audit.ts.

import { readFileSync } from "node:fs";

import { auditMessages, runAudit, type AuditInput } from "@/lib/sync-audit";
import { todayIso } from "@/lib/schedule-calendar";
import { loadEnvLocal, parseArgs, serviceClient } from "../commodity/lib";

function daysAgo(today: string, n: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs();
  const match = args.flag("project") ?? "Sussex";
  const db = serviceClient();
  const today = todayIso();

  const { data: projects, error } = await db.from("projects").select("id, name").ilike("name", `%${match}%`);
  if (error || !projects || projects.length !== 1) {
    console.error(error?.message ?? `Expected one project named like "${match}", found ${projects?.length ?? 0}.`);
    process.exit(2);
  }
  const project = projects[0] as { id: string; name: string };
  const pid = project.id;

  const [eu, bills, subs, afps, cos, dprs, tasks, lines] = await Promise.all([
    db.from("email_updates").select("status, created_at, summary").eq("project_id", pid),
    db.from("sub_pay_apps").select("id, app_number, status, created_at, subcontractor_id").eq("project_id", pid),
    db.from("subcontractors").select("id, company_name, coi_status, w9_status, active").eq("project_id", pid),
    db.from("pay_applications").select("app_number, status, submitted_at, paid_at").eq("project_id", pid),
    db.from("change_orders").select("co_number, status, submitted_at, description").eq("project_id", pid),
    db.from("dprs").select("report_date, status, submitted_at").eq("project_id", pid).gte("report_date", daysAgo(today, 14)),
    db.from("schedule_tasks").select("wbs_code, task_name, task_type, status, pct_complete, end_date, last_dpr_at").eq("project_id", pid),
    db.from("billing_lines").select("id").eq("project_id", pid),
  ]);
  const failures = [eu, bills, subs, afps, cos, dprs, tasks, lines].filter((r) => r.error).map((r) => r.error!.message);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(2);
  }

  const billRows = (bills.data ?? []) as { id: string; app_number: number; status: string; created_at: string | null; subcontractor_id: string }[];
  const openBillIds = billRows.filter((b) => b.status === "received" || b.status === "under_review").map((b) => b.id);
  const errorsByApp = new Map<string, number>();
  if (openBillIds.length) {
    const { data } = await db.from("sub_pay_app_checks").select("sub_pay_app_id, severity, status").in("sub_pay_app_id", openBillIds);
    for (const c of (data ?? []) as { sub_pay_app_id: string; severity: string; status: string }[]) {
      if (c.severity === "error" && c.status === "fail") errorsByApp.set(c.sub_pay_app_id, (errorsByApp.get(c.sub_pay_app_id) ?? 0) + 1);
    }
  }
  const subRows = (subs.data ?? []) as { id: string; company_name: string; coi_status: string | null; w9_status: string | null; active: boolean | null }[];
  const subName = new Map(subRows.map((s) => [s.id, s.company_name]));

  const lineIds = ((lines.data ?? []) as { id: string }[]).map((l) => l.id);
  const entries = lineIds.length
    ? (await db.from("billing_entries").select("period_month, planned_amount, status, pay_application_id, afp_number")
        .in("billing_line_id", lineIds).gte("period_month", `${today.slice(0, 7)}-01`)).data ?? []
    : [];

  const input: AuditInput = {
    today,
    emailUpdates: (eu.data ?? []) as AuditInput["emailUpdates"],
    subBills: billRows.map((b) => ({
      company_name: subName.get(b.subcontractor_id) ?? "Sub",
      app_number: b.app_number,
      status: b.status,
      created_at: b.created_at,
      error_checks: errorsByApp.get(b.id) ?? 0,
    })),
    afps: (afps.data ?? []) as AuditInput["afps"],
    changeOrders: (cos.data ?? []) as AuditInput["changeOrders"],
    subs: subRows,
    dprs: (dprs.data ?? []) as AuditInput["dprs"],
    tasks: (tasks.data ?? []) as AuditInput["tasks"],
    billingEntries: entries as AuditInput["billingEntries"],
  };

  const findings = runAudit(input);
  const config = JSON.parse(readFileSync("config/email-sweep.json", "utf8")) as { appUrl?: string };
  const appUrl = (loadEnvLocal().APP_URL || config.appUrl || "").replace(/\/$/, "");
  const { chat, card } = auditMessages(project.name, findings, appUrl ? `${appUrl}/projects/${pid}` : null);
  console.log(JSON.stringify({ project: project.name, projectId: pid, today, findings, chat, card }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
