// Smart progress estimation for schedule_tasks.
//
// Combines every signal available - explicit DPR-set pct_complete, status
// label, past-due heuristic, schedule date interpolation - into a single
// estimate with a confidence level so the UI can shade "we know this" vs
// "we're guessing." Pure function, no DB dependencies.

export type ProgressSource =
  | "pct_complete"      // DPR set the % directly - highest signal
  | "status"            // status text mapped to %
  | "past_due"          // end_date passed, status isn't Complete -> probably 75%
  | "date_interpolation"// linear pct from start_date/end_date and today
  | "no_signal";        // can't say anything

export type Confidence = "high" | "medium" | "low" | "none";

export type ProgressEstimate = {
  pct: number;
  confidence: Confidence;
  source: ProgressSource;
  reason: string;
};

const STATUS_PCT: Record<string, number> = {
  Complete: 1.0,
  Approved: 1.0,
  "In Progress": 0.5,
  "Not Started": 0,
  Planned: 0,
};

const STATUS_CONFIDENCE: Record<string, Confidence> = {
  Complete: "high",
  Approved: "high",
  "In Progress": "medium",
  "Not Started": "high",
  Planned: "medium",
};

export type TaskLike = {
  status?: string | null;
  pct_complete?: number | null | string;
  start_date?: string | null;
  end_date?: string | null;
};

export function estimateTaskProgress(
  task: TaskLike,
  todayIso: string,
): ProgressEstimate {
  // 1. Explicit pct_complete from DPR or manual entry.
  if (task.pct_complete != null && Number.isFinite(Number(task.pct_complete))) {
    const pct = Math.max(0, Math.min(1, Number(task.pct_complete) / 100));
    return {
      pct,
      confidence: "high",
      source: "pct_complete",
      reason: `Reported at ${Math.round(pct * 100)}% (DPR or manual entry)`,
    };
  }

  // 2. Status label mapping.
  if (task.status && STATUS_PCT[task.status] != null) {
    const pct = STATUS_PCT[task.status];
    return {
      pct,
      confidence: STATUS_CONFIDENCE[task.status] ?? "medium",
      source: "status",
      reason: `Status "${task.status}" maps to ${Math.round(pct * 100)}%`,
    };
  }

  // 3. Past-due fallback - end_date in the past and not marked Complete.
  if (task.end_date && task.end_date < todayIso && task.status !== "Complete") {
    return {
      pct: 0.75,
      confidence: "medium",
      source: "past_due",
      reason: `End date ${task.end_date} passed without Complete status - assuming 75%`,
    };
  }

  // 4. Linear date interpolation (lowest confidence: pure schedule math).
  if (task.start_date && task.end_date) {
    const start = Date.parse(task.start_date);
    const end = Date.parse(task.end_date);
    const today = Date.parse(todayIso);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return {
        pct: 0,
        confidence: "none",
        source: "no_signal",
        reason: "Could not parse schedule dates",
      };
    }
    if (end <= start) {
      if (today >= end) {
        return {
          pct: 1.0,
          confidence: "low",
          source: "date_interpolation",
          reason: "Zero-duration task with end date in the past - assuming complete",
        };
      }
      return {
        pct: 0,
        confidence: "low",
        source: "date_interpolation",
        reason: "Zero-duration task hasn't reached end date",
      };
    }
    if (today <= start) {
      return {
        pct: 0,
        confidence: "low",
        source: "date_interpolation",
        reason: `Start date ${task.start_date} hasn't arrived`,
      };
    }
    if (today >= end) {
      return {
        pct: 1.0,
        confidence: "low",
        source: "date_interpolation",
        reason: `End date ${task.end_date} has passed - schedule says complete`,
      };
    }
    const pct = (today - start) / (end - start);
    return {
      pct,
      confidence: "low",
      source: "date_interpolation",
      reason: `${Math.round(pct * 100)}% of the way through ${task.start_date} - ${task.end_date} window`,
    };
  }

  // 5. No signal.
  return {
    pct: 0,
    confidence: "none",
    source: "no_signal",
    reason: "No progress signal: no dates, no status, no pct_complete",
  };
}

