// Email sweep: turn what an email says into a row on the Email updates page.
//
// The sweep on the Mac Mini reads project mail and hands over one event per
// thing an email reports: "the building permit was issued on 10/27", "the
// electrical IFC page turn is set for 11/14". This module decides what each
// event becomes - applied now, proposed for a decision, parked as unmatched, or
// skipped - without touching the database, so the rules are tested here and
// the script only carries them out.
//
// Email is untrusted input. Nothing here believes an event: the sender is
// checked against the project's allowlist, the record is found in the
// database rather than taken from the email, and every write goes through the
// same planApply the page uses when someone clicks Approve.

import {
  KIND_LABEL,
  planApply,
  type EmailUpdateKind,
  type TaskPatch,
  type TaskSnapshot,
  type UndoData,
} from "./email-updates";

/** What the sweep hands over for one thing an email reported. */
export type SweepEvent = {
  /** Project name or part of it, e.g. "Sussex". */
  project: string;
  kind: "schedule_complete" | "schedule_constraint";
  /** The task in the email's words: "building permit", "electrical IFC page turn". */
  task_hint: string;
  /** Only when the email itself quotes the WBS code. */
  wbs_code?: string | null;
  /** YYYY-MM-DD. For a completion, the day it happened; for a constraint, the committed date. */
  date: string;
  /** SNET, SNLT, FNET, FNLT, MSO or MFO. Constraints only. */
  constraint_type?: string | null;
  /** The sentence in the email that says so, quoted. Shown as the match reason. */
  evidence?: string | null;
  source: {
    message_id: string;
    url?: string | null;
    /** The original sender. For a forwarded email, the address inside the forward. */
    from: string;
    subject?: string | null;
    received_at?: string | null;
  };
};

export type SweepConfig = {
  appUrl?: string;
  forwarders?: string[];
  projects: { match: string; senderDomains: string[] }[];
};

export type SweepTask = TaskSnapshot & { wbs_code: string };

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

/** The bare address out of "Name <a@b.com>" or "a@b.com", lower-cased. */
export function emailAddress(from: string): string | null {
  const m = from.match(/<([^>]+)>/);
  const addr = (m ? m[1] : from).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : null;
}

/**
 * Whether the sender may update this project. A forwarder is transport, not a
 * source: an event that still names the forwarder means the original sender
 * was never found, and that is refused rather than trusted.
 */
export function senderAllowed(
  from: string,
  domains: readonly string[],
  forwarders: readonly string[] = [],
): { ok: true } | { ok: false; reason: string } {
  const addr = emailAddress(from);
  if (!addr) return { ok: false, reason: `Unreadable sender "${from}".` };
  if (forwarders.map((f) => f.toLowerCase()).includes(addr)) {
    return { ok: false, reason: "Forwarded email with no original sender found." };
  }
  const domain = addr.split("@")[1];
  const hit = domains.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`));
  return hit ? { ok: true } : { ok: false, reason: `${addr} is not on this project's sender list.` };
}

// ---------------------------------------------------------------------------
// Task matching
// ---------------------------------------------------------------------------

const STOP = new Set([
  "the", "a", "an", "of", "for", "and", "to", "on", "in", "at", "is", "was", "has", "been",
  "be", "set", "held", "issued", "received", "approved", "submitted", "returned", "complete",
  "completed", "done", "task", "sussex", "csg", "project",
]);

export function tokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((t) => t.length > 1 && !STOP.has(t)),
    ),
  );
}

export type TaskMatch =
  | { kind: "one"; task: SweepTask; reason: string }
  | { kind: "many"; candidates: SweepTask[] }
  | { kind: "none" };

/**
 * Find the one task an event means.
 *
 * A quoted WBS code wins outright. Otherwise every word of the hint must
 * appear in the task name, among leaf tasks only - a summary's status comes
 * from the tasks under it. One hit is a match; two or more is ambiguous and
 * goes to a person. Near misses are offered as candidates, never chosen.
 */
