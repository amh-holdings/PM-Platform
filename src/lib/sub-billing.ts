// Subcontractor bill verification.
//
// Two independent passes, deliberately kept apart:
//
//   1. runBillChecks()  - arithmetic and continuity. Does the bill add up, does
//      it tie to the executed SOV, does its "from previous" column reconcile to
//      the last approved bill, is retainage right, does the invoice and the lien
//      waiver agree with the pay app. None of this needs field data, so it works
//      on the very first bill from a sub we have never had a DPR from.
//
//   2. verifyLine()     - substantiation. Does the percentage they billed match
//      what the field record says they actually did. This needs the SOV line's
//      mapping; without one the line is reported `unverifiable` rather than
//      passing by default.
//
// Pure functions, no DB. The caller loads rows and hands them in.

import { estimateTaskProgress, type Confidence, type TaskLike } from "@/lib/progress";

// ------------------------------- tolerances -------------------------------

// A G703 can round two defensible ways: sum the per-line rounded retainage, or
// apply the rate to the period total. On Pyramid's app 1 those differ by $0.01.
// Both are correct, so rounding-class checks get a nickel of slack.
export const ROUNDING_TOLERANCE = 0.05;

// Continuity checks (this month's "from previous" vs last month's "to date")
// have no rounding defence. They must tie exactly.
export const EXACT_TOLERANCE = 0.005;

// A line is flagged when billing runs ahead of verified progress by more than
// BOTH of these. Percentage alone over-flags small lines; dollars alone
// under-flags large ones.
export const VARIANCE_PCT_THRESHOLD = 0.05;
export const VARIANCE_DOLLAR_THRESHOLD = 2500;

// --------------------------------- types ---------------------------------

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type CheckSeverity = "error" | "warning" | "info";

export type BillCheck = {
  key: string;
  label: string;
  severity: CheckSeverity;
  status: CheckStatus;
  expected?: number | null;
  actual?: number | null;
  delta?: number | null;
  message: string;
  lineItemNumber?: string | null;
};

export type SovLine = {
  id: string;
  item_number: string;
  description: string;
  scheduled_value: number | null;
  quantity?: number | null;
  unit?: string | null;
  verification_method: string;
  linked_task_wbs_codes: string[] | null;
  linked_commodity_ids: string[] | null;
  milestone_task_wbs_code?: string | null;
  mapping_notes?: string | null;
};

export type BillLine = {
  item_number: string;
  description: string;
  scheduled_value: number | null;
  from_previous: number | null;
  this_period: number | null;
  materials_stored: number | null;
  total_completed: number | null;
  pct_billed: number | null;
  balance_to_finish: number | null;
  retainage_amount: number | null;
};

export type BillHeader = {
  app_number: number;
  period_start: string | null;
  period_end: string;
  retainage_pct: number | null;
  payment_terms_days: number | null;
  invoice_total: number | null;
  billed_previous: number | null;
  billed_this_period: number | null;
  billed_to_date: number | null;
  retainage_this_period: number | null;
  retainage_to_date: number | null;
  amount_due: number | null;
  lien_waiver_received: boolean | null;
  lien_waiver_amount: number | null;
  lien_waiver_through_date: string | null;
};

export type PriorBill = {
  app_number: number;
  period_end: string;
  billed_to_date: number | null;
  approved_this_period: number | null;
  status: string;
  lines: { item_number: string; total_completed: number | null }[];
  /**
   * Cumulative approved-to-date per item across every prior application that
   * counts as history. This, not the as-billed total, is what the next bill's
   * previous column must open from. Optional so callers that have not been
   * updated fall back to the old as-billed comparison rather than breaking.
   */
  approvedByItem?: Map<string, number>;
  /** Sum of approvedByItem, for the header-level carry-forward check. */
  approvedToDate?: number | null;
};

export type SubContext = {
  company_name: string;
  contract_value: number | null;
  retainage_pct: number | null;
  payment_terms: string | null;
  payment_terms_days: number | null;
  coi_status: string | null;
  w9_status: string | null;
};

// -------------------------------- helpers --------------------------------

const n = (v: number | null | undefined) => Number(v ?? 0);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const round2 = (v: number) => Math.round(v * 100) / 100;
const money = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * Cumulative approved-to-date per SOV item, across a set of prior applications.
 *
 * This is what the next bill's "from previous" column must be seeded with.
 * Seeding it from the as-billed total instead lets anything AHC disallowed
 * become payable on the following bill: approve $60,000 against a $100,000
 * request and the sub's next application legitimately opens at $100,000
 * previously billed, every arithmetic check passes, and the $40,000 is
 * conceded without anyone deciding to concede it.
 *
 * Two deliberate details:
 *
 *   - A line with no recorded decision (approved_this_period null) falls back
 *     to the amount billed. Absent a decision nothing has been disallowed, and
 *     reading silence as a zero would understate the baseline and re-open work
 *     the sub has already been paid for.
 *   - Stored material carries forward as billed. It is not what the CM
 *     percentage-verifies, so it has no approved figure of its own; dropping it
 *     would let the sub re-bill material that has already been paid.
 *
 * Rejected applications are excluded by the caller, not here - see the history
 * split in recordSubBill.
 */
