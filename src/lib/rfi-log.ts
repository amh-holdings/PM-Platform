// The RFI log: whose desk a question is on, and how long it has been there.
//
// Subs raise RFIs, we forward them to the engineer of record, the EOR answers,
// we pass the answer back. Three parties, and at every step the question is in
// somebody else's hands. An email thread cannot answer "what is sitting with
// Exactus right now", which is the only question anybody asks of a log.
//
// There is no status field. A status is something a person has to remember to
// change; a date is something they record when the thing happens. The
// subcontractors table shows how the other way ends - coi_status reads
// "pending" on nearly every sub because nothing ever forced it to agree with
// reality. Here the state falls out of which dates are filled in, so it cannot
// disagree with the record.

export type RfiRow = {
  id: string;
  rfi_number: string;
  subject: string;
  question: string;
  discipline: string | null;
  wbs_code: string | null;
  subcontractor_id: string | null;
  raised_by: string | null;
  eor_firm: string | null;
  eor_contact: string | null;
  received_at: string;
  sent_to_eor_at: string | null;
  answered_at: string | null;
  closed_at: string | null;
  response_needed_by: string | null;
  answer: string | null;
  cost_impact: boolean;
  schedule_impact: boolean;
  reference_doc: string | null;
  suggested_answer: string | null;
  location: string | null;
  priority: string;
};

/**
 * closed     the sub has the answer, nothing outstanding
 * answered   the EOR came back, we have not passed it on
 * with_eor   forwarded, waiting on the engineer
 * with_us    the sub sent it, we have not forwarded it
 */
export type RfiState = "with_us" | "with_eor" | "answered" | "closed";

export const RFI_STATE_LABEL: Record<RfiState, string> = {
  with_us: "With us",
  with_eor: "With EOR",
  answered: "Answered",
  closed: "Closed",
};

/** Who has to do the next thing. The log's whole reason for existing. */
export const RFI_BALL_IN_COURT: Record<RfiState, string> = {
  with_us: "Forward to the EOR",
  with_eor: "Waiting on the EOR",
  answered: "Pass the answer back",
  closed: "Nothing outstanding",
};

export function rfiState(rfi: Pick<RfiRow, "sent_to_eor_at" | "answered_at" | "closed_at">): RfiState {
  // Read backwards from the end, so a row whose earlier dates were never
  // filled in still lands on its real state. An RFI answered by phone and
  // recorded afterwards has an answer date and no sent date, and calling that
  // "with us" would put it back on the to-do list.
  if (rfi.closed_at) return "closed";
  if (rfi.answered_at) return "answered";
  if (rfi.sent_to_eor_at) return "with_eor";
  return "with_us";
}

/** Whole days from `from` to `to`, negative once `to` is past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Days the question has been alive: received until answered, or until today
 * while it is still open.
 *
 * Measured to ANSWERED, not to closed. The EOR's turnaround is the number
 * worth reporting, and our own delay in passing it on should not flatter it.
 */
export function daysOpen(rfi: Pick<RfiRow, "received_at" | "answered_at">, today: string): number {
  return Math.max(0, daysBetween(rfi.received_at, rfi.answered_at ?? today));
}

/** Days the EOR has held it. Null until it was sent. */
export function daysWithEor(
  rfi: Pick<RfiRow, "sent_to_eor_at" | "answered_at">,
  today: string,
): number | null {
  if (!rfi.sent_to_eor_at) return null;
  return Math.max(0, daysBetween(rfi.sent_to_eor_at, rfi.answered_at ?? today));
}

/**
 * Past the date we said we needed it by, and still unanswered.
 *
 * An RFI that came back late is not overdue any more - it is late, which is a
 * fact about the past. Overdue means somebody has to chase it today.
 */
export function isOverdue(
  rfi: Pick<RfiRow, "response_needed_by" | "answered_at" | "closed_at">,
  today: string,
): boolean {
  if (!rfi.response_needed_by) return false;
  if (rfi.answered_at || rfi.closed_at) return false;
  return daysBetween(today, rfi.response_needed_by) < 0;
}

/** Answered, but after the date we needed it. Reported, not chased. */
export function wasLate(
  rfi: Pick<RfiRow, "response_needed_by" | "answered_at">,
): boolean {
  if (!rfi.response_needed_by || !rfi.answered_at) return false;
  return daysBetween(rfi.answered_at, rfi.response_needed_by) < 0;
}

/**
 * The next number in the project's series.
 *
 * Reads the numeric tail of whatever is already there, so RFI-007 and
 * SUS-RFI-007 both count as seven and the next one follows the house style
 * rather than resetting it. A log whose numbers are all words falls back to
 * the count, which is at least never a duplicate.
 */
export function nextRfiNumber(existing: readonly string[], prefix = "RFI-"): string {
  let highest = 0;
  let pad = 3;
  let seenPrefix: string | null = null;
  for (const raw of existing) {
    const m = /^(.*?)(\d+)\s*$/.exec(raw.trim());
    if (!m) continue;
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    if (n >= highest) {
      highest = n;
      pad = Math.max(pad, m[2].length);
      seenPrefix = m[1];
    }
  }
  const head = seenPrefix ?? prefix;
  return `${head}${String(highest + 1).padStart(pad, "0")}`;
}