export function matchTask(
  hint: string,
  wbsCode: string | null | undefined,
  tasks: readonly SweepTask[],
): TaskMatch {
  const leaves = tasks.filter(
    (t) => !tasks.some((o) => o.wbs_code.startsWith(`${t.wbs_code}.`)),
  );
  if (wbsCode) {
    const byCode = leaves.find((t) => t.wbs_code === wbsCode.trim());
    if (byCode) return { kind: "one", task: byCode, reason: `WBS ${byCode.wbs_code} quoted in the email` };
  }
  const want = tokens(hint);
  if (want.length === 0) return { kind: "none" };
  const scored = leaves
    .map((t) => {
      const have = new Set(tokens(t.task_name));
      const hits = want.filter((w) => have.has(w)).length;
      return { t, score: hits / want.length };
    })
    .filter((s) => s.score > 0);
  const full = scored.filter((s) => s.score === 1).map((s) => s.t);
  if (full.length === 1) {
    return { kind: "one", task: full[0], reason: `Task name has every word of "${hint}"` };
  }
  if (full.length > 1) return { kind: "many", candidates: full.slice(0, 5) };
  const near = scored.filter((s) => s.score >= 0.5).sort((a, b) => b.score - a.score);
  return near.length ? { kind: "many", candidates: near.slice(0, 5).map((s) => s.t) } : { kind: "none" };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** A row for email_updates, minus the project id the script fills in. */
export type PlannedRow = {
  kind: EmailUpdateKind;
  status: "proposed" | "applied";
  auto_applied: boolean;
  summary: string;
  target_table: "schedule_tasks" | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  undo_data: UndoData | null;
  match_reason: string | null;
  source_message_id: string;
  source_url: string | null;
  source_from: string;
  source_subject: string | null;
  source_received_at: string | null;
};

export type IngestPlan =
  | { action: "skip"; reason: string }
  | { action: "insert"; row: PlannedRow; apply: { id: string; patch: TaskPatch } | null };

function fmt(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const CONSTRAINT_WORDS: Record<string, string> = {
  SNET: "Start no earlier than",
  SNLT: "Start no later than",
  FNET: "Finish no earlier than",
  FNLT: "Finish no later than",
  MSO: "Must start on",
  MFO: "Must finish on",
};

/**
 * What one event becomes.
 *
 * - A completion that matches one deliverable, procurement or inspection task
 *   and passes planApply is applied now, with undo recorded.
 * - A planned date is never applied on its own. It is proposed.
 * - No single match, and the email is parked as unmatched for a person.
 * - A refusal from planApply (construction task, future date, already done) is
 *   skipped and reported, because approving it would be refused the same way.
 */
export function planIngest(input: {
  event: SweepEvent;
  projectId: string;
  tasks: readonly SweepTask[];
  hasChildren: (taskId: string) => boolean;
  today: string;
}): IngestPlan {
  const { event, projectId, tasks, today } = input;
  const src = {
    source_message_id: event.source.message_id,
    source_url: event.source.url ?? null,
    source_from: event.source.from,
    source_subject: event.source.subject ?? null,
    source_received_at: event.source.received_at ?? null,
  };
  if (!event.source.message_id) return { action: "skip", reason: "No message id on the event." };

  const payload: Record<string, unknown> = { date: event.date };
  if (event.kind === "schedule_constraint") payload.type = (event.constraint_type ?? "").toUpperCase();

  const match = matchTask(event.task_hint, event.wbs_code, tasks);
  if (match.kind !== "one") {
    const names = match.kind === "many" ? match.candidates.map((t) => `${t.wbs_code} ${t.task_name}`) : [];
    return {
      action: "insert",
      apply: null,
      row: {
        kind: "unmatched",
        status: "proposed",
        auto_applied: false,
        summary:
          `${KIND_LABEL[event.kind]}: "${event.task_hint}" on ${fmt(event.date)}. ` +
          (names.length ? `Could be: ${names.join("; ")}.` : "No task matches."),
        target_table: null,
        target_id: null,
        payload: { ...payload, event_kind: event.kind, task_hint: event.task_hint, candidates: names },
        undo_data: null,
        match_reason: event.evidence ?? null,
        ...src,
      },
    };
  }

  const task = match.task;
  const plan = planApply({
    row: { kind: event.kind, project_id: projectId, target_id: task.id, payload },
    task,
    hasChildren: input.hasChildren(task.id),
    today,
  });
  if (!plan.ok) return { action: "skip", reason: `${task.wbs_code} ${task.task_name}: ${plan.reason}` };
  if (plan.table === null) return { action: "skip", reason: "Nothing to apply." };

  const reason = [match.reason, event.evidence ? `"${event.evidence}"` : null].filter(Boolean).join(". ");
  // planApply has already refused a completion on anything but a deliverable,
  // procurement or inspection task, so a completion that gets here is safe to apply.
  if (event.kind === "schedule_complete") {
    return {
      action: "insert",
      apply: { id: plan.id, patch: plan.patch },
      row: {
        kind: "schedule_complete",
        status: "applied",
        auto_applied: true,
        summary: `Marked complete on ${fmt(event.date)}`,
        target_table: "schedule_tasks",
        target_id: task.id,
        payload,
        undo_data: { table: "schedule_tasks", applied: plan.patch, restore: plan.undo },
        match_reason: reason,
        ...src,
      },
    };
  }
  return {
    action: "insert",
    apply: null,
    row: {
      kind: event.kind,
      status: "proposed",
      auto_applied: false,
      summary: `${CONSTRAINT_WORDS[String(payload.type)] ?? String(payload.type)} ${fmt(event.date)}`,
      target_table: "schedule_tasks",
      target_id: task.id,
      payload,
      undo_data: null,
      match_reason: reason,
      ...src,
    },
  };
}

// ---------------------------------------------------------------------------
// Chat notice
// ---------------------------------------------------------------------------

/**
 * The Google Chat message after a run, or null when nothing waits on a
 * decision. A run that only applied changes, or found nothing, says nothing.
 */
export function chatNotice(input: {
  projectName: string;
  waiting: { summary: string; target?: string | null }[];
  appliedThisRun: number;
  link?: string | null;
}): string | null {
  const { waiting } = input;
  if (waiting.length === 0) return null;
  const lines = [
    `${input.projectName}: ${waiting.length} email ${waiting.length === 1 ? "update needs" : "updates need"} review.`,
    ...waiting.slice(0, 10).map((w) => `- ${w.target ? `${w.target}: ` : ""}${w.summary}`),
  ];
  if (waiting.length > 10) lines.push(`- and ${waiting.length - 10} more`);
  if (input.appliedThisRun > 0) {
    lines.push(`${input.appliedThisRun} applied automatically this run, undo on the page if wrong.`);
  }
  if (input.link) lines.push(input.link);
  return lines.join("\n");
}