export function approvedToDateByItem(
  priorLines: Array<{
    item_number: string;
    this_period: number | null;
    materials_stored?: number | null;
    approved_this_period?: number | null;
  }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of priorLines) {
    const work =
      l.approved_this_period != null ? n(l.approved_this_period) : n(l.this_period);
    const carried = work + n(l.materials_stored);
    out.set(l.item_number, round2((out.get(l.item_number) ?? 0) + carried));
  }
  return out;
}

// How much of a multi-task line a given task represents. Planned duration
// first, then the date span, then an equal share when the schedule says
// nothing at all.
function taskWeight(t: TaskLike & { duration_days?: number | null }): number {
  const d = Number(t.duration_days ?? 0);
  if (Number.isFinite(d) && d > 0) return d;
  if (t.start_date && t.end_date) {
    const span =
      (Date.parse(t.end_date) - Date.parse(t.start_date)) / 86_400_000 + 1;
    if (Number.isFinite(span) && span > 0) return span;
  }
  return 1;
}

function check(
  key: string,
  label: string,
  severity: CheckSeverity,
  status: CheckStatus,
  message: string,
  nums?: { expected?: number; actual?: number; lineItemNumber?: string },
): BillCheck {
  const expected = nums?.expected;
  const actual = nums?.actual;
  return {
    key,
    label,
    severity,
    status,
    message,
    expected: expected ?? null,
    actual: actual ?? null,
    delta:
      expected != null && actual != null
        ? Math.round((actual - expected) * 100) / 100
        : null,
    lineItemNumber: nums?.lineItemNumber ?? null,
  };
}

// --------------------------- pass 1: the math ----------------------------

