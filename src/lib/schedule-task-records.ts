// Everything the platform already knows about one schedule task.
//
// The schedule has always been able to tell you a task is 65% complete and on
// the critical path. It has never been able to show you WHY. The evidence
// exists - an approved inspection pinned to that task, carrying the
// photographs the CM accepted it on - and every one of those records has
// pointed at `schedule_task_id` since the inspections table was built. Nothing
// in the app has ever read them back from the schedule side, so substantiating
// a billed percent meant walking the Inspections tab by hand.
//
// This module is the pure half of fixing that: the shapes, the derivations and
// the counting. The loading and the signed-URL minting live in
// schedule-task-records-load.ts, because they need the server.
//
// Deliberately NOT here: anything that writes. A task's progress still comes
// only from an approved field report and its dates only from the edit dialog
// and the CPM. This is a reading surface, and a reading surface that can write
// is how a careful rule gets quietly bypassed.

import { parsePredecessors, type RelType } from "@/lib/schedule-cpm";
// Numeric per-segment WBS ordering, so 5.1.2.10 sorts after 5.1.2.2. Already
// here and already tested - a third copy of it (weekly-report.ts has the
// second) is how two of them quietly start disagreeing.
import { compareWbs } from "@/lib/schedule-edit";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * One photograph, from whichever of the three photo tables it came out of.
 *
 * `source` is kept because provenance is the whole point. An inspection photo
 * was accepted by the CM as proof of the percent; a field-report photo was
 * filed the same day but was never the thing anyone approved. Showing them in
 * one gallery without saying which is which would turn evidence into
 * decoration.
 */
export type TaskPhotoSource = "inspection" | "field_report";

export type TaskPhoto = {
  id: string;
  /** Short-lived signed URL. Both buckets are private. */
  url: string | null;
  caption: string | null;
  takenAt: string | null;
  source: TaskPhotoSource;
  /** The record it arrived with, named, so the gallery tile can say so. */
  sourceLabel: string;
  /** Where to go to see it in context. */
  href: string | null;
};

/** An approved inspection pinned to this task. */
export type TaskEvidence = {
  id: string;
  title: string;
  inspectionType: string | null;
  status: string;
  submittedAt: string | null;
  decidedAt: string | null;
  /** Report date of the DPR it came in on, which is the date that counts. */
  reportDate: string | null;
  quantity: number | null;
  unitOfMeasure: string | null;
  /** The percent this inspection pinned, as approved. */
  pinnedPct: number | null;
  notes: string | null;
  decisionNotes: string | null;
  photos: TaskPhoto[];
  href: string;
};

/** One field-report pin on this task, movement or not. */
export type TaskPin = {
  id: string;
  reportDate: string | null;
  previousPct: number | null;
  newPct: number | null;
  previousStatus: string | null;
  newStatus: string | null;
  notes: string | null;
  /** False when the percent did not go up. */
  moved: boolean;
  href: string;
};

export type TaskDocument = {
  /** The link row, which is what gets detached. */
  linkId: string;
  documentId: string;
  fileName: string;
  category: string;
  description: string | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
  note: string | null;
};

/** A predecessor or successor, named. */
export type TaskLink = {
  wbsCode: string;
  taskName: string;
  type: RelType;
  lag: number;
  /** True when the code does not resolve to a task on this project. */
  dangling: boolean;
};

export type TaskConstraintRow = {
  id: string;
  category: string | null;
  title: string;
  owner: string | null;
  needBy: string | null;
  status: string;
  clearedAt: string | null;
  resolution: string | null;
};

export type TaskPoDelivery = {
  id: string;
  poNumber: string | null;
  vendor: string | null;
  description: string | null;
  promisedDate: string | null;
  deliveredDate: string | null;
  href: string;
};

export type TaskRecords = {
  taskId: string;
  wbsCode: string;
  evidence: TaskEvidence[];
  pins: TaskPin[];
  photos: TaskPhoto[];
  documents: TaskDocument[];
  predecessors: TaskLink[];
  successors: TaskLink[];
  constraints: TaskConstraintRow[];
  deliveries: TaskPoDelivery[];
  /**
   * Why a section is empty, when the reason is a rule rather than an absence.
   * A construction task with no evidence is waiting for a report; a permit
   * never had one to wait for. "Nothing here" is a worse answer than either.
   */
  notes: {
    documentsEnabled: boolean;
  };
};

