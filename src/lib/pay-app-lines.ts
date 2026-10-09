// Building the G703 lines for one pay application.
//
// Lifted out of pay-app-actions.ts for the same reason billing-progress.ts was:
// a document that goes to the owner should be reproducible without a database,
// so it can be replayed against an application already issued and proved to
// still come out the same.
//
// WHY SCOPE IS NOT scheduled_value
// A change order does one of two things on this contract. Most of them get
// their own SOV line and the owner bills them there - Sweet Springs CO-01,
// CO-04, CO-05 and CO-06 are lines 13.00 through 16.00 on the executed G703.
// One of them, CO-02, was spread across the work lines it delayed, and the
// owner's sheet carries the RAISED line values with no CO-02 row at all.
// billing_lines still holds the pre-CO-02 figure, so Mobilization reads
// $100,000 against $320,762.92 of billing. The allocations in
// billing_line_amendments are what reconcile the two, and a G703 built off
// scheduled_value instead of scope prints a sheet the owner cannot tie out.

import {
  effectiveLineProgress,
  type AmendmentRow,
  type SovLine,
} from "@/lib/sov-amendments";

/** Statuses that mean money actually went out. Mirrors billing-progress.ts. */
const BILLED_STATUSES = new Set(["on_pay_app", "submitted", "approved", "paid"]);

export type PayAppBillingLine = {
  id: string;
  item_number: string;
  description: string;
  scheduled_value: number | null;
  sort_order: number | null;
  /** Set on a line a change order brought in. Null on a contract line. */
  change_order_id?: string | null;
  /** The contract holds no retainage on this line (0071). */
  retainage_exempt?: boolean | null;
};

export type PayAppEntry = {
  id: string;
  billing_line_id: string;
  period_month: string;
  actual_amount: number | null;
  planned_amount: number | null;
  pay_application_id: string | null;
  status: string | null;
  afp_number: string | null;
};

/**
 * A prior-month row carrying only a planned amount and no billing evidence.
 * Excluded from previous billings and surfaced rather than swallowed.
 */
export type StalePriorForecast = {
  itemNumber: string;
  periodMonth: string;
  plannedAmount: number;
  status: string;
};

export type PayAppLineSnapshot = {
  billing_line_id: string;
  item_number: string;
  description: string;
  scheduled_value: number;
  work_completed_previous: number;
  work_completed_this_period: number;
  materials_stored: number;
  total_completed_and_stored: number;
  pct_complete: number;
  balance_to_finish: number;
  retainage_amount: number;
  sort_order: number;
};

export type BuildPayAppLinesInput = {
  lines: PayAppBillingLine[];
  entries: PayAppEntry[];
  amendments: AmendmentRow[];
  periodStart: string;
  periodEnd: string;
  retainagePct: number;
  /** Restrict which in-window entries roll in. Null means all of them. */
  onlyEntryIds?: string[] | null;
  /**
   * Replaying an application that already exists: its entries carry its id, so
   * without this they would all read as previously billed. Null when creating.
   */
  forAppId?: string | null;
};

export type BuildPayAppLinesResult =
  | {
      ok: true;
      lines: PayAppLineSnapshot[];
      /** Entry ids that rolled into this period, for stamping. */
      thisPeriodEntryIds: string[];
      stalePriorForecasts: StalePriorForecast[];
      totals: {
        total_completed: number;
        total_retainage: number;
        previous_billings: number;
        amount_due: number;
        scheduled_value: number;
      };
    }
  | { ok: false; error: string };

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function hasBillingEvidence(e: PayAppEntry): boolean {
  return (
    !!e.pay_application_id || !!e.afp_number || BILLED_STATUSES.has(e.status ?? "")
  );
}