// Aggregate confidence across N tasks linked to a single billing line.
// "high" only if ALL high. Any "none" or "low" drops the whole aggregate.
export function aggregateConfidence(items: Confidence[]): Confidence {
  if (items.length === 0) return "none";
  if (items.some((c) => c === "none")) return "none";
  if (items.some((c) => c === "low")) return "low";
  if (items.some((c) => c === "medium")) return "medium";
  return "high";
}

// Detect whether a billing_line is procurement-scope. Procurement billing is
// triggered by PO submission, not by schedule date math, so the suggestion
// engine treats these lines specially.
export function isProcurementLine(line: {
  type?: string | null;
  description?: string | null;
}): boolean {
  if (!line) return false;
  const t = (line.type ?? "").toLowerCase();
  const d = (line.description ?? "").toLowerCase();
  if (t === "procurement") return true;
  // LNTP rows that are equipment procurement (Tracker/Racking Procurement,
  // Pile Procurement, Transformer Procurement, etc.) - typed LNTP but
  // described as procurement.
  if (d.includes("procurement")) return true;
  return false;
}

// Progress signal for procurement-scope billing lines. The signal is the
// total value of SIGNED + non-cancelled procurement_orders compared to the
// billing line's scheduled value. Drafts and unsigned POs don't count -
// they're speculative scope, not committed scope.
export type ProcurementMilestone = {
  milestone_name?: string | null;
  amount?: number | null;
  pct_of_total?: number | null;
  /** Free text from the PO, e.g. "PO release - Net 30", "Delivery to site". */
  trigger_event?: string | null;
  paid_at?: string | null;
};

export type LinkedPo = {
  po_number?: string | null;
  vendor_name?: string | null;
  total_value?: number | null;
  status?: string | null;
  signed_at?: string | null;
  actual_delivery_date?: string | null;
  milestones?: ProcurementMilestone[];
};

/**
 * Whether a PO payment milestone has actually been triggered.
 *
 * Triggers are free text off the PO, so this reads intent rather than matching
 * an enum. The three shapes on Sweet Springs are "PO release - Net 30",
 * "Delivery to site - Net 30" and "Commissioning complete - Net 30".
 * Anything unrecognised is treated as NOT triggered - an unbillable milestone
 * that should have billed is a conversation, one that bills early is a credit
 * the owner claws back.
 */
export function milestoneTriggered(
  m: ProcurementMilestone,
  po: LinkedPo,
): { fired: boolean; why: string } {
  if (m.paid_at) return { fired: true, why: "already paid" };
  const t = (m.trigger_event ?? m.milestone_name ?? "").toLowerCase();
  const signed = !!po.signed_at && po.status !== "cancelled";
  const delivered = !!po.actual_delivery_date;

  if (/commission/.test(t)) {
    return { fired: false, why: "awaiting commissioning" };
  }
  if (/deliver/.test(t)) {
    return delivered
      ? { fired: true, why: `delivered ${po.actual_delivery_date}` }
      : { fired: false, why: "awaiting delivery to site" };
  }
  if (/po release|deposit|down|mob/.test(t)) {
    return signed
      ? { fired: true, why: `PO signed ${po.signed_at?.slice(0, 10)}` }
      : { fired: false, why: "PO not signed" };
  }
  return { fired: false, why: `trigger "${m.trigger_event ?? "unset"}" not recognised` };
}

/**
 * Progress on a procurement SOV line, from the payment milestones that have
 * actually been triggered.
 *
 * This used to count any SIGNED PO at its FULL value. On Sweet Springs SOV 5.05
 * that read 86% - $144,902 of signed POs - and offered to bill roughly $65,700
 * in August for equipment not due on site until November. Signing a PO is a
 * commitment, not earned value: on a G702 it is neither column D (work
 * completed) nor column E (materials presently stored).
 *
 * The PO payment terms already say what is earned and when. GroundWork is 100%
 * on delivery; Power Factors is 40% deposit / 30% delivery / 30% commissioning.
 * Only the deposits have triggered, which is $38,775 rather than $144,902.
 *
 * A PO with no milestones recorded contributes nothing and says so, rather than
 * silently falling back to its full value.
 */
