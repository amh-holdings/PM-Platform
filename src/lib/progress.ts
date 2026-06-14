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
// total value of linked procurement_orders compared to the billing line's
// scheduled value. When no PO is linked, return 0 (no PO = no billing).
export function estimateProcurementProgress(
  line: { scheduled_value?: number | null },
  linkedPos: { total_value?: number | null; status?: string | null }[],
): ProgressEstimate {
  const activePos = linkedPos.filter((p) => p.status !== "cancelled");
  if (activePos.length === 0) {
    return {
      pct: 0,
      confidence: "high",
      source: "no_signal",
      reason: "No active procurement order linked - submit a PO to bill this scope",
    };
  }
  const totalPoValue = activePos.reduce(
    (s, p) => s + Number(p.total_value ?? 0),
    0,
  );
  const scheduledValue = Number(line.scheduled_value ?? 0);
  if (scheduledValue <= 0) {
    return {
      pct: 0,
      confidence: "low",
      source: "no_signal",
      reason: "Billing line has no scheduled value",
    };
  }
  const pct = Math.min(1, totalPoValue / scheduledValue);
  return {
    pct,
    confidence: "high",
    source: "pct_complete",
    reason: `${activePos.length} PO(s) totaling $${totalPoValue.toLocaleString("en-US")} against scope $${scheduledValue.toLocaleString("en-US")} = ${Math.round(pct * 100)}% covered`,
  };
}