export function runBillChecks(args: {
  header: BillHeader;
  lines: BillLine[];
  sovLines: SovLine[];
  sub: SubContext;
  prior?: PriorBill | null;
}): BillCheck[] {
  const { header, lines, sovLines, sub, prior } = args;
  const out: BillCheck[] = [];
  const rate = n(header.retainage_pct) / 100;

  // --- The SOV on the bill must be the SOV we signed. ---
  const sovTotal = sovLines.reduce((s, l) => s + n(l.scheduled_value), 0);
  const billSovTotal = lines.reduce((s, l) => s + n(l.scheduled_value), 0);
  out.push(
    near(billSovTotal, sovTotal, ROUNDING_TOLERANCE)
      ? check("sov_total", "Bill SOV ties to executed SOV", "error", "pass",
          `Scheduled value column totals ${money(billSovTotal)}, matching the executed SOV.`,
          { expected: sovTotal, actual: billSovTotal })
      : check("sov_total", "Bill SOV ties to executed SOV", "error", "fail",
          `Scheduled value column totals ${money(billSovTotal)} but the executed SOV is ${money(sovTotal)}. Difference ${money(billSovTotal - sovTotal)}.`,
          { expected: sovTotal, actual: billSovTotal }),
  );

  if (sub.contract_value != null) {
    out.push(
      near(sovTotal, n(sub.contract_value), ROUNDING_TOLERANCE)
        ? check("contract_total", "Executed SOV ties to contract value", "warning", "pass",
            `SOV totals ${money(sovTotal)}, matching the recorded contract value.`,
            { expected: n(sub.contract_value), actual: sovTotal })
        : check("contract_total", "Executed SOV ties to contract value", "warning", "warn",
            `SOV totals ${money(sovTotal)} against a recorded contract value of ${money(n(sub.contract_value))}. Check for a change order not yet entered.`,
            { expected: n(sub.contract_value), actual: sovTotal }),
    );
  }

  // --- Per-line scheduled values must match line for line, not just in total. ---
  const sovByItem = new Map(sovLines.map((l) => [l.item_number, l]));
  for (const line of lines) {
    const sov = sovByItem.get(line.item_number);
    if (!sov) {
      out.push(
        check("line_not_in_sov", "Line exists on the executed SOV", "error", "fail",
          `Line ${line.item_number} "${line.description}" is not on the executed SOV. If this is change order work it needs an approved CO first.`,
          { actual: n(line.this_period), lineItemNumber: line.item_number }),
      );
      continue;
    }
    if (!near(n(line.scheduled_value), n(sov.scheduled_value), ROUNDING_TOLERANCE)) {
      out.push(
        check("line_sov_value", "Line scheduled value matches SOV", "error", "fail",
          `Line ${line.item_number} shows a scheduled value of ${money(n(line.scheduled_value))}; the executed SOV says ${money(n(sov.scheduled_value))}.`,
          { expected: n(sov.scheduled_value), actual: n(line.scheduled_value), lineItemNumber: line.item_number }),
      );
    }
  }

  // --- Column arithmetic, line by line. ---
  for (const line of lines) {
    const sv = n(line.scheduled_value);
    const expectedTotal =
      n(line.from_previous) + n(line.this_period) + n(line.materials_stored);
    if (!near(n(line.total_completed), expectedTotal, ROUNDING_TOLERANCE)) {
      out.push(
        check("line_total_math", "Completed to date = previous + this period", "error", "fail",
          `Line ${line.item_number}: ${money(n(line.from_previous))} previous + ${money(n(line.this_period))} this period should be ${money(expectedTotal)}, the bill shows ${money(n(line.total_completed))}.`,
          { expected: expectedTotal, actual: n(line.total_completed), lineItemNumber: line.item_number }),
      );
    }

    if (sv > 0 && line.pct_billed != null) {
      const expectedPct = n(line.total_completed) / sv;
      if (Math.abs(n(line.pct_billed) - expectedPct) > 0.0005) {
        out.push(
          check("line_pct_math", "Percent complete matches the dollars", "error", "fail",
            `Line ${line.item_number} shows ${(n(line.pct_billed) * 100).toFixed(2)}% but ${money(n(line.total_completed))} of ${money(sv)} is ${(expectedPct * 100).toFixed(2)}%.`,
            { expected: expectedPct, actual: n(line.pct_billed), lineItemNumber: line.item_number }),
        );
      }
    }

    if (line.balance_to_finish != null) {
      const expectedBal = sv - n(line.total_completed);
      if (!near(n(line.balance_to_finish), expectedBal, ROUNDING_TOLERANCE)) {
        out.push(
          check("line_balance_math", "Balance to finish = scheduled less completed", "error", "fail",
            `Line ${line.item_number}: balance to finish should be ${money(expectedBal)}, the bill shows ${money(n(line.balance_to_finish))}.`,
            { expected: expectedBal, actual: n(line.balance_to_finish), lineItemNumber: line.item_number }),
        );
      }
    }

    // Nobody may bill past their own line value.
    if (n(line.total_completed) - sv > ROUNDING_TOLERANCE) {
      out.push(
        check("line_overbilled", "Line not billed past its scheduled value", "error", "fail",
          `Line ${line.item_number} is billed to ${money(n(line.total_completed))} against a scheduled value of ${money(sv)}, an overbilling of ${money(n(line.total_completed) - sv)}.`,
          { expected: sv, actual: n(line.total_completed), lineItemNumber: line.item_number }),
      );
    }

    // Retainage per line, on cumulative completed work.
    if (rate > 0) {
      const expectedRet = n(line.total_completed) * rate;
      if (!near(n(line.retainage_amount), expectedRet, ROUNDING_TOLERANCE)) {
        out.push(
          check("line_retainage", "Line retainage at the contract rate", "warning", "warn",
            `Line ${line.item_number}: ${(rate * 100).toFixed(2)}% of ${money(n(line.total_completed))} is ${money(expectedRet)}, the bill shows ${money(n(line.retainage_amount))}.`,
            { expected: expectedRet, actual: n(line.retainage_amount), lineItemNumber: line.item_number }),
        );
      }
    }
  }

  // --- Column totals. ---
  const sumThis = lines.reduce((s, l) => s + n(l.this_period), 0);
  const sumPrev = lines.reduce((s, l) => s + n(l.from_previous), 0);
  const sumToDate = lines.reduce((s, l) => s + n(l.total_completed), 0);
  const sumRet = lines.reduce((s, l) => s + n(l.retainage_amount), 0);

  out.push(
    near(sumThis, n(header.billed_this_period), ROUNDING_TOLERANCE)
      ? check("total_this_period", "Line items sum to the period total", "error", "pass",
          `Lines total ${money(sumThis)} for the period.`,
          { expected: sumThis, actual: n(header.billed_this_period) })
      : check("total_this_period", "Line items sum to the period total", "error", "fail",
          `Lines total ${money(sumThis)} but the bill claims ${money(n(header.billed_this_period))}.`,
          { expected: sumThis, actual: n(header.billed_this_period) }),
  );

  out.push(
    near(sumPrev, n(header.billed_previous), ROUNDING_TOLERANCE)
      ? check("total_previous", "Previous column sums to the header", "error", "pass",
          `Previous billings total ${money(sumPrev)}.`,
          { expected: sumPrev, actual: n(header.billed_previous) })
      : check("total_previous", "Previous column sums to the header", "error", "fail",
          `Previous column totals ${money(sumPrev)} but the header says ${money(n(header.billed_previous))}.`,
          { expected: sumPrev, actual: n(header.billed_previous) }),
  );

  out.push(
    near(sumToDate, n(header.billed_to_date), ROUNDING_TOLERANCE)
      ? check("total_to_date", "Completed-to-date column sums to the header", "error", "pass",
          `Completed to date totals ${money(sumToDate)}.`,
          { expected: sumToDate, actual: n(header.billed_to_date) })
      : check("total_to_date", "Completed-to-date column sums to the header", "error", "fail",
          `Completed-to-date column totals ${money(sumToDate)} but the header says ${money(n(header.billed_to_date))}.`,
          { expected: sumToDate, actual: n(header.billed_to_date) }),
  );

  // --- Retainage and amount due. ---
  if (rate > 0) {
    const byRate = n(header.billed_this_period) * rate;
    const retThis = n(header.retainage_this_period);
    // A G703 rounds retainage two defensible ways: apply the rate to the period
    // total, or sum the per-line rounded amounts less what was already held.
    // Pyramid's app 1 differs by $0.01 between the two. Accept either.
    const byLines = sumRet - (n(header.retainage_to_date) - retThis);
    const matches =
      near(retThis, byRate, ROUNDING_TOLERANCE) ||
      near(retThis, byLines, ROUNDING_TOLERANCE);
    out.push(
      matches
        ? check("retainage_period", "Retainage this period at the contract rate", "error", "pass",
            `${(rate * 100).toFixed(2)}% retainage on ${money(n(header.billed_this_period))} is ${money(retThis)}.`,
            { expected: byRate, actual: retThis })
        : check("retainage_period", "Retainage this period at the contract rate", "error", "fail",
            `${(rate * 100).toFixed(2)}% of ${money(n(header.billed_this_period))} is ${money(byRate)}, the bill withholds ${money(retThis)}.`,
            { expected: byRate, actual: retThis }),
    );
  }

  if (rate > 0 && header.retainage_to_date != null) {
    const expectedHeld = n(header.billed_to_date) * rate;
    out.push(
      near(n(header.retainage_to_date), expectedHeld, ROUNDING_TOLERANCE) ||
      near(n(header.retainage_to_date), sumRet, ROUNDING_TOLERANCE)
        ? check("retainage_held", "Retainage held to date at the contract rate", "warning", "pass",
            `${money(n(header.retainage_to_date))} held against ${money(n(header.billed_to_date))} billed.`,
            { expected: expectedHeld, actual: n(header.retainage_to_date) })
        : check("retainage_held", "Retainage held to date at the contract rate", "warning", "warn",
            `${(rate * 100).toFixed(2)}% of ${money(n(header.billed_to_date))} is ${money(expectedHeld)}, the bill shows ${money(n(header.retainage_to_date))} held.`,
            { expected: expectedHeld, actual: n(header.retainage_to_date) }),
    );
  }

  if (sub.retainage_pct != null) {
    out.push(
      near(n(header.retainage_pct), n(sub.retainage_pct), 0.001)
        ? check("retainage_rate", "Retainage rate matches the subcontract", "error", "pass",
            `Billed at ${n(header.retainage_pct)}%, matching the subcontract.`,
            { expected: n(sub.retainage_pct), actual: n(header.retainage_pct) })
        : check("retainage_rate", "Retainage rate matches the subcontract", "error", "fail",
            `Bill withholds ${n(header.retainage_pct)}% but the subcontract says ${n(sub.retainage_pct)}%.`,
            { expected: n(sub.retainage_pct), actual: n(header.retainage_pct) }),
    );
  }

  const expectedDue = n(header.billed_this_period) - n(header.retainage_this_period);
  out.push(
    near(n(header.amount_due), expectedDue, ROUNDING_TOLERANCE)
      ? check("amount_due", "Amount due = this period less retainage", "error", "pass",
          `Amount due ${money(n(header.amount_due))}.`,
          { expected: expectedDue, actual: n(header.amount_due) })
      : check("amount_due", "Amount due = this period less retainage", "error", "fail",
          `${money(n(header.billed_this_period))} less ${money(n(header.retainage_this_period))} retainage is ${money(expectedDue)}, the bill asks for ${money(n(header.amount_due))}.`,
          { expected: expectedDue, actual: n(header.amount_due) }),
  );

  // --- Contract ceiling. ---
  if (sub.contract_value != null) {
    const ceiling = Math.max(n(sub.contract_value), sovTotal);
    out.push(
      n(header.billed_to_date) - ceiling <= ROUNDING_TOLERANCE
        ? check("contract_ceiling", "Billed to date within the contract", "error", "pass",
            `${money(n(header.billed_to_date))} billed of ${money(ceiling)}.`,
            { expected: ceiling, actual: n(header.billed_to_date) })
        : check("contract_ceiling", "Billed to date within the contract", "error", "fail",
            `Billed to date ${money(n(header.billed_to_date))} exceeds the contract by ${money(n(header.billed_to_date) - ceiling)}.`,
            { expected: ceiling, actual: n(header.billed_to_date) }),
    );
  }

  // --- Continuity with the last approved bill. Exact, no rounding defence. ---
  if (prior) {
    out.push(
      near(n(header.billed_previous), n(prior.billed_to_date), EXACT_TOLERANCE)
        ? check("prior_continuity", "Previous billings tie to the last bill", "error", "pass",
            `Previous billings ${money(n(header.billed_previous))} tie to app ${prior.app_number}.`,
            { expected: n(prior.billed_to_date), actual: n(header.billed_previous) })
        : check("prior_continuity", "Previous billings tie to the last bill", "error", "fail",
            `This bill carries ${money(n(header.billed_previous))} as previously billed; app ${prior.app_number} ended at ${money(n(prior.billed_to_date))}. Difference ${money(n(header.billed_previous) - n(prior.billed_to_date))}.`,
            { expected: n(prior.billed_to_date), actual: n(header.billed_previous) }),
    );

    // What the sub has billed to date and what AHC has approved to date stop
    // being the same number the moment anything is disallowed. The gap is not
    // payable, and it has to be stated rather than quietly conceded on the next
    // application - which is exactly what seeding from the as-billed total did.
    if (prior.approvedToDate != null) {
      const gap = round2(n(prior.billed_to_date) - n(prior.approvedToDate));
      out.push(
        gap <= ROUNDING_TOLERANCE
          ? check("approved_carryforward", "Approved to date matches billed to date", "warning", "pass",
              `${money(n(prior.approvedToDate))} approved against ${money(n(prior.billed_to_date))} billed through app ${prior.app_number}. Nothing outstanding.`,
              { expected: n(prior.billed_to_date), actual: n(prior.approvedToDate) })
          : check("approved_carryforward", "Approved to date matches billed to date", "warning", "warn",
              `${money(gap)} of previously billed work has never been approved. This bill opens from the approved figure of ${money(n(prior.approvedToDate))}, not the ${money(n(prior.billed_to_date))} the sub has billed. Expect them to dispute the previous column.`,
              { expected: n(prior.billed_to_date), actual: n(prior.approvedToDate) }),
      );
    }

    // The previous column must open from approved-to-date. Only where no
    // approved figure was ever recorded does it fall back to as-billed.
    const priorBilledByItem = new Map(
      prior.lines.map((l) => [l.item_number, n(l.total_completed)]),
    );
    const priorApproved = prior.approvedByItem ?? null;
    for (const line of lines) {
      const expected = priorApproved
        ? priorApproved.get(line.item_number) ?? 0
        : priorBilledByItem.get(line.item_number) ?? 0;
      if (!near(n(line.from_previous), expected, EXACT_TOLERANCE)) {
        out.push(
          check("prior_line_continuity", "Line previous ties to the last bill", "error", "fail",
            priorApproved
              ? `Line ${line.item_number} carries ${money(n(line.from_previous))} as previously billed; AHC has approved ${money(expected)} on it to date.`
              : `Line ${line.item_number} carries ${money(n(line.from_previous))} as previously billed; app ${prior.app_number} left it at ${money(expected)}.`,
            { expected, actual: n(line.from_previous), lineItemNumber: line.item_number }),
        );
      }
    }

    if (header.period_start && prior.period_end && header.period_start <= prior.period_end) {
      out.push(
        check("period_overlap", "Billing period does not overlap the last one", "warning", "warn",
          `This period starts ${header.period_start} but app ${prior.app_number} ran through ${prior.period_end}.`),
      );
    }
  } else if (n(header.billed_previous) > ROUNDING_TOLERANCE) {
    out.push(
      check("prior_continuity", "Previous billings tie to the last bill", "error", "fail",
        `This bill carries ${money(n(header.billed_previous))} as previously billed but there is no prior application on record.`,
        { expected: 0, actual: n(header.billed_previous) }),
    );
  }

  // --- The invoice and the pay app are two documents saying one number. ---
  if (header.invoice_total != null) {
    out.push(
      near(n(header.invoice_total), n(header.billed_this_period), ROUNDING_TOLERANCE)
        ? check("invoice_match", "Invoice ties to the pay application", "error", "pass",
            `Invoice ${money(n(header.invoice_total))} matches the period total.`,
            { expected: n(header.billed_this_period), actual: n(header.invoice_total) })
        : check("invoice_match", "Invoice ties to the pay application", "error", "fail",
            `Invoice is ${money(n(header.invoice_total))}, the pay application bills ${money(n(header.billed_this_period))}.`,
            { expected: n(header.billed_this_period), actual: n(header.invoice_total) }),
    );
  }

  // --- Lien waiver: amount and through-date. ---
  if (!header.lien_waiver_received) {
    out.push(
      check("lien_waiver", "Conditional lien waiver received", "warning", "warn",
        "No conditional waiver and release on progress payment recorded for this application."),
    );
  } else {
    if (header.lien_waiver_amount != null) {
      out.push(
        near(n(header.lien_waiver_amount), n(header.amount_due), ROUNDING_TOLERANCE)
          ? check("lien_waiver_amount", "Waiver amount matches amount due", "error", "pass",
              `Waiver covers ${money(n(header.lien_waiver_amount))}.`,
              { expected: n(header.amount_due), actual: n(header.lien_waiver_amount) })
          : check("lien_waiver_amount", "Waiver amount matches amount due", "error", "fail",
              `Waiver names ${money(n(header.lien_waiver_amount))} but the amount due is ${money(n(header.amount_due))}. A waiver for the wrong amount does not release the lien.`,
              { expected: n(header.amount_due), actual: n(header.lien_waiver_amount) }),
      );
    }
    if (header.lien_waiver_through_date && header.lien_waiver_through_date < header.period_end) {
      out.push(
        check("lien_waiver_date", "Waiver through-date covers the period", "error", "fail",
          `Waiver runs through ${header.lien_waiver_through_date} but the billing period ends ${header.period_end}. Work in the gap stays lienable.`),
      );
    }
  }

  // --- Payment terms. Drives when the cash actually leaves. ---
  if (header.payment_terms_days != null && sub.payment_terms_days != null &&
      header.payment_terms_days !== sub.payment_terms_days) {
    out.push(
      check("payment_terms", "Payment terms match the subcontract", "warning", "warn",
        `Bill states Net ${header.payment_terms_days}; the subcontract record says Net ${sub.payment_terms_days}. Resolve before this drives the cash forecast.`,
        { expected: sub.payment_terms_days, actual: header.payment_terms_days }),
    );
  }

  // --- Compliance. Warnings, not blocks, per the agreed default. ---
  if ((sub.coi_status ?? "").toLowerCase() !== "current" &&
      (sub.coi_status ?? "").toLowerCase() !== "approved") {
    out.push(
      check("coi", "Certificate of insurance current", "warning", "warn",
        `COI status for ${sub.company_name} is "${sub.coi_status ?? "not set"}".`),
    );
  }
  if ((sub.w9_status ?? "").toLowerCase() !== "received" &&
      (sub.w9_status ?? "").toLowerCase() !== "approved") {
    out.push(
      check("w9", "W-9 on file", "warning", "warn",
        `W-9 status for ${sub.company_name} is "${sub.w9_status ?? "not set"}".`),
    );
  }

  return out;
}