export function estimateProcurementProgress(
  line: { scheduled_value?: number | null },
  linkedPos: LinkedPo[],
): ProgressEstimate & { earnedValue: number; detail: string[] } {
  const scheduledValue = Number(line.scheduled_value ?? 0);
  const live = linkedPos.filter((p) => p.status !== "cancelled");

  if (live.length === 0) {
    return {
      pct: 0, confidence: "high", source: "no_signal", earnedValue: 0, detail: [],
      reason: "No procurement order linked - link and sign a PO to bill this scope",
    };
  }
  if (scheduledValue <= 0) {
    return {
      pct: 0, confidence: "low", source: "no_signal", earnedValue: 0, detail: [],
      reason: "Billing line has no scheduled value",
    };
  }

  let earned = 0;
  const detail: string[] = [];
  let missingTerms = 0;

  for (const po of live) {
    const label = po.po_number ?? po.vendor_name ?? "PO";
    const ms = po.milestones ?? [];
    if (ms.length === 0) {
      missingTerms++;
      detail.push(`${label}: no payment milestones recorded - contributes $0`);
      continue;
    }
    for (const m of ms) {
      const amount =
        Number(m.amount ?? 0) > 0
          ? Number(m.amount)
          : (Number(m.pct_of_total ?? 0) / 100) * Number(po.total_value ?? 0);
      const { fired, why } = milestoneTriggered(m, po);
      if (fired) earned += amount;
      detail.push(
        `${label} ${m.milestone_name ?? "milestone"}: ${fired ? "EARNED" : "not earned"} $${Math.round(amount).toLocaleString("en-US")} (${why})`,
      );
    }
  }

  if (earned <= 0) {
    return {
      pct: 0, confidence: "high", source: "no_signal", earnedValue: 0, detail,
      reason:
        missingTerms === live.length
          ? `${live.length} PO(s) linked but none has payment milestones recorded - add the payment terms to bill this scope`
          : "No payment milestone has been triggered yet - nothing earned on this scope",
    };
  }

  const pct = Math.min(1, earned / scheduledValue);
  return {
    pct,
    confidence: "high",
    source: "pct_complete",
    earnedValue: earned,
    detail,
    reason: `$${Math.round(earned).toLocaleString("en-US")} of triggered payment milestones against scope $${scheduledValue.toLocaleString("en-US")} = ${Math.round(pct * 100)}%`,
  };
}


/**
 * Rolls several leaf-task percents into one SOV-line percent, weighted by
 * scheduled duration.
 *
 * An unweighted mean makes the recommendation depend on how many tasks happen
 * to be linked rather than on what was built. On Sweet Springs SOV 6.03, the
 * same August field evidence produced $133,260, $75,507 or $17,753 depending
 * only on whether the not-yet-started fencing and ESC tasks were in the list.
 * Weighting by duration_days makes a 15-day fencing task count five times a
 * 3-day one, so adding scope that has not started lowers the percent by the
 * right amount instead of by an arbitrary one.
 *
 * Tasks with no duration_days (7 of 30 on Sweet Springs) take the mean duration
 * of the tasks on the same line that do have one, so they neither dominate nor
 * vanish. If none of them do, every weight is 1 and this degrades to the plain
 * mean.
 */
export function durationWeightedPct(
  items: Array<{ pct: number; durationDays: number | null }>,
): { pct: number; weightedByDuration: boolean; unweightedPct: number } {
  const unweightedPct =
    items.length === 0
      ? 0
      : items.reduce((s, i) => s + i.pct, 0) / items.length;
  if (items.length === 0) {
    return { pct: 0, weightedByDuration: false, unweightedPct: 0 };
  }

  const known = items
    .map((i) => i.durationDays)
    .filter((d): d is number => d != null && Number.isFinite(d) && d > 0);
  if (known.length === 0) {
    return { pct: unweightedPct, weightedByDuration: false, unweightedPct };
  }

  const fallback = known.reduce((s, d) => s + d, 0) / known.length;
  let num = 0;
  let den = 0;
  for (const i of items) {
    const w =
      i.durationDays != null && Number.isFinite(i.durationDays) && i.durationDays > 0
        ? i.durationDays
        : fallback;
    num += i.pct * w;
    den += w;
  }
  return {
    pct: den > 0 ? num / den : unweightedPct,
    weightedByDuration: true,
    unweightedPct,
  };
}
