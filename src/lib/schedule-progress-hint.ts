// What an in-progress row should say before anyone has typed a percent.
//
// Zarina: "what's the point of the percent number bar if it only shows 100%
// when completed? How about the in progress number?"
//
// Fair. The only thing that writes the column today is progressFromStatus,
// which puts 100 on a row when its status goes Complete. So the percent
// repeats what the status already said and carries nothing in between. A
// deliverable that is half drawn shows an empty box, which reads as broken
// rather than as a question waiting for an answer.
//
// The box has always been typeable for deliverable, procurement and
// inspection rows - schedule-task-type says so, and its comment about "a lead
// time half run down" is exactly the case. Nothing on screen ever said so.
//
// So this returns a HINT, never a value. It is rendered as the input's
// placeholder: grey, obviously not entered, and gone the moment a real number
// is typed over it. Nothing stores it, nothing rolls it up, nothing bills it.
// That line matters, because schedule_tasks.pct_complete is read by the
// sub-billing verifier and the cash-flow projection, and a number the app
// invented has no business in either.
//
// The hint is calendar days elapsed against calendar days planned, which is
// the one thing the schedule actually knows about a running task. It is not
// an opinion about the work.

export type ProgressHint = { pct: number; why: string };

const DAY_MS = 86_400_000;

/** The status that means work is underway, and the only one that gets a hint. */
const UNDERWAY = "In Progress";

function parse(d: string | null | undefined): number | null {
  if (!d) return null;
  const ms = Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A grey placeholder percent for a running task, or null when the dates have
 * nothing honest to say.
 *
 * Null when:
 *   - the status is anything but In Progress. A Complete row already has its
 *     100, and a Not Started row showing "40" from dates would contradict its
 *     own hollow dot on the same line.
 *   - either date is missing or unreadable.
 *   - today is before the planned start. Nothing has begun; the hollow dot
 *     and the Start column already say it.
 *   - today is on or past the planned finish. The dates have run out, so they
 *     no longer estimate anything. A task still running past its finish is
 *     late, and guessing 95% would paper over exactly that.
 */
export function scheduleProgressHint(input: {
  status: string | null | undefined;
  start: string | null | undefined;
  end: string | null | undefined;
  today: string;
}): ProgressHint | null {
  if ((input.status ?? "").trim() !== UNDERWAY) return null;

  const start = parse(input.start);
  const end = parse(input.end);
  const today = parse(input.today);
  if (start == null || end == null || today == null) return null;
  if (end < start) return null;
  if (today < start) return null;
  if (today >= end) return null;

  const total = (end - start) / DAY_MS + 1;
  const elapsed = (today - start) / DAY_MS + 1;
  if (!(total > 0) || !(elapsed > 0)) return null;

  const pct = Math.round((elapsed / total) * 100);
  if (pct < 1 || pct > 99) return null;

  const days = Math.round(total);
  return {
    pct,
    why:
      `The schedule says day ${Math.round(elapsed)} of ${days} planned day${days === 1 ? "" : "s"}, ` +
      `so about ${pct}%. That is elapsed time, not work done - type the real percent to replace it.`,
  };
}