export type RfiSummary = {
  open: number;
  withUs: number;
  withEor: number;
  answered: number;
  overdue: number;
  closed: number;
};

export function summarise(rfis: readonly RfiRow[], today: string): RfiSummary {
  const s: RfiSummary = {
    open: 0,
    withUs: 0,
    withEor: 0,
    answered: 0,
    overdue: 0,
    closed: 0,
  };
  for (const r of rfis) {
    const state = rfiState(r);
    if (state === "closed") {
      s.closed++;
      continue;
    }
    s.open++;
    if (state === "with_us") s.withUs++;
    if (state === "with_eor") s.withEor++;
    if (state === "answered") s.answered++;
    if (isOverdue(r, today)) s.overdue++;
  }
  return s;
}

/**
 * Overdue first, then our own work, then what we are waiting on.
 *
 * Overdue above everything, because that is the list somebody works from in
 * the morning. Then the two states where WE are the holdup - one to forward,
 * one to pass back - because those are the ones that get dropped. Waiting on
 * the engineer comes after: it is a chase, not a task.
 *
 * Within a state the one that has been waiting longest leads. A log sorted by
 * number buries the question nobody has answered since August.
 */
const STATE_RANK: Record<RfiState, number> = {
  with_us: 0,
  answered: 1,
  with_eor: 2,
  closed: 3,
};

export function compareRfis(a: RfiRow, b: RfiRow, today: string): number {
  const ao = isOverdue(a, today);
  const bo = isOverdue(b, today);
  if (ao !== bo) return ao ? -1 : 1;

  const ar = STATE_RANK[rfiState(a)];
  const br = STATE_RANK[rfiState(b)];
  if (ar !== br) return ar - br;

  // High before Normal before Low, inside a state. Anything the log does not
  // recognise sorts as Normal rather than to one end.
  const rank = (p: string) => (p === "High" ? 0 : p === "Low" ? 2 : 1);
  const ap = rank(a.priority);
  const bp = rank(b.priority);
  if (ap !== bp) return ap - bp;

  if (a.received_at !== b.received_at) {
    return a.received_at < b.received_at ? -1 : 1;
  }
  return a.rfi_number.localeCompare(b.rfi_number, undefined, { numeric: true });
}

export function sortRfis(rfis: readonly RfiRow[], today: string): RfiRow[] {
  return [...rfis].sort((a, b) => compareRfis(a, b, today));
}

// ---------------------------------------------------------------------------
// The legacy column names
// ---------------------------------------------------------------------------
//
// The rfis table has been in the schema since the first migration and already
// carries `response`, `date_needed` and `date_answered`. 0084 adds received_at,
// sent_to_eor_at and closed_at beside them, which leaves one table speaking two
// naming conventions.
//
// Rather than spread that through the app, it is translated once here. The
// logic above uses one vocabulary; the legacy names live only at this edge.

export type RfiDbRow = {
  id: string;
  rfi_number: string | null;
  subject: string | null;
  question: string;
  discipline: string | null;
  wbs_code: string | null;
  subcontractor_id: string | null;
  raised_by: string | null;
  eor_firm: string | null;
  eor_contact: string | null;
  received_at: string | null;
  sent_to_eor_at: string | null;
  date_answered: string | null;
  closed_at: string | null;
  date_needed: string | null;
  date_issued?: string | null;
  response: string | null;
  cost_impact: boolean | null;
  schedule_impact: boolean | null;
  reference_doc: string | null;
  suggested_answer: string | null;
  location: string | null;
  priority: string | null;
};

export function toRfiRow(db: RfiDbRow): RfiRow {
  return {
    id: db.id,
    // A skeleton row from before the log existed can have neither a number nor
    // a subject. Blank is honest; inventing one would make two rows look alike.
    rfi_number: db.rfi_number ?? "",
    subject: db.subject ?? "",
    question: db.question,
    discipline: db.discipline,
    wbs_code: db.wbs_code,
    subcontractor_id: db.subcontractor_id,
    raised_by: db.raised_by,
    eor_firm: db.eor_firm,
    eor_contact: db.eor_contact,
    // 0084 backfills received_at from date_issued, but a row written between
    // the deploy and the migration would have neither.
    received_at: db.received_at ?? db.date_issued ?? "",
    sent_to_eor_at: db.sent_to_eor_at,
    answered_at: db.date_answered,
    closed_at: db.closed_at,
    response_needed_by: db.date_needed,
    answer: db.response,
    cost_impact: db.cost_impact ?? false,
    schedule_impact: db.schedule_impact ?? false,
    reference_doc: db.reference_doc,
    suggested_answer: db.suggested_answer,
    location: db.location,
    // A row written before the column existed has no priority. Normal, not
    // High: a log where everything is urgent sorts no better than one where
    // nothing is.
    priority: db.priority ?? "Normal",
  };
}

/**
 * The legacy `status` column, computed from the dates.
 *
 * Nothing in the log reads it. The project dashboard does - it has counted
 * open RFIs out of this column since long before the log existed - so every
 * save writes it from the derived state and it stays a cache, never a source.
 */
export function legacyStatus(state: RfiState): "open" | "answered" | "closed" {
  if (state === "closed") return "closed";
  if (state === "answered") return "answered";
  return "open";
}
