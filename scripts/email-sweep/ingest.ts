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

import {
  chatNotice,
  planIngest,
  senderAllowed,
  type SweepConfig,
  type SweepEvent,
  type SweepTask,
} from "@/lib/email-sweep";
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

    for (const event of list) {
      const id = event.source?.message_id ?? "";
      const sender = senderAllowed(event.source?.from ?? "", cfg.senderDomains, config.forwarders);
      if (!sender.ok) {
        report.skipped.push({ message_id: id, reason: sender.reason });
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
