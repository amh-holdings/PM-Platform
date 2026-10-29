// Email updates: the rules every change from the email automation runs under.
//
// The sweep reads project email and either applies a change itself or proposes
// it here for the office to decide. This module is the pure half: which kinds exist,
// who may decide each one, what a change writes, and whether it can still be
// undone. The server actions and the sweep both call it, so the page and the
// automation can never disagree about a rule.
//
// Email is untrusted. Nothing in this file trusts a payload: every plan
// re-checks the target record and refuses rather than guessing.

import { COMPLETE_STATUS, progressCanBeSetByHand } from "./schedule-task-type";
import { DATE_CONSTRAINT_TYPES, type DateConstraintType } from "./schedule-cpm";

export const EMAIL_UPDATE_KINDS = [
  "schedule_complete",
  "schedule_constraint",
  "schedule_start",
  "sub_pay_app",
  "compliance_doc",
  "afp_status",
  "afp_paid",
  "inspection_result",
  "change_order",
  "percent_complete",
  "owner_dispute",
  "unmatched",
] as const;
export type EmailUpdateKind = (typeof EMAIL_UPDATE_KINDS)[number];

export const EMAIL_UPDATE_STATUSES = [
  "proposed",
  "approved",
  "applied",
  "rejected",
  "undone",
] as const;
export type EmailUpdateStatus = (typeof EMAIL_UPDATE_STATUSES)[number];

export const KIND_LABEL: Record<EmailUpdateKind, string> = {
  schedule_complete: "Schedule - completed",
  schedule_constraint: "Schedule - planned date",
  schedule_start: "Schedule - started",
  sub_pay_app: "Sub pay app",
  compliance_doc: "COI / W-9",
  afp_status: "AFP status",
  afp_paid: "AFP paid",
  inspection_result: "Inspection result",
  change_order: "Change order",
  percent_complete: "Percent complete",
  owner_dispute: "Owner dispute",
  unmatched: "Needs a match",
};

/**
 * The DB roles that see and decide email updates. Phil and Zarina are one
 * decider here: either can decide any row, and the app never names either.
 * The site team is not on the list. The table's requires_phil column is kept
 * for the record but nothing reads it.
 */
export const DECIDER_ROLES = ["phil", "zarina"] as const;

export type Decision = "approve" | "reject" | "undo";

/**
 * Whether this person may make this decision on this row right now. Returns
 * the reason when not, worded for the page.
 */