export function buildPayAppLines(
  input: BuildPayAppLinesInput,
): BuildPayAppLinesResult {
  const {
    lines,
    entries,
    amendments,
    periodStart,
    periodEnd,
    retainagePct,
    onlyEntryIds,
    forAppId,
  } = input;

  // Scope only. The money on each line is bucketed from the entries below,
  // because the snapshot needs per-entry ids to stamp and a previous/this
  // period split that effectiveLineProgress does not produce. Mixing the two
  // is what makes a line read 226% complete, so the guard further down refuses
  // outright whenever an allocated-away line carries billing of its own - the
  // only case where the money would have had to move with the scope.
  const sovLines: SovLine[] = lines.map((l) => ({
    id: l.id,
    itemNumber: l.item_number,
    description: l.description,
    scheduledValue: Number(l.scheduled_value ?? 0),
    changeOrderId: l.change_order_id ?? null,
  }));
  const rollups = effectiveLineProgress(sovLines, amendments);

  type Bucket = {
    previous: number;
    thisPeriodIds: string[];
    thisPeriodAmount: number;
    /** Any entry at all on this line, billed or not. */
    entryCount: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const l of lines) {
    buckets.set(l.id, {
      previous: 0,
      thisPeriodIds: [],
      thisPeriodAmount: 0,
      entryCount: 0,
    });
  }

  const filterSet =
    onlyEntryIds && onlyEntryIds.length > 0 ? new Set(onlyEntryIds) : null;
  const stalePriorForecasts: StalePriorForecast[] = [];
  const lineById = new Map(lines.map((l) => [l.id, l]));

  for (const e of entries) {
    const b = buckets.get(e.billing_line_id);
    if (!b) continue;
    b.entryCount += 1;
    const actual = Number(e.actual_amount ?? 0);
    const planned = Number(e.planned_amount ?? 0);
    const amount = actual > 0 ? actual : planned;

    const inWindow = e.period_month >= periodStart && e.period_month <= periodEnd;
    // Unstamped, or stamped to the very application being replayed.
    const freeForThisApp =
      !e.pay_application_id ||
      (!!forAppId && e.pay_application_id === forAppId);
    const selectedForThisApp =
      inWindow && freeForThisApp && (!filterSet || filterSet.has(e.id));

    if (selectedForThisApp) {
      if (amount > 0) {
        b.thisPeriodIds.push(e.id);
        b.thisPeriodAmount += amount;
      }
      continue;
    }

    const isPrior = !!e.pay_application_id || e.period_month < periodStart;
    if (!isPrior) continue;
    if (amount <= 0) continue;
    if (hasBillingEvidence(e)) {
      b.previous += amount;
    } else {
      stalePriorForecasts.push({
        itemNumber: lineById.get(e.billing_line_id)?.item_number ?? "",
        periodMonth: e.period_month,
        plannedAmount: amount,
        status: e.status ?? "forecast",
      });
    }
  }

  const out: PayAppLineSnapshot[] = [];
  const thisPeriodEntryIds: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const b = buckets.get(l.id)!;
    const r = rollups.get(l.id)!;
    const scope = round2(r.scope);
    const allocatedAway = round2(r.allocatedAway);

    if (allocatedAway > 0 && Math.abs(scope) < 0.005) {
      // Fully spread into other lines. The owner's sheet has no row for it -
      // CO-02 on Sweet Springs is exactly this - so printing it would add a
      // line the G703 does not carry.
      if (b.entryCount > 0) {
        return {
          ok: false,
          error:
            `${l.item_number} is fully allocated to other contract lines but carries ` +
            `${b.entryCount} billing entr${b.entryCount === 1 ? "y" : "ies"} of its own. ` +
            `Either the allocation is wrong or the billing belongs on the lines it was spread into. ` +
            `Resolve it before issuing an application.`,
        };
      }
      continue;
    }

    const completed = round2(b.previous + b.thisPeriodAmount);
    const pct = scope > 0 ? Math.min(100, (completed / scope) * 100) : 0;
    thisPeriodEntryIds.push(...b.thisPeriodIds);
    out.push({
      billing_line_id: l.id,
      item_number: l.item_number,
      description: l.description,
      scheduled_value: scope,
      work_completed_previous: round2(b.previous),
      work_completed_this_period: round2(b.thisPeriodAmount),
      materials_stored: 0,
      total_completed_and_stored: completed,
      pct_complete: Math.round(pct * 100) / 100,
      balance_to_finish: round2(scope - completed),
      retainage_amount: l.retainage_exempt
        ? 0
        : round2(b.thisPeriodAmount * (retainagePct / 100)),
      sort_order: l.sort_order ?? i,
    });
  }

  const sum = (pick: (l: PayAppLineSnapshot) => number) =>
    round2(out.reduce((s, l) => s + pick(l), 0));
  const total_completed = sum((l) => l.work_completed_this_period);
  const total_retainage = sum((l) => l.retainage_amount);

  return {
    ok: true,
    lines: out,
    thisPeriodEntryIds,
    stalePriorForecasts,
    totals: {
      total_completed,
      total_retainage,
      previous_billings: sum((l) => l.work_completed_previous),
      amount_due: round2(total_completed - total_retainage),
      scheduled_value: sum((l) => l.scheduled_value),
    },
  };
}
