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
  planAfpPaidApply,
  planAfpStatusApply,
  planComplianceApply,
  type AfpRecord,
  type EmailUpdateKind,
  type SubCompliance,
  type TaskPatch,
  type TaskSnapshot,
  type UndoData,
} from "./email-updates";
import type { SubBillInput } from "./sub-bill-build";

/** What the sweep hands over for one thing an email reported. */
export type SweepEvent =
  | ScheduleEvent
  | PayAppEvent
  | ComplianceEvent
  | AfpStatusEvent
  | AfpPaidEvent
  | InspectionEvent
  | ChangeOrderEvent;

/** A COI or W-9 sent in for a sub. */
export type ComplianceEvent = {
  project: string;
  kind: "compliance_doc";
  subcontractor: string;
  doc: "coi" | "w9";
  expires_on?: string | null;
  evidence?: string | null;
  source: SweepSource;
};

/** The owner reporting where an AFP stands: received, under review, sent for payment. */
export type AfpStatusEvent = {
  project: string;
  kind: "afp_status";
  /** As the email writes it: "AFP 13", "Pay App #13", "13". */
  afp_number: string;
  note: string;
  source: SweepSource;
};

/** The owner reporting an AFP paid. */
export type AfpPaidEvent = {
  project: string;
  kind: "afp_paid";
  afp_number: string;
  paid_on: string;
  amount?: number | null;
  evidence?: string | null;
  source: SweepSource;
};

/** A third-party or owner inspection result. */
export type InspectionEvent = {
  project: string;
  kind: "inspection_result";
  task_hint: string;
  wbs_code?: string | null;
  result: "passed" | "failed";
  date: string;
  inspector?: string | null;
  evidence?: string | null;
  source: SweepSource;
};

/** Something that reads like a change: new scope, a directive, a revised proposal. */
export type ChangeOrderEvent = {
  project: string;
  kind: "change_order";
  title: string;
  description?: string | null;
  reference?: string | null;
  evidence?: string | null;
  source: SweepSource;
};

export type SweepSource = {
  message_id: string;
  url?: string | null;
  /** The original sender. For a forwarded email, the address inside the forward. */
  from: string;
  subject?: string | null;
  received_at?: string | null;
};

/** A schedule fact: something happened, started, or a date was committed to. */
export type ScheduleEvent = {
  /** Project name or part of it, e.g. "Sussex". */
  project: string;
  kind: "schedule_complete" | "schedule_constraint" | "schedule_start";
  /**
   * Where the fact came from. "calendar" is a meeting on the calendar, such as
   * a page turn, whose time has passed: likely held, not confirmed, so it is
   * proposed rather than applied. Defaults to "email".
   */
  basis?: "email" | "calendar" | null;
  /** The task in the email's words: "building permit", "electrical IFC page turn". */
  task_hint: string;
  /** Only when the email itself quotes the WBS code. */
  wbs_code?: string | null;
  /** YYYY-MM-DD. The day it happened or started; for a constraint, the committed date. */
  date: string;
  /** SNET, SNLT, FNET, FNLT, MSO or MFO. Constraints only. */
  constraint_type?: string | null;
  /** The sentence in the email that says so, quoted. Shown as the match reason. */
  evidence?: string | null;
  source: SweepSource;
};

