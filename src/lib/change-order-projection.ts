// Change orders that are not approved yet, in the cash-flow forecast.
//
// An approved change order already reaches the forecast the long way round: it
// earns its own SOV line, the line maps to the schedule, and the money lands
// in the month that work finishes. Everything before approval reached it
// nowhere. Two drafted COs worth real money were invisible on a projection
// whose whole job is to say what is coming.
//
// Zarina: "Since it is draft, you project it for the next month. For example,
// we have 2 draft COs, assuming it will be submitted on October, then assume
// it will be billed on October for AFP14."
//
// So: the pipeline bills one month after the AFP being assembled now.

import { addMonthsIso, shiftByDaysToMonth } from "@/lib/cashflow";

/**
 * Not approved, not dead. These are the change orders expected to be billed.
 *
 * Zarina said "draft", and internal_review and submitted are here too on
 * purpose. A CO moving from draft to submitted is MORE likely to be billed,
 * not less, so dropping it from the forecast at that point would be backwards:
 * the number would fall the moment the thing got more certain.
 *
 * approved is excluded because it is already in the forecast through its SOV
 * line, and counting it here as well would book it twice. rejected and void
 * are excluded because they are not coming.
 */
export const CO_PIPELINE_STATUSES = ["draft", "internal_review", "submitted"] as const;

export function isPipelineCo(status: string | null | undefined): boolean {
  return (CO_PIPELINE_STATUSES as readonly string[]).includes((status ?? "").trim());
}

/**
 * The month a pipeline change order is assumed to be billed in.
 *
 * One month after the pay application being assembled now. The open AFP is
 * already being put together from work that is done, and a change order still
 * being drafted is not going onto it. September open means AFP 14, October.
 *
 * One rule for all three pipeline statuses. A submitted CO might in fairness
 * make the current AFP, but a forecast that moves a month every time a status
 * changes is harder to trust than one that is consistently a month cautious.
 */
export function pipelineCoBillingMonth(openPeriodMonth: string): string {
  return addMonthsIso(openPeriodMonth, 1);
}

export type PipelineCo = {
  co_number?: string | null;
  description?: string | null;
  co_value?: number | null;
  status?: string | null;
};

export type PipelineCoPlan = {
  /** Work month the revenue is recognised in. */
  month: string;
  /** Month the cash lands, after owner payment terms. */
  cashMonth: string;
  entries: {
    coNumber: string;
    status: string;
    gross: number;
    retainage: number;
    net: number;
  }[];
  totalGross: number;
  totalRetainage: number;
  totalNet: number;
};

/**
 * What the pipeline adds to the forecast, and where.
 *
 * Retainage is withheld on positive amounts only. A credit change order is
 * negative and real - it reduces revenue - but "negative retainage" is not a
 * thing anybody holds, and applying the percentage to it would quietly hand
 * back money the owner never kept.
 *
 * A zero-value CO contributes nothing and is dropped rather than carried as an
 * empty row: a time-only change order moves a completion date, not cash.
 */
export function planPipelineCoRevenue(input: {
  cos: readonly PipelineCo[];
  openPeriodMonth: string;
  /** 0 to 1, not a percentage. */
  ownerRetainagePct: number;
  ownerTermsDays: number;
}): PipelineCoPlan {
  const month = pipelineCoBillingMonth(input.openPeriodMonth);
  const cashMonth =
    input.ownerTermsDays > 0 ? shiftByDaysToMonth(month, input.ownerTermsDays) : month;

  const pct = Number.isFinite(input.ownerRetainagePct)
    ? Math.max(0, input.ownerRetainagePct)
    : 0;

  const entries: PipelineCoPlan["entries"] = [];
  for (const co of input.cos) {
    if (!isPipelineCo(co.status)) continue;
    const gross = Number(co.co_value ?? 0);
    if (!Number.isFinite(gross) || gross === 0) continue;
    const retainage = gross > 0 ? Math.round(gross * pct * 100) / 100 : 0;
    entries.push({
      coNumber: co.co_number?.trim() || "CO",
      status: (co.status ?? "").trim(),
      gross,
      retainage,
      net: Math.round((gross - retainage) * 100) / 100,
    });
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    month,
    cashMonth,
    entries,
    totalGross: round(entries.reduce((s, e) => s + e.gross, 0)),
    totalRetainage: round(entries.reduce((s, e) => s + e.retainage, 0)),
    totalNet: round(entries.reduce((s, e) => s + e.net, 0)),
  };
}

