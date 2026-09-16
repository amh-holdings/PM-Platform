// Sanity checks run against a work pin before the CM decides it.
//
// The approval gate used to ask one question: did the CM attach his own photo?
// That catches work that was never done. It does not catch work that was done
// and filed against the wrong row, which is the failure that actually reached
// the schedule and the pay application.
//
// Sweet Springs, 2026-09-09 to 09-15: four approved reports whose narrative
// said "cut and fill on basin one" wrote 85%, 90%, 95% and 95% onto
// 5.1.1.7.5 Embankment, which belongs to Basin 2. Basin 2 had not been started,
// its predecessor was untouched, and its embankment was not scheduled to begin
// for another twelve days. Every one of those facts was already in the database
// at the moment Mark hit approve, and none of them were put in front of him.
//
// These are warnings, never blocks. A schedule can be out of date and real work
// can legitimately run ahead of plan; the CM is the one who knows which. The
// job here is to make him look, not to decide for him.

export type SanityTask = {
  id: string;
  wbsCode: string;
  taskName: string;
  status: string | null;
  pctComplete: number | null;
  startDate: string | null;
  endDate: string | null;
  predecessors: string | null;
  parentWbsCode?: string | null;
};

export type PinSanityInput = {
  /** The percent the pin is claiming, total done to date. */
  claimedPct: number | null;
  /** The task the pin is filed against. */
  task: SanityTask;
  /** Report date (YYYY-MM-DD) the claim is being made for. */
  reportDate: string;
  /** Every task on the project, for predecessor and name-collision lookups. */
  allTasks: readonly SanityTask[];
};

export type PinWarning = {
  code: "not_yet_scheduled" | "predecessor_not_started" | "ambiguous_name" | "regression";
  /** "high" earns a red banner; "info" a muted note. */
  severity: "high" | "info";
  message: string;
};

/** How far past the report date a planned start has to be before we complain. */
const FUTURE_START_DAYS = 3;

/** Below this, a claim is too small to be worth questioning. */
const MATERIAL_PCT = 5;

function daysAfter(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((a - b) / 86_400_000);
}

function isNotStarted(t: SanityTask): boolean {
  const s = (t.status ?? "").toLowerCase();
  if (s.includes("progress") || s.includes("complete")) return false;
  return (t.pctComplete ?? 0) <= 0;
}

/**
 * Predecessor codes off the schedule's free-text field. Entries look like
 * "5.1.1.7.1", "5.1.1.6.1SS", or several comma-separated - the lag/type suffix
 * is not needed here, only which task is referenced.
 */
export function parsePredecessors(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((p) => p.trim().match(/^[\d.]+/)?.[0] ?? "")
    .map((p) => p.replace(/\.$/, ""))
    .filter(Boolean);
}

export function checkPinSanity(input: PinSanityInput): PinWarning[] {
  const { claimedPct, task, reportDate, allTasks } = input;
  const out: PinWarning[] = [];
  const material = claimedPct != null && claimedPct >= MATERIAL_PCT;

  // 1. Claiming real progress on work the schedule says has not begun. This is
  //    the check that would have stopped the Basin 2 embankment pins.
  if (material && task.startDate) {
    const lead = daysAfter(task.startDate, reportDate);
    if (lead > FUTURE_START_DAYS) {
      out.push({
        code: "not_yet_scheduled",
        severity: "high",
        message: `${task.wbsCode} ${task.taskName} is not scheduled to start until ${task.startDate}, ${lead} days after this report. Confirm this is the right activity.`,
      });
    }
  }

  // 2. Predecessors untouched. Work rarely finishes before the thing it
  //    depends on has begun.
  if (material) {
    const byCode = new Map(allTasks.map((t) => [t.wbsCode, t]));
    const blocking = parsePredecessors(task.predecessors)
      .map((c) => byCode.get(c))
      .filter((t): t is SanityTask => Boolean(t) && isNotStarted(t as SanityTask));
    if (blocking.length) {
      const names = blocking
        .map((t) => `${t.wbsCode} ${t.taskName}`)
        .join(", ");
      out.push({
        code: "predecessor_not_started",
        severity: "high",
        message: `Predecessor not started: ${names}. This item claims ${claimedPct}% while the work it follows has no reported progress.`,
      });
    }
  }

  // 3. Another pinnable task carries the identical name. Not wrong on its own,
  //    but it is the condition under which the wrong row gets picked, so the
  //    CM should read the parent before approving.
  const twins = allTasks.filter(
    (t) =>
      t.id !== task.id &&
      t.taskName.trim().toLowerCase() === task.taskName.trim().toLowerCase(),
  );
  if (twins.length) {
    const others = twins.map((t) => t.wbsCode).join(", ");
    const parent = task.parentWbsCode
      ? allTasks.find((t) => t.wbsCode === task.parentWbsCode)?.taskName ?? null
      : null;
    // Deliberately never "high". A colliding name is the CONDITION for the
    // mistake, not evidence of it, and on Sweet Springs it is true of a
    // correctly filed Embankment pin every single day. Red on work that is
    // right is how a CM learns to click past red. It states which parent the
    // pin landed under and lets the two date/predecessor checks above carry
    // the actual alarm.
    out.push({
      code: "ambiguous_name",
      severity: "info",
      message: parent
        ? `"${task.taskName}" also exists at ${others}. This pin is filed under ${parent} (${task.wbsCode}).`
        : `"${task.taskName}" also exists at ${others}. Confirm ${task.wbsCode} is the right one.`,
    });
  }

  // 4. The claim is below what the schedule already carries. applyPinProgress
  //    ToSchedule ratchets, so approving this silently changes nothing - the CM
  //    should know the number he sees is not the number that will land.
  if (
    claimedPct != null &&
    task.pctComplete != null &&
    claimedPct < Number(task.pctComplete)
  ) {
    out.push({
      code: "regression",
      severity: "info",
      message: `Schedule already shows ${task.pctComplete}%. Approving this will not lower it - percent only moves up from a report. Edit the task directly to correct it downward.`,
    });
  }

  return out;
}
