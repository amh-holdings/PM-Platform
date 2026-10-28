// Write the email sweep's events onto the Email updates page.
//
// The weekday Email Sweep on the Mac Mini reads Sussex mail, writes one event
// per thing an email reports into a JSON file, and runs this. Every rule lives
// in src/lib/email-sweep.ts; this file only reads, writes and reports.
//
// Order matters for safety. A row is inserted BEFORE its change is applied, so
// the unique index on (project, message, kind, target) makes a re-run of the
// same inbox a no-op instead of a second write. If the change then fails, the
// row is turned back into a proposal for a person rather than left claiming
// it was applied.
//
// Usage:
//   npx tsx scripts/email-sweep/ingest.ts --file <events.json> [--dry-run]
//
// events.json is { "events": [SweepEvent, ...] } or a bare array. Prints one
// JSON report to stdout. Its "chat" field is the Google Chat message to post,
// or null when nothing waits on a decision.

import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  chatNotice,
  planIngest,
  planPayAppIngest,
  senderAllowed,
  type PayAppEvent,
  type PayAppSub,
  type SweepConfig,
  type SweepEvent,
  type SweepTask,
} from "@/lib/email-sweep";
import { acceptedHistory, buildSubBill, lineRows } from "@/lib/sub-bill-build";
import { runVerificationCore } from "@/lib/sub-billing-run";
import type { SubBillingClient } from "@/lib/sub-billing.types";
import { summaryStatusChanges } from "@/lib/schedule-summary-status";
import { todayIso } from "@/lib/schedule-calendar";
import { loadEnvLocal, parseArgs, serviceClient } from "../commodity/lib";

const TASK_COLUMNS =
  "id, project_id, task_name, task_type, status, pct_complete, end_date, status_source, date_constraint_type, date_constraint_date, wbs_code";

type Report = {
  project: string;
  projectId: string | null;
  dryRun: boolean;
  applied: string[];
  proposed: string[];
  unmatched: string[];
  alreadyRecorded: string[];
  skipped: { message_id: string; reason: string }[];
  errors: string[];
  waiting: number;
  chat: string | null;
};