/** One line per CO for the forecast's assumptions list. */
export function describePipelineCo(
  entry: PipelineCoPlan["entries"][number],
  month: string,
): string {
  const label = entry.status === "submitted" ? "submitted" : `${entry.status.replace("_", " ")}`;
  return `${entry.coNumber} (${label}) is assumed billed in ${month.slice(0, 7)} - $${Math.round(entry.gross).toLocaleString()} is in the forecast on that assumption, not on an approval`;
}

/* ------------------------------------------------------------------ */
/* The cost side                                                       */
/* ------------------------------------------------------------------ */

// Revenue without cost is not a forecast, it is a wish.
//
// planPipelineCoRevenue books what the owner is billed for an unapproved
// change order. Nothing booked what it costs to do, so every CO in the
// pipeline landed in the curve as pure margin and "Margin at completion" read
// high by exactly the cost of the work.
//
// The cost is taken the same way the CEO report takes it, so the two cannot
// disagree: change_orders.cost_amount first, which the CO editor keeps in
// step with the buildup lines, then the estimate on the CO-numbered cost code,
// which is where costs were entered before the buildup existed.
//
// A CO with neither is not given a made-up cost. It is reported, because a
// guessed cost is worse than a named hole.
//
// It is booked in the month the revenue is, and the cash goes out that month
// too. The revenue is already resting on an assumption about when the CO is
// billed; spreading the cost on a second assumption on top of the first would
// be precision the number has not earned.

/** "CO-01" / "CO 1" / "co-1" all key the same. */
export function normalizeCoNumber(raw: string): string {
  const m = raw.match(/(\d+)/);
  return m ? `CO-${String(Number(m[1])).padStart(2, "0")}` : raw.trim().toUpperCase();
}

export type PipelineCoCostPlan = {
  /** Same month as the revenue. */
  month: string;
  entries: { coNumber: string; cost: number; source: "cost_amount" | "cost_code" }[];
  /** COs in the forecast at full value with no cost behind them. */
  uncosted: { coNumber: string; gross: number }[];
  totalCost: number;
};

export function planPipelineCoCost(input: {
  cos: readonly PipelineCo[];
  /** Estimated cost by normalized CO number, off the CO-numbered cost codes. */
  costByCoNumber: ReadonlyMap<string, number>;
  /** The month planPipelineCoRevenue put the revenue in. */
  month: string;
  /** change_orders.cost_amount by normalized CO number. */
  costAmountByCoNumber?: ReadonlyMap<string, number>;
}): PipelineCoCostPlan {
  const entries: PipelineCoCostPlan["entries"] = [];
  const uncosted: PipelineCoCostPlan["uncosted"] = [];

  for (const co of input.cos) {
    if (!isPipelineCo(co.status)) continue;
    const gross = Number(co.co_value ?? 0);
    if (!Number.isFinite(gross) || gross === 0) continue;

    const label = co.co_number?.trim() || "CO";
    const key = normalizeCoNumber(label);
    const stored = input.costAmountByCoNumber?.get(key);
    const fromCode = input.costByCoNumber.get(key);

    // A zero cost_amount is "nobody filled this in", not "this is free".
    // Treating it as a real zero is how a CO books as 100% margin in silence.
    if (stored != null && Number(stored) !== 0) {
      entries.push({ coNumber: label, cost: round2(Number(stored)), source: "cost_amount" });
      continue;
    }
    if (fromCode != null && Number(fromCode) !== 0) {
      entries.push({ coNumber: label, cost: round2(Number(fromCode)), source: "cost_code" });
      continue;
    }
    uncosted.push({ coNumber: label, gross: round2(gross) });
  }

  return {
    month: input.month,
    entries,
    uncosted,
    totalCost: round2(entries.reduce((s, e) => s + e.cost, 0)),
  };
}

/** One line per CO whose cost is in the forecast. */
export function describePipelineCoCost(
  entry: PipelineCoCostPlan["entries"][number],
  month: string,
): string {
  const from =
    entry.source === "cost_amount"
      ? "the change order's own cost"
      : "the estimate on its cost code";
  return `${entry.coNumber} costs $${Math.round(entry.cost).toLocaleString()} in ${month.slice(0, 7)}, from ${from}`;
}

/** One line per CO carrying revenue with nothing behind it. */
export function describeUncostedPipelineCo(
  entry: PipelineCoCostPlan["uncosted"][number],
): string {
  return `${entry.coNumber} is in the forecast at $${Math.round(entry.gross).toLocaleString()} of revenue with no cost recorded - margin at completion is high by whatever it costs to do`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