// ---------------------- pass 2: field substantiation ----------------------

export type Evidence = {
  // Schedule tasks keyed by wbs_code.
  tasks: Map<
    string,
    TaskLike & { wbs_code: string; task_name?: string | null; duration_days?: number | null }
  >;
  // Commodity installed / total, keyed by commodity id.
  commodities: Map<string, { label: string; installed: number; total: number; uom: string | null }>;
  // Date of this subcontractor's earliest field report on the job, or null if
  // they have never filed one. This is the platform's record of "they hit
  // site", which is what a mobilization line is earned against.
  subOnSiteDate?: string | null;
  todayIso: string;
};

export type LineVerification = {
  verifiedPct: number | null;
  verifiedAmount: number | null;
  source: string;
  confidence: Confidence;
  detail: string;
  varianceAmount: number | null;
  variancePct: number | null;
  flag: "ok" | "review" | "flag" | "unverifiable";
};

export function verifyLine(
  sov: SovLine,
  billed: BillLine,
  ev: Evidence,
): LineVerification {
  const sv = n(billed.scheduled_value) || n(sov.scheduled_value);
  const billedPct = sv > 0 ? n(billed.total_completed) / sv : 0;
  const method = sov.verification_method;

  const unverifiable = (detail: string, source: string): LineVerification => ({
    verifiedPct: null,
    verifiedAmount: null,
    source,
    confidence: "none",
    detail,
    varianceAmount: null,
    variancePct: null,
    flag: "unverifiable",
  });

  if (method === "unmapped") {
    return unverifiable(
      "No evidence source mapped to this line. A human has to decide it.",
      "unmapped",
    );
  }
  if (method === "manual") {
    return unverifiable(
      "Mapped for manual CM sign-off. Enter the verified percent on the review screen.",
      "manual",
    );
  }

  let verifiedPct: number | null = null;
  let confidence: Confidence = "none";
  let detail = "";
  let source = method;

  if (method === "schedule" || method === "time") {
    const codes = sov.linked_task_wbs_codes ?? [];
    const found = codes.map((c) => ev.tasks.get(c)).filter(Boolean) as (TaskLike & {
      wbs_code: string;
      task_name?: string | null;
    })[];
    if (found.length === 0) {
      return unverifiable(
        `Mapped to schedule task${codes.length === 1 ? "" : "s"} ${codes.join(", ") || "(none)"} but ${codes.length ? "none were found" : "no task is set"}.`,
        method,
      );
    }
    const ests = found.map((t) => estimateTaskProgress(t, ev.todayIso));

    // Weight each task by its planned duration. A line covering a whole
    // program - "SWPPP implementation and ongoing maintenance" spans eleven
    // erosion-control tasks - should read as how much of the total work is
    // done, not as the average of eleven percentages. Averaging equally lets a
    // two-day seeding task cancel out a month of basin construction.
    //
    // Duration is a proxy for size, not for value. It is the best signal the
    // schedule carries; a line whose tasks differ wildly in cost per day is
    // better mapped to a commodity.
    const weights = found.map((t) => taskWeight(t));
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    verifiedPct =
      totalWeight > 0
        ? ests.reduce((s, e, i) => s + e.pct * weights[i], 0) / totalWeight
        : ests.reduce((s, e) => s + e.pct, 0) / ests.length;

    confidence = ests.some((e) => e.confidence === "none")
      ? "none"
      : ests.some((e) => e.confidence === "low")
        ? "low"
        : ests.some((e) => e.confidence === "medium")
          ? "medium"
          : "high";
    detail =
      found.length === 1
        ? `${found[0].wbs_code} ${found[0].task_name ?? ""} at ${(ests[0].pct * 100).toFixed(0)}% (${ests[0].source})`
        : found
            .map((t, i) => {
              const share = totalWeight > 0 ? (weights[i] / totalWeight) * 100 : 0;
              return `${t.wbs_code} ${t.task_name ?? ""} ${(ests[i].pct * 100).toFixed(0)}% (${share.toFixed(0)}% of the line)`;
            })
            .join("; ");
    source = `schedule: ${found.map((t) => t.wbs_code).join(", ")}`;
  }

  if (method === "commodity") {
    const ids = sov.linked_commodity_ids ?? [];
    const found = ids.map((id) => ev.commodities.get(id)).filter(Boolean) as {
      label: string;
      installed: number;
      total: number;
      uom: string | null;
    }[];
    if (found.length === 0) {
      return unverifiable("Mapped to commodities but none were found.", "commodity");
    }
    // Percent-unit commodities are not a ratio. Per src/lib/commodities.ts they
    // carry a DAILY percent (0-100) summed over the job, against a nominal
    // total_quantity of 1 - so "60.02" means 60.02% complete, not 6002%.
    // Treating them like a quantity ratio was wrong in both directions: the raw
    // division read 6002%, and clamping to the total read a false 100%.
    const isPct = (c: { uom: string | null }) =>
      c.uom === "pct" || c.uom === "%";
    const fraction = (c: { installed: number; total: number; uom: string | null }) =>
      isPct(c)
        ? Math.min(1, c.installed / 100)
        : c.total > 0
          ? Math.min(1, c.installed / c.total)
          : 0;

    // Weighting by planned quantity only means something when every commodity on
    // the line is measured the same way. Across mixed units (feet against each
    // against percent) the weights are not comparable, so those average equally.
    const sameUnit =
      found.every((c) => !isPct(c)) &&
      new Set(found.map((c) => c.uom)).size === 1;
    const totalQty = found.reduce((s, c) => s + (c.total || 0), 0);
    verifiedPct =
      sameUnit && totalQty > 0
        ? found.reduce((s, c) => s + Math.min(c.installed, c.total), 0) / totalQty
        : found.reduce((s, c) => s + fraction(c), 0) / found.length;

    confidence = found.every((c) => c.installed > 0) ? "high" : "medium";
    detail = found
      .map((c) =>
        isPct(c)
          ? `${c.label}: ${c.installed.toFixed(2)}% reported to date`
          : `${c.label}: ${c.installed} of ${c.total} ${c.uom ?? ""}`.trim(),
      )
      .join("; ");
    source = `commodity: ${found.map((c) => c.label).join(", ")}`;
  }

  if (method === "on_site") {
    // Mobilization: fully earned the day the crew arrives, nothing before.
    const arrived = ev.subOnSiteDate != null && ev.subOnSiteDate <= ev.todayIso;
    verifiedPct = arrived ? 1 : 0;
    confidence = "high";
    detail = arrived
      ? `Crew on site since ${ev.subOnSiteDate} (first field report). Mobilization fully earned.`
      : "No field report from this subcontractor on or before the period end, so nothing shows them on site yet.";
    source = "on site (first field report)";
  }

  if (method === "milestone") {
    const code = sov.milestone_task_wbs_code;
    const task = code ? ev.tasks.get(code) : undefined;
    if (!task) {
      return unverifiable(
        `Milestone-triggered on task ${code ?? "(none set)"} which was not found.`,
        "milestone",
      );
    }
    const status = (task.status ?? "").toLowerCase();
    const done = status === "complete" || status === "approved" ||
      Number(task.pct_complete ?? 0) >= 100;
    verifiedPct = done ? 1 : 0;
    confidence = "high";
    detail = `Milestone task ${code} is ${task.status ?? "unknown"}. ${done ? "Line is fully earned." : "Line is not yet earned."}`;
    source = `milestone: ${code}`;
  }

  if (verifiedPct == null) {
    return unverifiable("Could not compute a verified percentage.", source);
  }

  const verifiedAmount = Math.round(verifiedPct * sv * 100) / 100;
  const varianceAmount = Math.round((n(billed.total_completed) - verifiedAmount) * 100) / 100;
  const variancePct = billedPct - verifiedPct;

  // Overbilling is what matters. Underbilling is noted but never flagged.
  const overPct = variancePct > VARIANCE_PCT_THRESHOLD;
  const overDollars = varianceAmount > VARIANCE_DOLLAR_THRESHOLD;
  const flag: LineVerification["flag"] =
    overPct && overDollars ? "flag" : overPct || overDollars ? "review" : "ok";

  return {
    verifiedPct,
    verifiedAmount,
    source,
    confidence,
    detail,
    varianceAmount,
    variancePct,
    flag,
  };
}