/**
 * What the grid shows on a row before anything is opened.
 *
 * One aggregate query at page load fills these for the whole schedule. The
 * alternative - a count per row - is 288 round trips on Sweet Springs for a
 * badge, which is how a read-only feature makes a page slower than the thing
 * it was meant to illuminate.
 */
export type TaskRecordCounts = {
  photos: number;
  documents: number;
  evidence: number;
};

export const EMPTY_COUNTS: TaskRecordCounts = { photos: 0, documents: 0, evidence: 0 };

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

type NamedTask = { wbs_code: string; task_name: string; predecessors?: string | null };

/**
 * What this task drives.
 *
 * The schedule stores logic in one direction only: a task names what it comes
 * after. So the grid can show you that Build Basin 1 follows the grubbing, and
 * cannot show you that Full Site Clearing and Basin 1 Final Grading are both
 * waiting on Build Basin 1. That second list is the one that matters in a
 * meeting - it is the answer to "what happens if this slips" - and it has to
 * be derived by reading every other task's predecessors.
 *
 * Case and whitespace are normalised the same way parsePredecessors does, so a
 * link typed as "5.1.2.2 ss" still resolves.
 */
export function successorsOf(wbsCode: string, tasks: NamedTask[]): TaskLink[] {
  const target = wbsCode.trim().toUpperCase();
  const out: TaskLink[] = [];

  for (const t of tasks) {
    if (t.wbs_code.trim().toUpperCase() === target) continue;
    for (const link of parsePredecessors(t.predecessors ?? null)) {
      if (link.pred.trim().toUpperCase() !== target) continue;
      out.push({
        wbsCode: t.wbs_code,
        taskName: t.task_name,
        type: link.type,
        lag: link.lag,
        dangling: false,
      });
    }
  }

  return out.sort((a, b) => compareWbs(a.wbsCode, b.wbsCode));
}

/**
 * What this task waits on, with each code resolved to a name.
 *
 * A predecessor that does not resolve is reported rather than dropped. The CPM
 * silently discards a link it cannot resolve, which frees the successor to
 * start on day one - a schedule that reads fine and forecasts nonsense. This
 * is the one surface that can say so on the row itself.
 */
export function predecessorsOf(
  predecessors: string | null | undefined,
  tasks: NamedTask[],
): TaskLink[] {
  const byCode = new Map<string, NamedTask>();
  for (const t of tasks) byCode.set(t.wbs_code.trim().toUpperCase(), t);

  return parsePredecessors(predecessors ?? null).map((link) => {
    const hit = byCode.get(link.pred.trim().toUpperCase());
    return {
      wbsCode: link.pred,
      taskName: hit?.task_name ?? "Not a task on this project",
      type: link.type,
      lag: link.lag,
      dangling: !hit,
    };
  });
}

/**
 * Whether a pin actually moved the number.
 *
 * Measured against the highest percent reported so far rather than the
 * previous report, matching summarizeProgressHistory: 95 then 25 (a typo) then
 * 95 is not progress on the third day. A task reported almost daily that never
 * moves is the quieter half of the billing problem in BACKLOG.md - Debris
 * Removal was reported from 20 Aug to 16 Sep and read 10% every time - and the
 * only way to see it is a list of pins where the ones that moved are marked.
 */
export function markMovement(
  pins: Array<{ reportDate: string | null; newPct: number | null }>,
): boolean[] {
  const order = pins
    .map((p, i) => ({ i, d: p.reportDate ?? "" }))
    .sort((a, b) => a.d.localeCompare(b.d));

  const moved = new Array<boolean>(pins.length).fill(false);
  let high = 0;
  for (const { i } of order) {
    const pct = Number(pins[i].newPct ?? 0);
    if (pct > high) {
      high = pct;
      moved[i] = true;
    }
  }
  return moved;
}

/**
 * How many days since this task last had an approved report, as of the data
 * date rather than as of now.
 *
 * Every other calculation on the schedule is as of the data date, and a
 * staleness figure that follows the wall clock would disagree with the float
 * beside it for no reason a reader could work out.
 */