/** A sub's pay application, read from the G702/G703 attached to the email. */
export type PayAppEvent = {
  project: string;
  kind: "sub_pay_app";
  /** The sub's company name as it appears on the G702. */
  subcontractor: string;
  /** The G702 header. Leave a figure out rather than guess it. */
  bill: Omit<SubBillInput, "this_period" | "stored">;
  /** The G703 continuation sheet, one entry per line with a figure on it. */
  lines: { item_number: string; this_period: number; stored?: number | null }[];
  source: SweepSource;
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
  target_table: "schedule_tasks" | "sub_pay_apps" | "subcontractors" | "pay_applications" | null;
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
 * - A completion read from the calendar, a start, and a planned date are
 *   never applied on their own. They are proposed.
 * - No single match, and the email is parked as unmatched for a person.
 * - A refusal from planApply (construction task, future date, already done) is
 *   skipped and reported, because approving it would be refused the same way.
 */
export function planIngest(input: {
  event: ScheduleEvent;
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
  // procurement or inspection task, so a completion that gets here is safe to
  // apply. A meeting on the calendar is not proof it was held, so a completion
  // read from the calendar waits for a person.
  if (event.kind === "schedule_complete" && event.basis !== "calendar") {
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
      summary:
        event.kind === "schedule_complete"
          ? `Mark complete on ${fmt(event.date)} (meeting on the calendar, confirm it was held)`
          : event.kind === "schedule_start"
            ? `Mark started on ${fmt(event.date)}`
            : `${CONSTRAINT_WORDS[String(payload.type)] ?? String(payload.type)} ${fmt(event.date)}`,
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

// ---------------------------------------------------------------------------
// Sub pay applications
// ---------------------------------------------------------------------------

export type PayAppSub = { id: string; company_name: string; contact_email: string | null };

export type PayAppPlan =
  | { action: "skip"; reason: string }
  | { action: "unmatched"; row: PlannedRow }
  | { action: "enter"; sub: PayAppSub; bill: SubBillInput; row: PlannedRow };

/** Lines may differ from the stated total by rounding, never more. */
export const PAY_APP_TOLERANCE = 1;

function money(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const COMPANY_NOISE = new Set(["llc", "inc", "co", "corp", "company", "ltd"]);

/** Subs whose name holds every word of the name in the email. */
export function matchSubs<T extends { company_name: string }>(name: string, subs: readonly T[]): T[] {
  const want = tokens(name).filter((t) => !COMPANY_NOISE.has(t));
  if (!want.length) return [];
  return subs.filter((s) => {
    const have = new Set(tokens(s.company_name));
    return want.every((w) => have.has(w));
  });
}

/**
 * What a pay application from email becomes.
 *
 * It is entered as Received - which only starts the review: the CM still
 * recommends and approval still decides - when every check passes:
 *   - the company name matches exactly one sub on the project
 *   - the email came from that sub's own domain (the contact email on file)
 *   - the sub has an SOV, and every G703 line is one of its item numbers
 *   - the G703 lines add up to the G702's this-period figure
 *   - that application number is not already on file
 * Anything else is parked as unmatched with the reason, for a person to enter
 * by hand from the email. Nothing is ever guessed into a bill.
 */
export function planPayAppIngest(input: {
  event: PayAppEvent;
  subs: readonly PayAppSub[];
  /** Active SOV item numbers per sub id. */
  sovItems: ReadonlyMap<string, readonly string[]>;
  /** App numbers on file per sub id, rejected ones excluded. */
  liveAppNumbers: ReadonlyMap<string, readonly number[]>;
}): PayAppPlan {
  const { event } = input;
  const src = {
    source_message_id: event.source.message_id,
    source_url: event.source.url ?? null,
    source_from: event.source.from,
    source_subject: event.source.subject ?? null,
    source_received_at: event.source.received_at ?? null,
  };
  if (!event.source.message_id) return { action: "skip", reason: "No message id on the event." };

  const lines = event.lines ?? [];
  const appLabel = event.bill?.app_number ? `Application ${event.bill.app_number}` : "Pay application";
  const total = lines.reduce((s, l) => s + Number(l.this_period ?? 0), 0);
  const park = (why: string, subId: string | null = null): PayAppPlan => ({
    action: "unmatched",
    row: {
      kind: "unmatched",
      status: "proposed",
      auto_applied: false,
      summary: `${KIND_LABEL.sub_pay_app}: ${appLabel} from "${event.subcontractor}", ${money(event.bill?.billed_this_period ?? total)} this period. ${why} Enter it by hand from the email.`,
      target_table: null,
      target_id: null,
      payload: { event_kind: "sub_pay_app", subcontractor: event.subcontractor, sub_id: subId, bill: event.bill, lines },
      undo_data: null,
      match_reason: why,
      ...src,
    },
  });

  // The sub.
  const hits = matchSubs(event.subcontractor ?? "", input.subs);
  if (hits.length !== 1) {
    return park(
      hits.length
        ? `Matches ${hits.length} subs: ${hits.map((s) => s.company_name).join(", ")}.`
        : "No sub on this project by that name.",
    );
  }
  const sub = hits[0];

  // The sender is the sub. Our own people forwarding a bill go to a person.
  const senderDomain = (emailAddress(event.source.from) ?? "").split("@")[1] ?? "";
  const subDomain = (emailAddress(sub.contact_email ?? "") ?? "").split("@")[1] ?? "";
  if (!subDomain) return park(`${sub.company_name} has no contact email on file to check the sender against.`, sub.id);
  if (senderDomain !== subDomain) {
    return park(`Sent from ${senderDomain || "an unknown address"}, not ${sub.company_name}'s ${subDomain}.`, sub.id);
  }

  // The lines.
  const items = input.sovItems.get(sub.id) ?? [];
  if (items.length === 0) return park(`${sub.company_name} has no SOV loaded.`, sub.id);
  if (lines.length === 0) return park("No G703 lines were read from the attachment.", sub.id);
  const known = new Set(items);
  const unknown = lines.filter((l) => !known.has(String(l.item_number).trim())).map((l) => l.item_number);
  if (unknown.length) return park(`Line items not on the SOV: ${unknown.slice(0, 8).join(", ")}.`, sub.id);
  const seen = new Set<string>();
  for (const l of lines) {
    const k = String(l.item_number).trim();
    if (seen.has(k)) return park(`Item ${k} appears twice on the G703.`, sub.id);
    seen.add(k);
  }
  if (lines.some((l) => !Number.isFinite(Number(l.this_period)) || Number(l.this_period) < 0)) {
    return park("A G703 line has a negative or unreadable amount.", sub.id);
  }

  // The arithmetic.
  const stated = event.bill?.billed_this_period;
  if (stated == null) return park("The G702 this-period figure was not read.", sub.id);
  if (Math.abs(total - stated) > PAY_APP_TOLERANCE) {
    return park(`G703 lines total ${money(total)} but the G702 says ${money(stated)}.`, sub.id);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.bill.period_end ?? "")) return park("No usable period end date.", sub.id);

  // Not already on file.
  if (event.bill.app_number != null && (input.liveAppNumbers.get(sub.id) ?? []).includes(event.bill.app_number)) {
    return { action: "skip", reason: `${sub.company_name} application ${event.bill.app_number} is already on file.` };
  }

  const thisPeriod: Record<string, number> = {};
  const stored: Record<string, number> = {};
  for (const l of lines) {
    const k = String(l.item_number).trim();
    thisPeriod[k] = Number(l.this_period);
    if (l.stored) stored[k] = Number(l.stored);
  }
  return {
    action: "enter",
    sub,
    bill: { ...event.bill, this_period: thisPeriod, stored },
    row: {
      kind: "sub_pay_app",
      status: "applied",
      auto_applied: true,
      summary: `${sub.company_name} ${appLabel.toLowerCase()} entered as Received, ${money(stated)} this period. Checks run.`,
      target_table: null,
      target_id: null,
      payload: { sub_id: sub.id, app_number: event.bill.app_number ?? null, billed_this_period: stated },
      undo_data: null,
      match_reason: `Sender is ${sub.company_name} (${subDomain}). G703 lines match the SOV and add up to the G702.`,
      ...src,
    },
  };
}

// ---------------------------------------------------------------------------
// COI and W-9, AFP status and payment, inspections, change orders
// ---------------------------------------------------------------------------

/** What one of the step 4 events becomes. `apply` is set only when it is applied now. */
export type RecordIngestPlan =
  | { action: "skip"; reason: string }
  | {
      action: "insert";
      row: PlannedRow;
      apply: { table: "subcontractors" | "pay_applications"; id: string; patch: Record<string, unknown> } | null;
    };

type Src = Pick<PlannedRow, "source_message_id" | "source_url" | "source_from" | "source_subject" | "source_received_at">;

function srcOf(source: SweepSource): Src {
  return {
    source_message_id: source.message_id,
    source_url: source.url ?? null,
    source_from: source.from,
    source_subject: source.subject ?? null,
    source_received_at: source.received_at ?? null,
  };
}

function unmatchedRow(kind: EmailUpdateKind, summary: string, payload: Record<string, unknown>, src: Src, why: string | null = null): PlannedRow {
  return {
    kind: "unmatched",
    status: "proposed",
    auto_applied: false,
    summary: `${KIND_LABEL[kind]}: ${summary}`,
    target_table: null,
    target_id: null,
    payload: { ...payload, event_kind: kind },
    undo_data: null,
    match_reason: why,
    ...src,
  };
}

export type ComplianceSub = SubCompliance & { contact_email: string | null };

/**
 * A COI or W-9. Marked received now when the company matches one sub and the
 * email came from the project's sender list or the sub's own domain. A COI
 * usually comes from the sub's insurance broker, so one from any other
 * address is not dropped: it waits for a person with the reason.
 */
export function planComplianceIngest(input: {
  event: ComplianceEvent;
  subs: readonly ComplianceSub[];
  projectId: string;
  /** The sender is on the project's list. */
  senderOnList: boolean;
}): RecordIngestPlan {
  const { event } = input;
  if (!event.source.message_id) return { action: "skip", reason: "No message id on the event." };
  const src = srcOf(event.source);
  const docName = event.doc === "coi" ? "COI" : "W-9";
  const payload: Record<string, unknown> = { doc: event.doc, expires_on: event.expires_on ?? null };
  const hits = matchSubs(event.subcontractor, input.subs);
  if (hits.length !== 1) {
    const why = hits.length ? `Matches ${hits.length} subs.` : "No sub on this project by that name.";
    return { action: "insert", apply: null, row: unmatchedRow("compliance_doc", `${docName} for "${event.subcontractor}". ${why}`, { ...payload, subcontractor: event.subcontractor }, src, why) };
  }
  const sub = hits[0];
  const senderDomain = (emailAddress(event.source.from) ?? "").split("@")[1] ?? "";
  const subDomain = (emailAddress(sub.contact_email ?? "") ?? "").split("@")[1] ?? "";
  const trusted = input.senderOnList || (subDomain !== "" && senderDomain === subDomain);
  const plan = planComplianceApply({ project_id: input.projectId, payload }, sub);
  if (!plan.ok) return { action: "skip", reason: plan.reason };
  const expires = event.expires_on ? `, expires ${fmt(event.expires_on)}` : "";
  if (!trusted) {
    return {
      action: "insert",
      apply: null,
      row: {
        kind: "compliance_doc",
        status: "proposed",
        auto_applied: false,
        summary: `${sub.company_name} ${docName} received${expires}. Sent from ${senderDomain || "an unknown address"}, check it before approving.`,
        target_table: "subcontractors",
        target_id: sub.id,
        payload,
        undo_data: null,
        match_reason: event.evidence ?? null,
        ...src,
      },
    };
  }
  return {
    action: "insert",
    apply: { table: plan.table, id: plan.id, patch: plan.patch },
    row: {
      kind: "compliance_doc",
      status: "applied",
      auto_applied: true,
      summary: `${sub.company_name} ${docName} marked received${expires}`,
      target_table: "subcontractors",
      target_id: sub.id,
      payload,
      undo_data: { table: "subcontractors", applied: plan.patch, restore: plan.undo },
      match_reason: event.evidence ?? `Sent from ${senderDomain}`,
      ...src,
    },
  };
}

/** "AFP 13", "Pay App #13", "13" all mean AFP 13. */
export function afpDigits(v: string | number | null | undefined): string | null {
  const m = String(v ?? "").match(/(\d+)/);
  return m ? String(Number(m[1])) : null;
}

export function matchAfp(afpNumber: string, afps: readonly AfpRecord[]): AfpRecord[] {
  const want = afpDigits(afpNumber);
  return want ? afps.filter((a) => afpDigits(a.app_number) === want) : [];
}

/**
 * An AFP status note is added to the AFP now. A payment is proposed: marking
 * an AFP paid moves billing, so a person confirms it, with the amount the
 * email reports set beside the amount the AFP asked for.
 */
export function planAfpIngest(input: {
  event: AfpStatusEvent | AfpPaidEvent;
  afps: readonly AfpRecord[];
  projectId: string;
  today: string;
}): RecordIngestPlan {
  const { event } = input;
  if (!event.source.message_id) return { action: "skip", reason: "No message id on the event." };
  const src = srcOf(event.source);
  const hits = matchAfp(event.afp_number, input.afps);
  const base = { project_id: input.projectId };
  if (hits.length !== 1) {
    const why = hits.length ? `Matches ${hits.length} AFPs.` : `No AFP numbered "${event.afp_number}".`;
    const what = event.kind === "afp_status" ? `"${event.note}"` : `paid on ${event.paid_on}`;
    return { action: "insert", apply: null, row: unmatchedRow(event.kind, `${event.afp_number}: ${what}. ${why}`, { ...event, source: undefined }, src, why) };
  }
  const afp = hits[0];

  if (event.kind === "afp_status") {
    const payload = { note: event.note };
    const plan = planAfpStatusApply({ ...base, payload }, afp, input.today);
    if (!plan.ok) return { action: "skip", reason: plan.reason };
    return {
      action: "insert",
      apply: { table: plan.table, id: plan.id, patch: plan.patch },
      row: {
        kind: "afp_status",
        status: "applied",
        auto_applied: true,
        summary: `AFP ${afp.app_number}: ${event.note.slice(0, 200)}`,
        target_table: "pay_applications",
        target_id: afp.id,
        payload,
        undo_data: { table: "pay_applications", applied: plan.patch, restore: plan.undo },
        match_reason: null,
        ...src,
      },
    };
  }

  const payload = { paid_on: event.paid_on, amount: event.amount ?? null };
  const plan = planAfpPaidApply({ ...base, payload }, afp, input.today);
  if (!plan.ok) return { action: "skip", reason: plan.reason };
  const due = afp.amount_due != null ? Number(afp.amount_due) : null;
  const amountNote =
    event.amount != null
      ? due != null && Math.abs(event.amount - due) > PAY_APP_TOLERANCE
        ? ` Received ${money(event.amount)} against ${money(due)} due, short ${money(due - event.amount)}.`
        : ` Received ${money(event.amount)}.`
      : "";
  return {
    action: "insert",
    apply: null,
    row: {
      kind: "afp_paid",
      status: "proposed",
      auto_applied: false,
      summary: `Mark AFP ${afp.app_number} paid on ${fmt(event.paid_on)}.${amountNote}`,
      target_table: "pay_applications",
      target_id: afp.id,
      payload,
      undo_data: null,
      match_reason: event.evidence ?? null,
      ...src,
    },
  };
}

/**
 * An inspection result. Always proposed. A pass, once approved, marks the
 * inspection task complete on the inspection date. A fail changes nothing and
 * is there so the re-inspection gets planned.
 */
export function planInspectionIngest(input: {
  event: InspectionEvent;
  projectId: string;
  tasks: readonly SweepTask[];
  hasChildren: (taskId: string) => boolean;
  today: string;
}): IngestPlan {
  const { event } = input;
  if (!event.source.message_id) return { action: "skip", reason: "No message id on the event." };
  const src = srcOf(event.source);
  const payload = { result: event.result, date: event.date, inspector: event.inspector ?? null };
  const word = event.result === "passed" ? "Passed" : "Failed";
  const match = matchTask(event.task_hint, event.wbs_code, input.tasks);
  if (match.kind !== "one") {
    const names = match.kind === "many" ? match.candidates.map((t) => `${t.wbs_code} ${t.task_name}`) : [];
    return {
      action: "insert",
      apply: null,
      row: unmatchedRow(
        "inspection_result",
        `${word}: "${event.task_hint}" on ${fmt(event.date)}. ${names.length ? `Could be: ${names.join("; ")}.` : "No task matches."}`,
        { ...payload, task_hint: event.task_hint, candidates: names },
        src,
        event.evidence ?? null,
      ),
    };
  }
  const task = match.task;
  if (event.result === "passed") {
    const plan = planApply({
      row: { kind: "inspection_result", project_id: input.projectId, target_id: task.id, payload },
      task,
      hasChildren: input.hasChildren(task.id),
      today: input.today,
    });
    if (!plan.ok) return { action: "skip", reason: `${task.wbs_code} ${task.task_name}: ${plan.reason}` };
  }
  const by = event.inspector ? ` (${event.inspector})` : "";
  return {
    action: "insert",
    apply: null,
    row: {
      kind: "inspection_result",
      status: "proposed",
      auto_applied: false,
      summary:
        event.result === "passed"
          ? `Passed on ${fmt(event.date)}${by}. Approve to mark complete.`
          : `Failed on ${fmt(event.date)}${by}. Nothing changes; plan the re-inspection.`,
      target_table: "schedule_tasks",
      target_id: task.id,
      payload,
      undo_data: null,
      match_reason: [match.reason, event.evidence ? `"${event.evidence}"` : null].filter(Boolean).join(". "),
      ...src,
    },
  };
}

/**
 * Whether the email itself calls this a change order. Talk of extra work that
 * "may be required" is not one until somebody puts a change order in writing:
 * a CO request, a CO proposal, a signed CO or a directive issued as a CO.
 */
const CO_PHRASE = /\bchange[\s-]+orders?\b/i;
// Capitals only, so "co-ordinate" or "co." is not read as a CO.
const CO_ABBREVIATION = /\b(?:P?CO|COR|CCD)\b/;
export function changeOrderDocumented(event: ChangeOrderEvent): boolean {
  const text = `${event.reference ?? ""} ${event.evidence ?? ""}`;
  return CO_PHRASE.test(text) || CO_ABBREVIATION.test(text);
}

/**
 * A change order the email documents. Always proposed and never priced:
 * approving it records that it was handled, and the CO itself is raised by
 * hand in Change orders with the email beside it. Returns the reason instead
 * when there is nothing to record.
 */
export function planChangeOrderIngest(event: ChangeOrderEvent): PlannedRow | { skip: string } {
  if (!event.source.message_id || !event.title?.trim()) {
    return { skip: "No title or message id on the change order event." };
  }
  if (!changeOrderDocumented(event)) {
    return { skip: `"${event.title.trim()}": the email does not call it a change order, so it is not one yet.` };
  }
  const ref = event.reference ? ` (${event.reference})` : "";
  return {
    kind: "change_order",
    status: "proposed",
    auto_applied: false,
    summary: `Change order: ${event.title.trim()}${ref}. Raise it in Change orders.`,
    target_table: null,
    target_id: null,
    payload: { title: event.title, description: event.description ?? null, reference: event.reference ?? null },
    undo_data: null,
    match_reason: event.evidence ?? null,
    ...srcOf(event.source),
  };
}