// ------------------------- next-bill projection --------------------------
//
// What we expect the sub to bill next: the value their evidence will support
// at the end of the coming period, less what they have already been paid for.

export type ProjectedLine = {
  itemNumber: string;
  description: string;
  scheduledValue: number;
  billedToDate: number;
  projectedPctAtPeriodEnd: number | null;
  projectedToDate: number | null;
  projectedThisPeriod: number;
  basis: string;
  confidence: Confidence;
};

export function projectNextBill(args: {
  sovLines: SovLine[];
  billedToDateByItem: Map<string, number>;
  evidenceAtPeriodEnd: Evidence;
  retainagePct: number;
}): { lines: ProjectedLine[]; grossTotal: number; retainage: number; netDue: number } {
  const { sovLines, billedToDateByItem, evidenceAtPeriodEnd, retainagePct } = args;

  const lines: ProjectedLine[] = sovLines.map((sov) => {
    const sv = n(sov.scheduled_value);
    const billedToDate = billedToDateByItem.get(sov.item_number) ?? 0;
    const stub: BillLine = {
      item_number: sov.item_number,
      description: sov.description,
      scheduled_value: sv,
      from_previous: billedToDate,
      this_period: 0,
      materials_stored: 0,
      total_completed: billedToDate,
      pct_billed: sv > 0 ? billedToDate / sv : 0,
      balance_to_finish: sv - billedToDate,
      retainage_amount: 0,
    };
    const v = verifyLine(sov, stub, evidenceAtPeriodEnd);

    if (v.verifiedPct == null) {
      return {
        itemNumber: sov.item_number,
        description: sov.description,
        scheduledValue: sv,
        billedToDate,
        projectedPctAtPeriodEnd: null,
        projectedToDate: null,
        projectedThisPeriod: 0,
        basis: v.detail,
        confidence: "none" as Confidence,
      };
    }

    const projectedToDate = Math.round(v.verifiedPct * sv * 100) / 100;
    // A sub cannot un-bill. The projection floors at what they already have.
    const projectedThisPeriod = Math.max(0, projectedToDate - billedToDate);

    return {
      itemNumber: sov.item_number,
      description: sov.description,
      scheduledValue: sv,
      billedToDate,
      projectedPctAtPeriodEnd: v.verifiedPct,
      projectedToDate,
      projectedThisPeriod,
      basis: v.detail || v.source,
      confidence: v.confidence,
    };
  });

  const grossTotal = Math.round(lines.reduce((s, l) => s + l.projectedThisPeriod, 0) * 100) / 100;
  const retainage = Math.round(grossTotal * (retainagePct / 100) * 100) / 100;
  return {
    lines,
    grossTotal,
    retainage,
    netDue: Math.round((grossTotal - retainage) * 100) / 100,
  };
}

// -------------------------------- rollups --------------------------------

export function summarizeChecks(checks: BillCheck[]) {
  return {
    failures: checks.filter((c) => c.status === "fail").length,
    warnings: checks.filter((c) => c.status === "warn").length,
    passed: checks.filter((c) => c.status === "pass").length,
    hardFail: checks.some((c) => c.status === "fail" && c.severity === "error"),
  };
}

export function summarizeVerification(lines: { flag_level: string | null }[]) {
  return {
    flagged: lines.filter((l) => l.flag_level === "flag").length,
    review: lines.filter((l) => l.flag_level === "review").length,
    unverifiable: lines.filter((l) => l.flag_level === "unverifiable").length,
    ok: lines.filter((l) => l.flag_level === "ok").length,
  };
}