export function daysSinceReport(
  lastReportDate: string | null | undefined,
  dataDate: string,
): number | null {
  if (!lastReportDate) return null;
  const then = Date.parse(`${lastReportDate}T00:00:00Z`);
  const now = Date.parse(`${dataDate}T00:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return null;
  return Math.round((now - then) / 86_400_000);
}

export const STALE_REPORT_DAYS = 7;

/**
 * The one line worth putting at the top of the popup, or null for nothing.
 *
 * Ordered by what would change somebody's afternoon. A task nothing drives and
 * nothing waits on is a structural fault that outranks a stale report, because
 * the stale report at least concerns work somebody is tracking.
 */
export function taskRecordsAlert(input: {
  taskType: string | null | undefined;
  status: string | null | undefined;
  isSummary: boolean;
  predecessorCount: number;
  successorCount: number;
  lastReportDate: string | null | undefined;
  dataDate: string;
  openConstraints: number;
  critical: boolean;
}): { tone: "bad" | "warn"; text: string } | null {
  if (
    !input.isSummary &&
    input.predecessorCount === 0 &&
    input.successorCount === 0
  ) {
    return {
      tone: "bad",
      text:
        "Nothing drives this task and nothing waits on it, so it is kept off " +
        "the critical path and out of the project finish date. A slip here " +
        "moves nothing and nothing moves it.",
    };
  }

  if (input.openConstraints > 0) {
    return {
      tone: "warn",
      text:
        `${input.openConstraints} open constraint` +
        `${input.openConstraints === 1 ? "" : "s"} on this task. ` +
        "It is not ready to start until they are cleared.",
    };
  }

  const stale = daysSinceReport(input.lastReportDate, input.dataDate);
  const inProgress = (input.status ?? "").trim() === "In Progress";
  if (
    !input.isSummary &&
    (input.taskType ?? "") === "construction" &&
    inProgress &&
    stale !== null &&
    stale > STALE_REPORT_DAYS
  ) {
    return {
      tone: "warn",
      text:
        `${stale} days since the last approved report. The percent here ` +
        `cannot move until the next one is approved` +
        (input.critical ? ", and this task is on the critical path." : "."),
    };
  }

  // In progress and never reported at all. Distinct from stale: there is no
  // last report to be old. This is the shape the AFP 12 under-billing took -
  // work underway on a task still reading Not Started with pct_complete null.
  if (
    !input.isSummary &&
    (input.taskType ?? "") === "construction" &&
    inProgress &&
    stale === null
  ) {
    return {
      tone: "warn",
      text:
        "Under way with no approved report on the task, so it is contributing " +
        "nothing to a pay application. Either a report is missing or the " +
        "status is ahead of the work.",
    };
  }

  return null;
}

/**
 * Why the Evidence section is empty, said in terms of the rule that made it so.
 *
 * Returns null when there IS evidence, so the caller can treat a string as
 * "render this instead of the list".
 */
export function emptyEvidenceReason(input: {
  evidenceCount: number;
  taskType: string | null | undefined;
  isSummary: boolean;
}): string | null {
  if (input.evidenceCount > 0) return null;

  if (input.isSummary) {
    return (
      "A summary row has no evidence of its own. Its percent is rolled up " +
      "from the leaves below it, and the photographs sit on those."
    );
  }

  const type = (input.taskType ?? "").trim();
  if (type === "construction") {
    return (
      "No approved inspection on this task. Construction progress can only " +
      "come from an approved field report, so this row cannot move until a " +
      "sub files one and it is approved."
    );
  }
  if (type === "procurement") {
    return (
      "A procurement row is not measured in the field, so no inspection will " +
      "ever cover it. It is done when the equipment is delivered - see the " +
      "purchase order below."
    );
  }
  if (type === "deliverable" || type === "inspection") {
    return (
      `A ${type === "inspection" ? "third-party inspection" : "deliverable"} ` +
      "is not measured in the field. Its evidence is the document attached " +
      "to it, not a field report."
    );
  }
  return (
    "No approved inspection on this task, and no Type set - so the app " +
    "cannot say whether one is expected. Set Type on the row and this " +
    "section will say what it is waiting for."
  );
}

/** Sum of the two things the row badge shows, for the "is there anything" test. */
export function hasRecords(c: TaskRecordCounts | undefined): boolean {
  if (!c) return false;
  return c.photos > 0 || c.documents > 0 || c.evidence > 0;
}

/** Row badge tooltip. Built here so the grid and the popup cannot disagree. */
export function describeRecordCounts(c: TaskRecordCounts | undefined): string {
  if (!hasRecords(c)) return "No photos or documents on this task";
  const parts: string[] = [];
  if (c!.photos) parts.push(`${c!.photos} photo${c!.photos === 1 ? "" : "s"}`);
  if (c!.documents) parts.push(`${c!.documents} document${c!.documents === 1 ? "" : "s"}`);
  if (c!.evidence) {
    parts.push(`${c!.evidence} approved inspection${c!.evidence === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}