export function canDecide(
  row: { kind: string; status: string },
  dbRole: string | null | undefined,
  decision: Decision,
): { ok: true } | { ok: false; reason: string } {
  if (!dbRole || !(DECIDER_ROLES as readonly string[]).includes(dbRole)) {
    return { ok: false, reason: "You do not have access to email updates." };
  }
  if (decision === "undo") {
    return row.status === "applied"
      ? { ok: true }
      : { ok: false, reason: "Only an applied change can be undone." };
  }
  if (row.status !== "proposed") {
    return { ok: false, reason: `Already ${row.status}.` };
  }
  if (decision === "approve" && row.kind === "unmatched") {
    return {
      ok: false,
      reason: "This email did not match one record. Make the change by hand, then dismiss it.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Appliers. A kind with an applier changes a record when approved; a kind
// without one is approved as "done by hand" and changes nothing here. Later
// steps add appliers for pay apps, compliance documents and AFP status.
// ---------------------------------------------------------------------------

/** The schedule_tasks columns an applier may read or write. */
export type TaskSnapshot = {
  id: string;
  project_id: string;
  task_name: string;
  task_type: string | null;
  status: string | null;
  pct_complete: number | null;
  start_date: string | null;
  end_date: string | null;
  status_source: string | null;
  date_constraint_type: string | null;
  date_constraint_date: string | null;
};

export type TaskPatch = Partial<
  Pick<
    TaskSnapshot,
    | "status"
    | "pct_complete"
    | "start_date"
    | "end_date"
    | "status_source"
    | "date_constraint_type"
    | "date_constraint_date"
  >
>;

export type ApplyPlan =
  | { ok: true; table: "schedule_tasks"; id: string; patch: TaskPatch; undo: TaskPatch }
  | { ok: true; table: null }
  | { ok: false; reason: string };

export const KINDS_WITH_APPLIER: ReadonlySet<EmailUpdateKind> = new Set<EmailUpdateKind>([
  "schedule_complete",
  "schedule_constraint",
  "schedule_start",
  "inspection_result",
]);

const IN_PROGRESS_STATUS = "In Progress";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function pick(task: TaskSnapshot, keys: (keyof TaskPatch)[]): TaskPatch {
  const out: TaskPatch = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = task[k];
  return out;
}

/**
 * What approving this row writes, and what undo puts back.
 *
 * `task` is the target as it stands in the database now, never the copy in
 * the payload. `hasChildren` says the task is a summary, whose status is its
 * children's and is never set directly. `today` bounds a completion date: an
 * email cannot report something finished tomorrow.
 */
export function planApply(input: {
  row: { kind: string; project_id: string; target_id: string | null; payload: unknown };
  task: TaskSnapshot | null;
  hasChildren: boolean;
  today: string;
}): ApplyPlan {
  const { row, task } = input;
  const kind = row.kind as EmailUpdateKind;
  if (!KINDS_WITH_APPLIER.has(kind)) return { ok: true, table: null };
  // A failed inspection changes nothing in the schedule: it is a heads-up,
  // and the re-inspection is planned by hand.
  if (kind === "inspection_result" && (row.payload as { result?: string } | null)?.result !== "passed") {
    return { ok: true, table: null };
  }

  if (!row.target_id || !task) return { ok: false, reason: "The schedule task is gone." };
  if (task.id !== row.target_id || task.project_id !== row.project_id) {
    return { ok: false, reason: "The task is not on this project." };
  }
  if (input.hasChildren) {
    return { ok: false, reason: "That is a summary row. Its status comes from the tasks under it." };
  }
  const payload = (row.payload ?? {}) as Record<string, unknown>;

  if (kind === "schedule_complete" || kind === "inspection_result") {
    if (!progressCanBeSetByHand(task.task_type)) {
      return {
        ok: false,
        reason:
          task.task_type === "construction"
            ? "Construction progress comes from approved field reports, never from email."
            : "Set the task's Type to Deliverable, Procurement or Inspection first.",
      };
    }
    if (!isIsoDate(payload.date)) return { ok: false, reason: "The email gave no usable date." };
    if (payload.date > input.today) {
      return { ok: false, reason: `The completion date ${payload.date} is in the future.` };
    }
    if (task.status === COMPLETE_STATUS && (task.pct_complete ?? 0) >= 100) {
      return { ok: false, reason: "The task is already complete." };
    }
    const keys: (keyof TaskPatch)[] = ["status", "pct_complete", "end_date", "status_source"];
    return {
      ok: true,
      table: "schedule_tasks",
      id: task.id,
      patch: { status: COMPLETE_STATUS, pct_complete: 100, end_date: payload.date, status_source: "email" },
      undo: pick(task, keys),
    };
  }

  // schedule_start: work on a task has begun, such as a package's internal
  // review once its page turn is held. Started, not finished: no percent.
  if (kind === "schedule_start") {
    if (!progressCanBeSetByHand(task.task_type)) {
      return {
        ok: false,
        reason:
          task.task_type === "construction"
            ? "Construction progress comes from approved field reports, never from email."
            : "Set the task's Type to Deliverable, Procurement or Inspection first.",
      };
    }
    if (!isIsoDate(payload.date)) return { ok: false, reason: "No usable start date." };
    if (payload.date > input.today) {
      return { ok: false, reason: `The start date ${payload.date} is in the future.` };
    }
    if (task.status === COMPLETE_STATUS) return { ok: false, reason: "The task is already complete." };
    if (task.status === IN_PROGRESS_STATUS) return { ok: false, reason: "The task is already in progress." };
    return {
      ok: true,
      table: "schedule_tasks",
      id: task.id,
      patch: { status: IN_PROGRESS_STATUS, start_date: payload.date, status_source: "email" },
      undo: pick(task, ["status", "start_date", "status_source"]),
    };
  }

  // schedule_constraint: a planned date the email commits to, held as a date
  // constraint so the forecast works around it and shows what moves.
  const type = payload.type as DateConstraintType;
  if (!DATE_CONSTRAINT_TYPES.includes(type)) {
    return { ok: false, reason: "The email gave no usable constraint type." };
  }
  if (!isIsoDate(payload.date)) return { ok: false, reason: "The email gave no usable date." };
  if (task.date_constraint_type === type && task.date_constraint_date === payload.date) {
    return { ok: false, reason: "The task already carries that date." };
  }
  return {
    ok: true,
    table: "schedule_tasks",
    id: task.id,
    patch: { date_constraint_type: type, date_constraint_date: payload.date },
    undo: pick(task, ["date_constraint_type", "date_constraint_date"]),
  };
}

/**
 * Whether an applied change can still be undone. Undo only restores a record
 * nobody has touched since: if any field the change wrote now holds something
 * else, somebody has edited it, and putting the old value back would silently
 * erase their edit.
 */
export function planUndo<P extends Record<string, unknown>>(input: {
  applied: P;
  undo: P | null;
  /** The record as it stands now: a task, a sub, an AFP. */
  task: Record<string, unknown> | null;
  /** What to call the record in a refusal. */
  noun?: string;
}): { ok: true; patch: P } | { ok: false; reason: string } {
  const noun = input.noun ?? "task";
  if (!input.undo) return { ok: false, reason: "Nothing was recorded to undo." };
  if (!input.task) return { ok: false, reason: `The ${noun} is gone.` };
  const changed = Object.keys(input.applied).filter(
    (k) => !sameValue(input.task![k], input.applied[k]),
  );
  if (changed.length > 0) {
    return {
      ok: false,
      reason: `The ${noun} was edited after this change (${changed.join(", ")}). Fix it by hand.`,
    };
  }
  return { ok: true, patch: input.undo };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return a === b;
}

/** The page's filter tabs, in order. */
export const EMAIL_UPDATE_TABS = [
  { key: "proposed", label: "Waiting on you", statuses: ["proposed"] },
  { key: "applied", label: "Applied", statuses: ["applied", "approved"] },
  { key: "closed", label: "Rejected or undone", statuses: ["rejected", "undone"] },
] as const;

/**
 * What an applied row stores in undo_data. The sweep writes the same shape
 * when it applies a change itself, so undo works the same either way.
 */
export type UndoData =
  | { table: "schedule_tasks"; applied: TaskPatch; restore: TaskPatch }
  /** A sub's COI or W-9 status, or an AFP's notes or paid status. */
  | {
      table: "subcontractors" | "pay_applications";
      applied: Record<string, unknown>;
      restore: Record<string, unknown>;
    }
  /** A sub bill the sweep entered from email. Undo removes it. */
  | { table: "sub_pay_apps"; id: string };

export function readUndoData(v: unknown): UndoData | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.table === "sub_pay_apps") {
    return typeof o.id === "string" && o.id ? { table: "sub_pay_apps", id: o.id } : null;
  }
  if (o.table !== "schedule_tasks" && o.table !== "subcontractors" && o.table !== "pay_applications") {
    return null;
  }
  if (!o.applied || typeof o.applied !== "object") return null;
  if (!o.restore || typeof o.restore !== "object") return null;
  return o as unknown as UndoData;
}

/**
 * Whether a sub bill entered from email can still be taken back out. Only
 * while nobody has acted on it: once the CM has recommended it or it has been
 * decided, removing it would erase that work, so it is rejected in Sub billing
 * instead.
 */
export function planUndoPayApp(
  app: { status: string } | null,
): { ok: true } | { ok: false; reason: string } {
  if (!app) return { ok: false, reason: "The bill is already gone." };
  if (app.status === "received" || app.status === "under_review") return { ok: true };
  return {
    ok: false,
    reason: "The bill has been recommended or decided since. Reject it in Sub billing instead.",
  };
}

// ---------------------------------------------------------------------------
// Records other than schedule tasks: a sub's COI and W-9, an AFP.
// ---------------------------------------------------------------------------

export type SubCompliance = {
  id: string;
  project_id: string | null;
  company_name: string;
  coi_status: string | null;
  w9_status: string | null;
};

export type AfpRecord = {
  id: string;
  project_id: string;
  app_number: string;
  status: string | null;
  paid_at: string | null;
  notes: string | null;
  amount_due: number | null;
};

export type RecordPlan =
  | {
      ok: true;
      table: "subcontractors" | "pay_applications";
      id: string;
      patch: Record<string, unknown>;
      undo: Record<string, unknown>;
      /** Billing entries on the AFP follow its status, as they do in the app. */
      cascadeEntryStatus?: string;
    }
  | { ok: false; reason: string };

/** A COI or W-9 that already counts as on file. */
const ON_FILE = new Set(["received", "waived", "approved", "current"]);

/**
 * Mark a sub's COI or W-9 received. Only from a status that means it is
 * missing or lapsing; one already on file is left alone. Approval stays a
 * person's call in the Subs screen.
 */
export function planComplianceApply(
  row: { project_id: string; payload: unknown },
  sub: SubCompliance | null,
): RecordPlan {
  const doc = (row.payload as { doc?: string } | null)?.doc;
  if (doc !== "coi" && doc !== "w9") return { ok: false, reason: "The email did not say COI or W-9." };
  if (!sub) return { ok: false, reason: "The subcontractor is gone." };
  if (sub.project_id && sub.project_id !== row.project_id) {
    return { ok: false, reason: "That subcontractor is not on this project." };
  }
  const col = doc === "coi" ? "coi_status" : "w9_status";
  const current = (sub[col] ?? "").toLowerCase();
  if (ON_FILE.has(current)) {
    return { ok: false, reason: `${sub.company_name}'s ${doc === "coi" ? "COI" : "W-9"} is already ${current}.` };
  }
  return { ok: true, table: "subcontractors", id: sub.id, patch: { [col]: "received" }, undo: { [col]: sub[col] } };
}

/** Add an AFP status note from the owner to the AFP's notes. */
export function planAfpStatusApply(
  row: { project_id: string; payload: unknown },
  afp: AfpRecord | null,
  today: string,
): RecordPlan {
  const note = String((row.payload as { note?: string } | null)?.note ?? "").trim();
  if (!note) return { ok: false, reason: "The email gave no status to note." };
  if (!afp || afp.project_id !== row.project_id) return { ok: false, reason: "The AFP is not on this project." };
  const line = `${today} from email: ${note.slice(0, 500)}`;
  if ((afp.notes ?? "").includes(line)) return { ok: false, reason: "That note is already on the AFP." };
  const notes = afp.notes ? `${afp.notes}\n${line}` : line;
  return { ok: true, table: "pay_applications", id: afp.id, patch: { notes }, undo: { notes: afp.notes } };
}

/**
 * Mark an AFP paid on the date the email gives. Only an AFP that has gone to
 * the owner and is not already paid. Its billing entries follow, the same as
 * setting Paid on the AFP page.
 */
export function planAfpPaidApply(
  row: { project_id: string; payload: unknown },
  afp: AfpRecord | null,
  today: string,
): RecordPlan {
  const paidOn = (row.payload as { paid_on?: string } | null)?.paid_on;
  if (!isIsoDate(paidOn)) return { ok: false, reason: "The email gave no usable payment date." };
  if (paidOn > today) return { ok: false, reason: `The payment date ${paidOn} is in the future.` };
  if (!afp || afp.project_id !== row.project_id) return { ok: false, reason: "The AFP is not on this project." };
  const status = (afp.status ?? "").toLowerCase();
  if (status === "paid") return { ok: false, reason: `AFP ${afp.app_number} is already paid.` };
  if (status !== "submitted" && status !== "approved") {
    return { ok: false, reason: `AFP ${afp.app_number} is ${status || "a draft"}, not submitted to the owner.` };
  }
  return {
    ok: true,
    table: "pay_applications",
    id: afp.id,
    patch: { status: "paid", paid_at: `${paidOn}T12:00:00.000Z` },
    undo: { status: afp.status, paid_at: afp.paid_at },
    cascadeEntryStatus: "paid",
  };
}