async function main() {
  const args = parseArgs();
  const file = args.flag("file");
  if (!file) {
    console.error("Missing --file <events.json>");
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const events: SweepEvent[] = Array.isArray(raw) ? raw : raw.events ?? [];
  const config: SweepConfig = JSON.parse(readFileSync("config/email-sweep.json", "utf8"));
  const appUrl = (loadEnvLocal().APP_URL || config.appUrl || "").replace(/\/$/, "");
  const supabase = serviceClient();
  const today = todayIso();

  // One report per configured project the events touch.
  const byProject = new Map<string, SweepEvent[]>();
  const orphans: Report["skipped"] = [];
  for (const e of events) {
    const cfg = config.projects.find((p) => (e.project ?? "").toLowerCase().includes(p.match.toLowerCase()));
    if (!cfg) {
      orphans.push({ message_id: e.source?.message_id ?? "", reason: `No sweep config for project "${e.project}".` });
      continue;
    }
    byProject.set(cfg.match, [...(byProject.get(cfg.match) ?? []), e]);
  }

  const reports: Report[] = [];
  for (const [match, list] of Array.from(byProject)) {
    const cfg = config.projects.find((p) => p.match === match)!;
    const report: Report = {
      project: match, projectId: null, dryRun: args.dryRun, applied: [], proposed: [], unmatched: [],
      alreadyRecorded: [], skipped: [], errors: [], waiting: 0, chat: null,
    };
    reports.push(report);

    const { data: projects, error: pErr } = await supabase
      .from("projects").select("id, name").ilike("name", `%${match}%`);
    if (pErr || !projects || projects.length !== 1) {
      report.errors.push(pErr?.message ?? `Expected one project named like "${match}", found ${projects?.length ?? 0}.`);
      continue;
    }
    const projectId = projects[0].id as string;
    report.projectId = projectId;

    const { data: taskRows, error: tErr } = await supabase
      .from("schedule_tasks").select(TASK_COLUMNS).eq("project_id", projectId);
    if (tErr || !taskRows) {
      report.errors.push(tErr?.message ?? "Could not read the schedule.");
      continue;
    }
    const tasks = taskRows as SweepTask[];
    const parents = new Set(
      tasks.filter((t) => tasks.some((o) => o.wbs_code.startsWith(`${t.wbs_code}.`))).map((t) => t.id),
    );
    let appliedAny = false;
    const payAppCache: { ctx: PayAppContext | null } = { ctx: null };

    for (const event of list) {
      const id = event.source?.message_id ?? "";
      const sender = senderAllowed(event.source?.from ?? "", cfg.senderDomains, config.forwarders);
      if (!sender.ok) {
        report.skipped.push({ message_id: id, reason: sender.reason });
        continue;
      }
      if (event.kind === "sub_pay_app") {
        await ingestPayApp(supabase, projectId, event, report, args.dryRun, payAppCache);
        continue;
      }
      const plan = planIngest({ event, projectId, tasks, hasChildren: (tid) => parents.has(tid), today });
      if (plan.action === "skip") {
        report.skipped.push({ message_id: id, reason: plan.reason });
        continue;
      }
      const label = `${plan.row.summary}${plan.row.target_id ? ` (${tasks.find((t) => t.id === plan.row.target_id)?.wbs_code})` : ""}`;
      if (args.dryRun) {
        (plan.row.status === "applied" ? report.applied : plan.row.kind === "unmatched" ? report.unmatched : report.proposed).push(label);
        continue;
      }

      const { data: inserted, error: iErr } = await supabase
        .from("email_updates").insert({ project_id: projectId, ...plan.row }).select("id").maybeSingle();
      if (iErr) {
        if (iErr.code === "23505") report.alreadyRecorded.push(label);
        else report.errors.push(`${id}: ${iErr.message}`);
        continue;
      }

      if (plan.apply) {
        const { error: aErr } = await supabase
          .from("schedule_tasks").update(plan.apply.patch).eq("id", plan.apply.id).eq("project_id", projectId);
        if (aErr) {
          await supabase.from("email_updates").update({
            status: "proposed", auto_applied: false, undo_data: null,
            summary: `${plan.row.summary.replace(/^Marked/, "Mark")} (automatic apply failed: ${aErr.message})`,
          }).eq("id", (inserted as { id: string }).id);
          report.proposed.push(label);
          continue;
        }
        // Later events in this run see the change, so a second email about the
        // same permit is recognised as already done.
        const t = tasks.find((x) => x.id === plan.apply!.id);
        if (t) Object.assign(t, plan.apply.patch);
        appliedAny = true;
        report.applied.push(label);
      } else if (plan.row.kind === "unmatched") report.unmatched.push(label);
      else report.proposed.push(label);
    }

    // Summary rows follow their children, the same as after a save in the app.
    if (appliedAny) {
      const { data: rows } = await supabase.from("schedule_tasks").select("id, wbs_code, status").eq("project_id", projectId);
      const all = (rows ?? []) as { id: string; wbs_code: string; status: string | null }[];
      for (const change of summaryStatusChanges(all)) {
        const row = all.find((r) => r.wbs_code === change.wbs_code);
        if (row) await supabase.from("schedule_tasks").update({ status: change.to }).eq("id", row.id);
      }
    }

    // The notice lists everything still waiting, not just this run's rows.
    const { data: waitingRows } = await supabase
      .from("email_updates").select("summary, target_id").eq("project_id", projectId).eq("status", "proposed")
      .order("created_at", { ascending: true });
    const waiting = ((waitingRows ?? []) as { summary: string; target_id: string | null }[]).map((w) => {
      const t = tasks.find((x) => x.id === w.target_id);
      return { summary: w.summary, target: t ? `${t.wbs_code} ${t.task_name}` : null };
    });
    report.waiting = waiting.length;
    report.chat = args.dryRun ? null : chatNotice({
      projectName: projects[0].name as string,
      waiting,
      appliedThisRun: report.applied.length,
      link: appUrl ? `${appUrl}/projects/${projectId}/email-updates` : null,
    });
  }

  console.log(JSON.stringify({ reports, unconfigured: orphans }, null, 2));
  if (reports.some((r) => r.errors.length)) process.exit(2);
}

// ---------------------------------------------------------------------------
// Sub pay applications
// ---------------------------------------------------------------------------

type PayAppContext = {
  subs: PayAppSub[];
  sovItems: Map<string, string[]>;
  liveAppNumbers: Map<string, number[]>;
};

async function loadPayAppContext(db: SupabaseClient, projectId: string): Promise<PayAppContext> {
  const [subsRes, sovRes, appsRes] = await Promise.all([
    db.from("subcontractors").select("id, company_name, contact_email").eq("project_id", projectId),
    db.from("sub_sov_lines").select("subcontractor_id, item_number").eq("project_id", projectId).eq("active", true),
    db.from("sub_pay_apps").select("subcontractor_id, app_number, status").eq("project_id", projectId),
  ]);
  const sovItems = new Map<string, string[]>();
  for (const r of (sovRes.data ?? []) as { subcontractor_id: string; item_number: string }[]) {
    sovItems.set(r.subcontractor_id, [...(sovItems.get(r.subcontractor_id) ?? []), r.item_number]);
  }
  const liveAppNumbers = new Map<string, number[]>();
  for (const r of (appsRes.data ?? []) as { subcontractor_id: string; app_number: number; status: string }[]) {
    if (r.status === "rejected") continue;
    liveAppNumbers.set(r.subcontractor_id, [...(liveAppNumbers.get(r.subcontractor_id) ?? []), r.app_number]);
  }
  return { subs: (subsRes.data ?? []) as PayAppSub[], sovItems, liveAppNumbers };
}

/**
 * Enter one emailed pay application, the same way Record a bill does: built
 * by buildSubBill against our SOV and approved history, saved as Received,
 * then the checks run. The email row goes in first so a re-run is a no-op,
 * and if the bill cannot be saved the row is turned into a proposal saying why.
 */
async function ingestPayApp(
  db: SupabaseClient,
  projectId: string,
  event: PayAppEvent,
  report: Report,
  dryRun: boolean,
  cache: { ctx: PayAppContext | null },
) {
  const id = event.source?.message_id ?? "";
  cache.ctx ??= await loadPayAppContext(db, projectId);
  const ctx = cache.ctx;
  const plan = planPayAppIngest({ event, ...ctx });
  if (plan.action === "skip") {
    report.skipped.push({ message_id: id, reason: plan.reason });
    return;
  }
  const label = plan.row.summary;
  if (dryRun) {
    (plan.action === "enter" ? report.applied : report.unmatched).push(label);
    return;
  }

  const { data: inserted, error: iErr } = await db
    .from("email_updates").insert({ project_id: projectId, ...plan.row }).select("id").maybeSingle();
  if (iErr) {
    if (iErr.code === "23505") report.alreadyRecorded.push(label);
    else report.errors.push(`${id}: ${iErr.message}`);
    return;
  }
  const rowId = (inserted as { id: string }).id;
  if (plan.action === "unmatched") {
    report.unmatched.push(label);
    return;
  }

  const fail = async (why: string) => {
    await db.from("email_updates").update({
      status: "proposed", auto_applied: false, undo_data: null,
      summary: `${plan.row.summary.replace(/ entered as Received/, " not entered")} Automatic entry failed: ${why} Enter it by hand from the email.`,
    }).eq("id", rowId);
    report.proposed.push(label);
  };

  const subId = plan.sub.id;
  const [subRes, sovRes, histRes] = await Promise.all([
    db.from("subcontractors").select("retainage_pct").eq("id", subId).single(),
    db.from("sub_sov_lines").select("id, item_number, description, scheduled_value")
      .eq("subcontractor_id", subId).eq("active", true).order("sort_order"),
    db.from("sub_pay_apps").select("id, app_number, status, retainage_to_date")
      .eq("subcontractor_id", subId).order("app_number", { ascending: true }),
  ]);
  const history = (histRes.data ?? []) as { id: string; app_number: number; status: string; retainage_to_date: number | null }[];
  const accepted = acceptedHistory(history);
  let priorLines: Parameters<typeof buildSubBill>[0]["priorLines"] = [];
  if (accepted.length) {
    const { data } = await db.from("sub_pay_app_lines")
      .select("item_number, this_period, materials_stored, approved_this_period")
      .in("sub_pay_app_id", accepted.map((a) => a.id));
    priorLines = data ?? [];
  }
  const built = buildSubBill({
    bill: {
      ...plan.bill,
      notes: [plan.bill.notes, `Entered from email: ${event.source.subject ?? id}`].filter(Boolean).join("\n"),
    },
    subRetainagePct: (subRes.data as { retainage_pct: number | null } | null)?.retainage_pct ?? null,
    sovLines: (sovRes.data ?? []) as { id: string; item_number: string; description: string; scheduled_value: number | null }[],
    history,
    priorLines,
  });

  const { data: app, error: appErr } = await db.from("sub_pay_apps").insert({
    ...built.row, project_id: projectId, subcontractor_id: subId, status: "received", entered_by: null,
  }).select("id").single();
  if (appErr || !app) {
    await fail(appErr?.code === "23505" ? `Application ${built.appNumber} already exists.` : appErr?.message ?? "Could not save the bill.");
    return;
  }
  const appId = (app as { id: string }).id;
  const { error: lineErr } = await db.from("sub_pay_app_lines").insert(lineRows(appId, built.lines));
  if (lineErr) {
    await db.from("sub_pay_apps").delete().eq("id", appId);
    await fail(lineErr.message);
    return;
  }

  // The same checks the app runs after Record a bill.
  await runVerificationCore(db as unknown as SubBillingClient, appId);

  await db.from("email_updates").update({
    target_table: "sub_pay_apps", target_id: appId, undo_data: { table: "sub_pay_apps", id: appId },
  }).eq("id", rowId);
  ctx.liveAppNumbers.set(subId, [...(ctx.liveAppNumbers.get(subId) ?? []), built.appNumber]);
  report.applied.push(label);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
