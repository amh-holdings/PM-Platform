// 12-month rolling cash flow + margin projection.
//
// Pulls billing_entries, cost_forecasts, procurement_payments,
// schedule_tasks, and the project's payment-terms metadata, then projects
// every month from today out to N months ahead on BOTH bases:
//   accrual (revenue when billed, cost when incurred) - drives margin
//   cash    (when money actually moves) - drives funding decisions
//
// Rules for money that has not moved yet:
//   - Nothing unpaid lands in a month that is over. A forecast whose date has
//     passed is overdue, so it is drawn in the current month. Past months hold
//     only money with a record behind it, which is what lets cash-to-date tie
//     to the books.
//   - A sub pay app is cash: paid at paid_at, otherwise at its due date.
//   - A contract line's scope includes what change orders allocated to it
//     (billing_line_amendments), so CO-02 billed inside Mobilization is not
//     also forecast as an unbilled CO-02 line.
//
// Each row is tagged with a confidence level:
//   actual    - row has at least one paid/settled entry
//   forecast  - row has explicit billing_entries / procurement_payments
//   estimated - row was inferred from schedule progress, no entry yet
//   none      - genuinely empty (no signal of any kind)

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  addMonthsIso,
  effectiveAmount,
  firstOfMonthIso,
  monthIsoFromDate,
  monthsBetween,
  shiftByDaysToMonth,
  shortMonthLabel,
} from "@/lib/cashflow";
import { isPipelineCo } from "@/lib/change-order-projection";
import {
  describeOwnerCashMove,
  ownerCashMonth,
} from "@/lib/billing-cash-date";
import {
  describeRelease,
  fallbackReleaseMonth,
  ownerReleaseMonth,
  resolveRetainageRelease,
} from "@/lib/retainage-release";
import {
  describeSovDateGap,
  describeSovDateSource,
  resolveSovMonth,
} from "@/lib/sov-forecast-date";
import {
  describeScheduleMove,
  forecastMilestoneDate,
  type PoForecastLine,
} from "@/lib/po-payment-forecast";
import { hasBillingEvidence } from "@/lib/billing-progress";
import { effectiveLineProgress, type AmendmentRow } from "@/lib/sov-amendments";
import {
  aggregateConfidence,
  estimateTaskProgress,
  isSummaryOf,
  resolveMilestoneTask,
  type Confidence,
} from "@/lib/progress";

export type ProjectionRow = {
  month: string;
  label: string;
  // Accrual (work-month)
  revenueRecognized: number;
  subCostIncurred: number;
  vendorCostIncurred: number;
  totalCost: number;
  netMargin: number;
  cumulativeMargin: number;
  // Cash basis (cash-receipt / cash-disbursement month)
  cashIn: number;
  subCashOut: number;
  vendorCashOut: number;
  totalCashOut: number;
  /**
   * The same money split by how solid it is, because a timeline that draws a
   * forecast and an invoice identically is lying about one of them.
   *
   * Actual is money with a record behind it - a paid entry, a settled vendor
   * milestone. Forecast is everything else, including the schedule-driven
   * estimate. actual + forecast equals the total beside it.
   */
  revenueActual: number;
  revenueForecast: number;
  retainageActual: number;
  retainageForecast: number;
  cashOutActual: number;
  cashOutForecast: number;
  netCash: number;
  cumulativeCash: number;
  // Metadata
  confidence: Confidence;
  hasActualBilling: boolean;
  hasActualCost: boolean;
  isPast: boolean;     // month is before this month
  isCurrent: boolean;  // month == this month
};

export type ProjectionWarning = {
  kind:
    | "po_missing_milestones"
    | "po_payment_no_date"
    | "billing_line_no_link"
    | "task_no_dates"
    | "underbilled"
    | "overbilled"
    | "pipeline_change_order"
    | "pipeline_co_no_cost"
    | "sub_sov_no_date"
    // Retainage is in the curve, but at the month the series happens to end
    // rather than at a contractual release event.
    | "retainage_release_no_event";
  ref: string;
  message: string;
};

/**
 * Something the forecast DID account for, and had to make a call on.
 *
 * Kept apart from warnings because the warnings panel is headed "things the
 * forecast could not account for" and a vendor payment that moved because the
 * schedule moved is the opposite of that. It is the forecast working. It
 * still gets said out loud, because a number that moves on its own with no
 * explanation is how people stop trusting the curve.
 */
export type ProjectionNote = {
  kind:
    | "po_payment_from_schedule"
    | "owner_cash_from_payment"
    | "pipeline_co_cost"
    | "sov_date_from_mapping"
    // Imported cash-flow plan that the schedule now dates instead.
    | "planned_billing_reforecast"
    // Retainage dated from the contract's release event.
    | "retainage_release_from_event";
  ref: string;
  message: string;
};

export type ProjectionResult = {
  rows: ProjectionRow[];
  warnings: ProjectionWarning[];
  notes: ProjectionNote[];
  totals: {
    revenue: number;
    cost: number;
    margin: number;
    cashIn: number;
    cashOut: number;
    cashNet: number;
  };
};

const DEFAULT_MONTHS = 12;

/**
 * Whether a commitment already carries this cost code's scope into the forecast,
 * so counting the buildup line as well would be the same money twice.
 *
 * Two ways that is true:
 *   procurement_order_id - the code IS one purchase order, one to one.
 *   commitment_covered   - the scope is bought out across several commitments,
 *                          which a single FK cannot express. SSC S is the budget
 *                          line for all electrical, which is two subcontracts;
 *                          SSC T is one line against sixteen POs. See 0068.
 *
 * Reads undefined on a database where 0068 has not run, which is false, which
 * is the behaviour from before the flag existed.
 */
function isCommitmentCovered(
  code: { procurement_order_id?: string | null; commitment_covered?: boolean | null } | null,
): boolean {
  return !!code?.procurement_order_id || code?.commitment_covered === true;
}

type Options = { monthsAhead?: number; today?: Date };

export async function buildProjection(
  supabase: SupabaseClient,
  projectId: string,
  opts: Options = {},
): Promise<ProjectionResult> {
  const today = opts.today ?? new Date();
  const todayIso = firstOfMonthIso(today);
  const months = opts.monthsAhead ?? DEFAULT_MONTHS;
  const horizonEnd = addMonthsIso(todayIso, months);
  const startCap = addMonthsIso(todayIso, -6); // include up to 6 prior months for context

  const [
    projectRes, entriesRes, forecastsRes, paymentsRes, posRes, linesRes, tasksRes,
    subSovRes, subBilledRes, changeOrdersRes, payAppsRes,
    poLinesRes, commodityLinksRes, dprsRes, subAppsRes, amendmentsRes,
  ] =
    await Promise.all([
      supabase
        .from("projects")
        .select(
          "owner_payment_terms_days, retainage_pct_default, retainage_release_event, cod_date, guaranteed_substantial_completion_date",
        )
        .eq("id", projectId)
        .maybeSingle(),
      supabase
        .from("billing_entries")
        .select(
          "billing_line_id, period_month, cash_in_month, paid_at, pay_application_id, planned_amount, actual_amount, retainage_amount, status, billing_lines!inner(project_id)",
        )
        .eq("billing_lines.project_id", projectId),
      // cost_codes is selected with * rather than by name because
      // commitment_covered does not exist until 0068 runs, and a named select
      // on a missing column errors the whole request and takes the cash flow
      // down with it. Same reason the procurement selects below use *.
      supabase
        .from("cost_forecasts")
        .select(
          "period_month, planned_amount, actual_amount, cost_codes!inner(*, subcontractors(payment_terms_days, retainage_pct))",
        )
        .eq("cost_codes.project_id", projectId),
      // Cash OUT, so vendor rows only. Since 0055 a PO also carries owner
      // rows saying what we bill the owner for it, and counting those here
      // would book money we are receiving as money we are spending.
      //
      // Filtered in JS rather than in the query, and selected with * rather
      // than by name, because the column does not exist until 0055 runs. A
      // named select or a filter on a missing column errors the whole request
      // and takes the dashboard down with it; * does not.
      //
      // Anything not explicitly "owner" counts, so a row predating 0055 or one
      // whose side never got set still books. Cash out is the side that must
      // not silently lose rows.
      supabase
        .from("procurement_payments")
        .select("*, procurement_orders!inner(project_id, po_number)")
        .eq("procurement_orders.project_id", projectId),
      supabase
        .from("procurement_orders")
        // See the PO detail page: "*" so the whole cash flow does not fail
        // on one column that has not been added yet.
        .select("*")
        .eq("project_id", projectId),
      supabase
        .from("billing_lines")
        .select("*")
        .eq("project_id", projectId),
      supabase
        .from("schedule_tasks")
        .select("id, wbs_code, task_name, status, start_date, end_date, pct_complete")
        .eq("project_id", projectId),
      supabase
        .from("sub_sov_lines")
        .select(
          "id, item_number, description, scheduled_value, linked_task_wbs_codes, milestone_task_wbs_code, linked_commodity_ids, verification_method, subcontractor_id, active, subcontractors!inner(company_name, payment_terms_days, retainage_pct)",
        )
        .eq("project_id", projectId),
      supabase
        .from("sub_pay_app_lines")
        .select("sub_sov_line_id, total_completed, sub_pay_apps!inner(project_id, app_number)")
        .eq("sub_pay_apps.project_id", projectId),
      // Change orders that are not approved yet. An approved one is already in
      // the forecast through its own SOV line, so only the pipeline is read
      // here, to name what is waiting. Pending COs are not in the curve.
      supabase
        .from("change_orders")
        .select("co_number, description, co_value, cost_amount, status")
        .eq("project_id", projectId),
      // What an AFP was actually paid, for entries that carry one. The terms
      // say when the owner is expected to pay; paid_at says when they did.
      supabase
        .from("pay_applications")
        .select("id, app_number, paid_at")
        .eq("project_id", projectId),
      // Line items, for a PO with more than one delivery. Each item can point
      // at its own schedule row, and a payment milestone can say which item it
      // pays for. Selected with * because 0061 and 0062 may not have run, and
      // a named select on a missing column errors the whole request.
      supabase
        .from("procurement_order_lines")
        .select("*, procurement_orders!inner(project_id)")
        .eq("procurement_orders.project_id", projectId),
      // A commodity-mapped SOV line reaches the schedule through its
      // commodities. schedule_task_id, not wbs_code, so it needs the task ids.
      supabase
        .from("commodity_task_links")
        .select("commodity_id, schedule_task_id, commodities!inner(project_id)")
        .eq("commodities.project_id", projectId),
      // Earliest field report per subcontractor - the platform's record of the
      // day a crew hit site, which is what a mobilization line is earned on.
      supabase
        .from("dprs")
        .select("subcontractor_id, report_date")
        .eq("project_id", projectId)
        .order("report_date", { ascending: true }),
      // Sub pay apps as cash: what was paid, and what is approved and due.
      supabase
        .from("sub_pay_apps")
        .select("*")
        .eq("project_id", projectId),
      // Which contract lines a change order's money belongs to (0054). Errors
      // on a database without the table, which reads as no allocations.
      supabase
        .from("billing_line_amendments")
        .select("amendment_line_id, base_line_id, amount")
        .eq("project_id", projectId),
    ]);

  const warnings: ProjectionWarning[] = [];
  const notes: ProjectionNote[] = [];
  // Unpaid money whose date has passed is overdue, not history.
  const notPast = (m: string) => (m < todayIso ? todayIso : m);

  // Vendor rows only, for the reason given at the query above. Applied once
  // here so both places that walk the payments see the same set.
  const vendorPayments = paymentsRes.data ?? [];

  const ownerTermsDays = Number(projectRes.data?.owner_payment_terms_days ?? 0);

  // Map task estimates for downstream use (smart estimator).
  const taskEstimates = new Map<string, ReturnType<typeof estimateTaskProgress>>();
  for (const t of tasksRes.data ?? []) {
    if (!t.start_date && !t.end_date && !t.status) {
      warnings.push({
        kind: "task_no_dates",
        ref: t.wbs_code,
        message: `Task ${t.wbs_code} has no dates and no status - progress unknown`,
      });
    }
    taskEstimates.set(
      t.wbs_code,
      estimateTaskProgress(
        {
          status: t.status,
          start_date: t.start_date,
          end_date: t.end_date,
          pct_complete: t.pct_complete,
        },
        todayIso,
      ),
    );
  }

  // Procurement orders that have no payment milestones - cash side will miss
  // them entirely if we don't surface this.
  const posWithPayments = new Set<string>();
  for (const p of vendorPayments) {
    const po = p.procurement_orders as unknown as { project_id: string; po_number: string | null } | null;
    if (po) posWithPayments.add(po.po_number ?? "");
  }
  for (const po of posRes.data ?? []) {
    if (po.status === "cancelled") continue;
    const key = po.po_number ?? po.id;
    if (!posWithPayments.has(po.po_number ?? "")) {
      warnings.push({
        kind: "po_missing_milestones",
        ref: key,
        message: `PO ${po.po_number ?? "(no number)"} from ${po.vendor_name} has no payment milestones - cash projection will miss these payments`,
      });
    }
  }

  // Lines with no linked tasks: their schedule-driven estimates can't fire.
  for (const line of linesRes.data ?? []) {
    if ((line.linked_task_wbs_codes ?? []).length === 0) {
      warnings.push({
        kind: "billing_line_no_link",
        ref: line.item_number,
        message: `${line.item_number} "${line.description ?? ""}" has no schedule task links - auto-projection skipped`,
      });
    }
  }

  // ---- BUCKETS ----
  type Bucket = {
    revenueActual: number;
    revenueForecast: number;
    retainageActual: number;
    retainageForecast: number;
    cashOutActual: number;
    cashOutForecast: number;
    revenueRecognized: number;
    subCostIncurred: number;
    vendorCostIncurred: number;
    cashIn: number;
    subCashOut: number;
    vendorCashOut: number;
    hasActualBilling: boolean;
    hasActualCost: boolean;
    confidenceSignals: Confidence[];
  };
  const empty = (): Bucket => ({
    revenueActual: 0,
    revenueForecast: 0,
    retainageActual: 0,
    retainageForecast: 0,
    cashOutActual: 0,
    cashOutForecast: 0,
    revenueRecognized: 0,
    subCostIncurred: 0,
    vendorCostIncurred: 0,
    cashIn: 0,
    subCashOut: 0,
    vendorCashOut: 0,
    hasActualBilling: false,
    hasActualCost: false,
    confidenceSignals: [],
  });
  const buckets = new Map<string, Bucket>();
  const get = (iso: string): Bucket => {
    if (!buckets.has(iso)) buckets.set(iso, empty());
    return buckets.get(iso)!;
  };

  // ---- BILLING -> Revenue (accrual) + Cash In (cash basis) ----
  //
  // The cash month is no longer the terms date for every entry. An AFP that
  // has been paid lands on the day it was paid - see billing-cash-date for
  // the order of precedence. Net 30 says when the owner is expected to pay;
  // once they have, the date is the date.
  const payAppById = new Map((payAppsRes.data ?? []).map((a) => [a.id, a]));
  const ownerMoves = new Map<string, { label: string; at: ReturnType<typeof ownerCashMonth> }>();

  // A forecast entry with nothing behind it is the spreadsheet, not the job.
  //
  // Zarina: "Only forecast cashflow based on everything the app has been doing
  // when it comes to billing, PO's, change orders, schedules."
  //
  // billing_entries holds two different things under one shape. Rows tied to a
  // pay application, or carrying an AFP number, or past 'forecast' status, are
  // money that was actually billed. The rest were loaded from the owner
  // cash-flow spreadsheet and say what somebody PLANNED to bill in a month
  // chosen before the work was scheduled - Sweet Springs still carries
  // $160,381, $80,000 and $40,000 on 2026-06 for civil work that had not
  // happened.
  //
  // Those are skipped here AND left out of billedByLine below, so the money is
  // not lost: the schedule-driven pass picks up the line's whole unbilled
  // remainder and dates it from the milestone task's planned finish. The total
  // is identical. What changes is the month, which now moves when the schedule
  // moves instead of sitting where a spreadsheet put it.
  let plannedOnly = 0;
  const plannedOnlyLines = new Set<string>();
  for (const e of entriesRes.data ?? []) {
    const gross = effectiveAmount(e.actual_amount, e.planned_amount);
    if (gross <= 0) continue;
    if (!hasBillingEvidence(e)) {
      plannedOnly += gross;
      const id = (e as { billing_line_id?: string | null }).billing_line_id;
      if (id) plannedOnlyLines.add(id);
      continue;
    }
    const accrualMonth = e.period_month;

    const payApp = e.pay_application_id ? payAppById.get(e.pay_application_id) : null;
    const at = ownerCashMonth({
      periodMonth: e.period_month,
      cashInMonth: e.cash_in_month,
      entryPaidAt: e.paid_at,
      payAppPaidAt: payApp?.paid_at ?? null,
      ownerTermsDays,
    });
    const ownerPaid = at.source === "paid" || e.status === "paid";
    const cashMonth = ownerPaid ? at.month : notPast(at.month);
    if (at.supersedes) {
      // One line per AFP, not per SOV line. Sixty entries on one pay
      // application would be sixty identical notes saying the same thing.
      const label = payApp?.app_number ? `AFP ${payApp.app_number}` : `${e.period_month.slice(0, 7)} billing`;
      if (!ownerMoves.has(label)) ownerMoves.set(label, { label, at });
    }
    const retainage = Number(e.retainage_amount ?? 0);

    const accrualBucket = get(accrualMonth);
    accrualBucket.revenueRecognized += gross;
    const isReal = Number(e.actual_amount ?? 0) > 0 || e.status === "paid";
    if (isReal) {
      accrualBucket.revenueActual += gross;
      accrualBucket.retainageActual += retainage;
      accrualBucket.hasActualBilling = true;
      accrualBucket.confidenceSignals.push("high");
    } else {
      accrualBucket.revenueForecast += gross;
      accrualBucket.retainageForecast += retainage;
      accrualBucket.confidenceSignals.push("medium"); // forecast
    }

    const cashBucket = get(cashMonth);
    cashBucket.cashIn += Math.max(0, gross - retainage);
  }

  for (const move of Array.from(ownerMoves.values())) {
    notes.push({
      kind: "owner_cash_from_payment",
      ref: move.label,
      message: describeOwnerCashMove(move),
    });
  }

  // ---- SCHEDULE-DRIVEN FORECAST ----
  //
  // Everything above this point is money somebody already wrote down: a billing
  // entry, a cost forecast, a vendor milestone. That is why a project which has
  // never billed projected a flat zero - the curve could only show what had
  // already been recorded, which is the opposite of a forecast.
  //
  // This fills in the rest from the schedule. An SOV line earns when the work it
  // points at is planned to finish, so the milestone task's END DATE is the
  // month the money lands in. Not progress, not today's percent - the planned
  // date. That is what makes the curve move when the schedule moves.
  //
  // Only the unbilled remainder is forecast, so a line half billed in real
  // entries contributes its other half here and nothing is counted twice.
  const schedTasks = (tasksRes.data ?? []) as {
    wbs_code: string; task_name: string; end_date: string | null;
  }[];

  /** The month an SOV line's milestone is planned to finish. */
  const milestoneMonthOf = (
    links: string[] | null,
    explicit?: string | null,
  ): { month: string; via: string } | null => {
    const codes = explicit ? [explicit, ...(links ?? [])] : links ?? [];
    for (const code of codes) {
      // A leaf is its own milestone; a package resolves to the deliverable
      // inside it, the same way the billing suggestion engine reads it.
      const hasChildren = schedTasks.some((t) => isSummaryOf(code, t.wbs_code));
      const task = hasChildren
        ? resolveMilestoneTask(schedTasks, code)
        : schedTasks.find((t) => t.wbs_code === code);
      if (task?.end_date) {
        return { month: monthIsoFromDate(task.end_date), via: task.wbs_code };
      }
    }
    return null;
  };

  const ownerRetPct = Number(projectRes.data?.retainage_pct_default ?? 0) / 100;
  const billedByLine = new Map<string, number>();
  for (const e of entriesRes.data ?? []) {
    const id = (e as { billing_line_id?: string | null }).billing_line_id;
    if (!id) continue;
    // Same rule as the loop above, and it has to be: counting a planned-only
    // entry as billed here would shrink the remainder the schedule pass
    // forecasts, and the money would vanish from the curve entirely rather
    // than move to its scheduled month.
    if (!hasBillingEvidence(e)) continue;
    billedByLine.set(
      id,
      (billedByLine.get(id) ?? 0) + effectiveAmount(e.actual_amount, e.planned_amount),
    );
  }

  // Said out loud. A curve that quietly re-dates a quarter of a million
  // dollars is one nobody can reconcile against the spreadsheet they still
  // have open.
  if (plannedOnly > 0.005) {
    notes.push({
      kind: "planned_billing_reforecast",
      ref: `${plannedOnlyLines.size} SOV line${plannedOnlyLines.size === 1 ? "" : "s"}`,
      message: `$${Math.round(plannedOnly).toLocaleString()} of imported cash-flow plan is not in the curve at the month the spreadsheet put it. Those lines are forecast from the schedule instead, on the planned finish of the work they are linked to.`,
    });
  }

  let forecastRetainage = 0;
  let forecastSubRetainage = 0;

  // Scope and billing after change-order allocations, so a contract line a
  // change order raised is measured against its current value, and the
  // change order's own line keeps only the scope it did not hand out.
  const effective = effectiveLineProgress(
    (linesRes.data ?? []).map((l) => ({
      id: l.id,
      itemNumber: l.item_number,
      description: l.description ?? "",
      scheduledValue: Number(l.scheduled_value ?? 0),
      changeOrderId: (l as { change_order_id?: string | null }).change_order_id ?? null,
    })),
    (amendmentsRes.data ?? []) as AmendmentRow[],
    new Map(Array.from(billedByLine.entries()).map(([id, b]) => [id, { previous: b, current: 0 }])),
  );

  for (const line of linesRes.data ?? []) {
    const eff = effective.get(line.id);
    const remaining = eff
      ? eff.scope - eff.billed
      : Number(line.scheduled_value ?? 0) - (billedByLine.get(line.id) ?? 0);
    if (remaining <= 0.005) continue;

    const at = milestoneMonthOf(line.linked_task_wbs_codes);
    if (!at) {
      // Warned rather than dropped: a line missing from the curve is money the
      // forecast is silently short by.
      if ((line.linked_task_wbs_codes ?? []).length > 0) {
        warnings.push({
          kind: "task_no_dates",
          ref: line.item_number,
          message: `${line.item_number} "${line.description ?? ""}" links to work with no planned finish date - $${Math.round(remaining).toLocaleString()} is missing from the forecast`,
        });
      }
      continue;
    }

    const lineMonth = notPast(at.month);
    const accrual = get(lineMonth);
    accrual.revenueRecognized += remaining;
    accrual.revenueForecast += remaining;
    accrual.confidenceSignals.push("low"); // estimated from the schedule

    const retainage = remaining * ownerRetPct;
    accrual.retainageForecast += retainage;
    forecastRetainage += retainage;
    const cashMonth =
      ownerTermsDays > 0 ? shiftByDaysToMonth(lineMonth, ownerTermsDays) : lineMonth;
    get(cashMonth).cashIn += remaining - retainage;
  }

  // ---- CHANGE ORDERS NOT APPROVED YET ----
  //
  // An approved CO is already above: it has its own SOV line and lands in the
  // month its work finishes. A CO that is still draft, in review or submitted
  // is NOT in the curve - Phil, 2026-10-08: pending change orders "should not
  // be added". Assuming them billed put $553k of revenue and $489k of cost on
  // Sweet Springs that no one had agreed to. Each one is still named, with its
  // value, so the dashboard says what is waiting rather than hiding it.
  for (const co of changeOrdersRes.data ?? []) {
    if (!isPipelineCo(co.status)) continue;
    const value = Number(co.co_value ?? 0);
    if (!Number.isFinite(value) || value === 0) continue;
    const cost = (co as { cost_amount?: number | null }).cost_amount;
    warnings.push({
      kind: "pipeline_change_order",
      ref: co.co_number ?? "CO",
      message: `${co.co_number ?? "A change order"} (${(co.status ?? "").replace("_", " ")}) is not in the forecast until it is approved - $${Math.round(value).toLocaleString()} billable${cost != null ? `, $${Math.round(Number(cost)).toLocaleString()} cost` : ""}`,
    });
  }

  // The same treatment on the way out, off the subcontractor SOV.
  // total_completed is the G703's column G - already cumulative - so each
  // line takes the latest app's figure. Summing would count App 1 again in
  // every later app.
  const subBilledByLine = new Map<string, number>();
  const subLatestApp = new Map<string, number>();
  for (const l of subBilledRes.data ?? []) {
    const id = (l as { sub_sov_line_id?: string | null }).sub_sov_line_id;
    if (!id) continue;
    const appNo = Number(
      (l as { sub_pay_apps?: { app_number?: number | null } | null }).sub_pay_apps?.app_number ?? 0,
    );
    if (appNo >= (subLatestApp.get(id) ?? -1)) {
      subLatestApp.set(id, appNo);
      subBilledByLine.set(id, Number((l as { total_completed?: number | null }).total_completed ?? 0));
    }
  }

  // A sub SOV line reaches the schedule three ways, and only the first was
  // being followed. "All mapped" on the sub billing page counts the EVIDENCE
  // mapping; the forecast needs a date. A commodity-mapped line reaches one
  // through commodity_task_links, and a mobilization line through the first
  // field report. See sov-forecast-date for the order.
  const wbsByTaskId = new Map(
    (tasksRes.data ?? []).map((t) => [(t as { id: string }).id, t.wbs_code]),
  );
  const wbsByCommodityId = new Map<string, string[]>();
  for (const l of commodityLinksRes.data ?? []) {
    const wbs = wbsByTaskId.get((l as { schedule_task_id: string }).schedule_task_id);
    if (!wbs) continue;
    const id = (l as { commodity_id: string }).commodity_id;
    const list = wbsByCommodityId.get(id) ?? [];
    list.push(wbs);
    wbsByCommodityId.set(id, list);
  }
  // Ordered ascending by report_date, so the first one seen for a sub is the
  // day they hit site.
  const onSiteBySub = new Map<string, string>();
  for (const d of dprsRes.data ?? []) {
    const sub = (d as { subcontractor_id: string | null }).subcontractor_id;
    const date = (d as { report_date: string | null }).report_date;
    if (!sub || !date || onSiteBySub.has(sub)) continue;
    onSiteBySub.set(sub, date);
  }
  const finishOf = (code: string) => {
    const at = milestoneMonthOf([code]);
    return at ? { wbs: at.via, month: at.month } : null;
  };

  for (const line of (subSovRes.data ?? []) as unknown as {
    id: string; item_number: string; description: string | null;
    scheduled_value: number | null;
    linked_task_wbs_codes: string[] | null; milestone_task_wbs_code: string | null;
    linked_commodity_ids: string[] | null; verification_method: string | null;
    subcontractor_id: string | null;
    active: boolean | null;
    subcontractors: {
      company_name: string; payment_terms_days: number | null; retainage_pct: number | null;
    } | null;
  }[]) {
    if (line.active === false) continue;
    const remaining = Number(line.scheduled_value ?? 0) - (subBilledByLine.get(line.id) ?? 0);
    if (remaining <= 0.005) continue;

    const subName = line.subcontractors?.company_name ?? "A subcontractor";
    const mapping = {
      itemNumber: line.item_number,
      description: line.description,
      verificationMethod: line.verification_method,
      linkedTaskWbsCodes: line.linked_task_wbs_codes,
      milestoneTaskWbsCode: line.milestone_task_wbs_code,
      linkedCommodityIds: line.linked_commodity_ids,
    };
    const resolved = resolveSovMonth({
      line: mapping,
      finishOf,
      wbsByCommodityId,
      onSiteDate: line.subcontractor_id
        ? (onSiteBySub.get(line.subcontractor_id) ?? null)
        : null,
    });

    if (!resolved.month) {
      // Named by the mapping the line DOES have. "No dated task" was the same
      // sentence for every cause, and on a commodity-mapped line it sent
      // somebody looking for work that was already done.
      warnings.push({
        kind: "sub_sov_no_date",
        ref: `${subName} ${line.item_number}`,
        message: describeSovDateGap({ subName, line: mapping, at: resolved, remaining }),
      });
      continue;
    }

    const note = describeSovDateSource({ subName, line: mapping, at: resolved });
    if (note) {
      notes.push({
        kind: "sov_date_from_mapping",
        ref: `${subName} ${line.item_number}`,
        message: note,
      });
    }

    const at = { month: notPast(resolved.month), via: resolved.via ?? "" };

    const subDays = Number(line.subcontractors?.payment_terms_days ?? 0);
    const retPct = Number(line.subcontractors?.retainage_pct ?? 0) / 100;

    const accrual = get(at.month);
    accrual.subCostIncurred += remaining;
    accrual.confidenceSignals.push("low");

    const cashMonth = subDays > 0 ? shiftByDaysToMonth(at.month, subDays) : at.month;
    const netOut = remaining * (1 - retPct);
    const outBucket = get(cashMonth);
    outBucket.subCashOut += netOut;
    outBucket.cashOutForecast += netOut;
    forecastSubRetainage += remaining * retPct;
  }

  // ---- SUB COSTS -> Cost (accrual) + Cash Out (cash basis) ----
  for (const f of forecastsRes.data ?? []) {
    const code = f.cost_codes as unknown as {
      subcontractor_id: string | null;
      procurement_order_id: string | null;
      commitment_covered?: boolean | null;
      subcontractors: { payment_terms_days: number | null; retainage_pct: number | null } | null;
    } | null;
    if (isCommitmentCovered(code)) continue;
    const gross = effectiveAmount(f.actual_amount, f.planned_amount);
    if (gross <= 0) continue;
    const isActual = Number(f.actual_amount ?? 0) > 0;
    const fMonth = isActual ? f.period_month : notPast(f.period_month);
    const subDays = Number(code?.subcontractors?.payment_terms_days ?? 0);
    const retPct = Number(code?.subcontractors?.retainage_pct ?? 0) / 100;
    const cashMonth = subDays > 0 ? shiftByDaysToMonth(fMonth, subDays) : fMonth;
    const netCash = gross * (1 - retPct);

    const accrualBucket = get(fMonth);
    accrualBucket.subCostIncurred += gross;
    if (Number(f.actual_amount ?? 0) > 0) {
      accrualBucket.hasActualCost = true;
      accrualBucket.confidenceSignals.push("high");
    } else {
      accrualBucket.confidenceSignals.push("medium");
    }

    const cashBucket = get(cashMonth);
    cashBucket.subCashOut += netCash;
    if (Number(f.actual_amount ?? 0) > 0) cashBucket.cashOutActual += netCash;
    else cashBucket.cashOutForecast += netCash;
  }

  // ---- VENDOR PAYMENTS -> Cost (accrual, at milestone) + Cash Out ----
  //
  // The date is not read straight off expected_date any more. A payment that
  // fires on delivery follows the delivery task the PO is linked to, so
  // moving that task moves the vendor cash the same way it already moves sub
  // cash - see po-payment-forecast for the three rules. A deposit, a
  // commissioning payment and anything already paid are untouched.
  // Sub pay apps are cash. Paid books the amount paid in the month it went
  // out; approved or in review books at the due date. The SOV loop above
  // already subtracts what these apps billed, so nothing is counted twice.
  for (const a of (subAppsRes.data ?? []) as {
    status: string | null;
    amount_due: number | null;
    approved_amount_due: number | null;
    approved_retainage: number | null;
    retainage_this_period: number | null;
    paid_at: string | null;
    due_date: string | null;
  }[]) {
    if (a.status === "rejected") continue;
    forecastSubRetainage += Number(a.approved_retainage ?? a.retainage_this_period ?? 0);
    const amt = Number(a.approved_amount_due ?? a.amount_due ?? 0);
    if (amt <= 0) continue;
    if (a.status === "paid" && a.paid_at) {
      const b = get(monthIsoFromDate(String(a.paid_at)));
      b.subCashOut += amt;
      b.cashOutActual += amt;
      b.hasActualCost = true;
      b.confidenceSignals.push("high");
    } else {
      const b = get(notPast(a.due_date ? monthIsoFromDate(String(a.due_date)) : todayIso));
      b.subCashOut += amt;
      b.cashOutForecast += amt;
      b.confidenceSignals.push("medium");
    }
  }

  const poById = new Map((posRes.data ?? []).map((o) => [o.id, o]));
  const taskByWbs = new Map((tasksRes.data ?? []).map((t) => [t.wbs_code, t]));

  // Line items grouped by PO. Empty on a project where 0061 or 0062 has not
  // run, which puts every milestone back on the PO-level link.
  const linesByPo = new Map<string, PoForecastLine[]>();
  for (const l of poLinesRes.data ?? []) {
    const row = l as {
      id: string;
      procurement_order_id: string;
      line_no?: number | null;
      description?: string | null;
      linked_delivery_task_wbs_code?: string | null;
    };
    const list = linesByPo.get(row.procurement_order_id) ?? [];
    list.push({
      id: row.id,
      line_no: row.line_no ?? null,
      description: row.description ?? null,
      linked_delivery_task_wbs_code: row.linked_delivery_task_wbs_code ?? null,
    });
    linesByPo.set(row.procurement_order_id, list);
  }

  for (const p of vendorPayments) {
    const amount = Number(p.paid_amount ?? p.amount ?? 0);
    if (amount <= 0) continue;

    const order = poById.get(p.procurement_order_id) ?? null;
    const linkedWbs = order?.linked_delivery_task_wbs_code ?? null;
    const deliveryTask = linkedWbs ? (taskByWbs.get(linkedWbs) ?? null) : null;
    const at = forecastMilestoneDate({
      milestone: p,
      po: order ?? {},
      deliveryTask,
      lines: linesByPo.get(p.procurement_order_id) ?? [],
      taskOf: (wbs) => taskByWbs.get(wbs) ?? null,
    });

    const poLabel = order?.po_number ?? order?.vendor_name ?? "A purchase order";
    const milestoneName = p.milestone_name ?? "payment";

    if (!at.date) {
      // Dropping this silently is money the curve is short by, on a row that
      // exists and has an amount on it. The old code did exactly that.
      warnings.push({
        kind: "po_payment_no_date",
        ref: poLabel,
        message: `${poLabel} ${milestoneName} has no date and no delivery task linked - $${Math.round(amount).toLocaleString()} is missing from the forecast`,
      });
      continue;
    }

    if (at.supersedes) {
      notes.push({
        kind: "po_payment_from_schedule",
        ref: poLabel,
        message: describeScheduleMove({
          poLabel,
          milestoneName,
          at,
          taskName: deliveryTask?.task_name ?? null,
        }),
      });
    }

    const month = p.paid_at
      ? monthIsoFromDate(at.date)
      : notPast(monthIsoFromDate(at.date));

    const bucket = get(month);
    bucket.vendorCostIncurred += amount;
    bucket.vendorCashOut += amount;
    if (p.paid_at) {
      bucket.cashOutActual += amount;
      bucket.hasActualCost = true;
      bucket.confidenceSignals.push("high");
    } else {
      bucket.cashOutForecast += amount;
      bucket.confidenceSignals.push("medium");
    }
  }

  // ---- RETAINAGE RELEASE on cash basis at the last cash month + 1 ----
  let totalOwnerRetainage = forecastRetainage;
  for (const e of entriesRes.data ?? []) {
    totalOwnerRetainage += Number(e.retainage_amount ?? 0);
  }
  let totalSubRetainage = forecastSubRetainage;
  for (const f of forecastsRes.data ?? []) {
    const code = f.cost_codes as unknown as {
      procurement_order_id: string | null;
      commitment_covered?: boolean | null;
      subcontractors: { retainage_pct: number | null } | null;
    } | null;
    // Same exclusion as the cost loop above, and it has to be: retainage held
    // on a code whose cost is not in the forecast is retainage on nothing, and
    // it would be released into cash in the final month out of thin air.
    if (isCommitmentCovered(code)) continue;
    const retPct = Number(code?.subcontractors?.retainage_pct ?? 0) / 100;
    const gross = effectiveAmount(f.actual_amount, f.planned_amount);
    totalSubRetainage += gross * retPct;
  }
  if (totalOwnerRetainage > 0 || totalSubRetainage > 0) {
    // The contract's release event, not "wherever the curve happens to end".
    // Sweet Springs releases at Final Completion, 2027-06-02 on the schedule;
    // the old rule put a $146,687 receipt in Apr 2027, three months early on
    // the largest receipt left in the job. See retainage-release.ts.
    const at = resolveRetainageRelease({
      event: projectRes.data?.retainage_release_event,
      tasks: (tasksRes.data ?? []).map((t) => ({
        task_name: t.task_name,
        end_date: t.end_date,
      })),
      codDate: projectRes.data?.cod_date,
      guaranteedSubstantialCompletion:
        projectRes.data?.guaranteed_substantial_completion_date,
    });

    const allMonths = Array.from(buckets.keys()).sort();
    const lastMonth = allMonths[allMonths.length - 1];
    // No resolvable event keeps the old behaviour rather than dropping the
    // money: retainage missing from the curve is worse than retainage in an
    // approximate month, and the note below says which one you are looking at.
    const releaseMonth =
      at.month ?? (lastMonth ? fallbackReleaseMonth(lastMonth) : null);

    if (releaseMonth) {
      // Subs are released at the event. The owner's share arrives on terms
      // after it, because Net 30 applies to the retainage invoice like any
      // other - which is what makes the tail of the job a real squeeze: you
      // let go of sub retainage before the owner's reaches you.
      const ownerMonth = ownerReleaseMonth(releaseMonth, ownerTermsDays);
      get(ownerMonth).cashIn += totalOwnerRetainage;

      const subBucket = get(releaseMonth);
      subBucket.subCashOut += totalSubRetainage;
      // The release is money moving, so it belongs in the actual/forecast split
      // as well. Leaving it out made the Cash Out timeline read $86,490 against
      // a $96,100 total - short by exactly the sub retainage.
      subBucket.cashOutForecast += totalSubRetainage;

      if (at.month) {
        notes.push({
          kind: "retainage_release_from_event",
          ref: `${Math.round(totalOwnerRetainage).toLocaleString()} owner / ${Math.round(totalSubRetainage).toLocaleString()} sub`,
          message: describeRelease(at, ownerTermsDays),
        });
      } else {
        warnings.push({
          kind: "retainage_release_no_event",
          ref: `$${Math.round(totalOwnerRetainage + totalSubRetainage).toLocaleString()}`,
          message: `Retainage is drawn one month after the last other movement because it ${at.why}. $${Math.round(totalOwnerRetainage).toLocaleString()} owner and $${Math.round(totalSubRetainage).toLocaleString()} sub retainage are in the curve at a month nobody chose.`,
        });
      }
    }
  }

  // ---- Build the row series across [startCap .. max(horizonEnd, lastBucket)] ----
  const usedMonths = Array.from(buckets.keys()).sort();
  const earliest = usedMonths[0] ?? todayIso;
  const latest = usedMonths[usedMonths.length - 1] ?? horizonEnd;
  const seriesStart = earliest < startCap ? earliest : startCap;
  const seriesEnd = latest > horizonEnd ? latest : horizonEnd;
  const series = monthsBetween(seriesStart, seriesEnd);

  let cumMargin = 0;
  let cumCash = 0;
  const rows: ProjectionRow[] = series.map((iso) => {
    const b = buckets.get(iso) ?? empty();
    const totalCost = b.subCostIncurred + b.vendorCostIncurred;
    const netMargin = b.revenueRecognized - totalCost;
    const totalCashOut = b.subCashOut + b.vendorCashOut;
    const netCash = b.cashIn - totalCashOut;
    cumMargin += netMargin;
    cumCash += netCash;
    const confidence =
      b.confidenceSignals.length === 0
        ? "none"
        : aggregateConfidence(b.confidenceSignals);
    return {
      month: iso,
      label: shortMonthLabel(iso),
      revenueRecognized: b.revenueRecognized,
      subCostIncurred: b.subCostIncurred,
      vendorCostIncurred: b.vendorCostIncurred,
      totalCost,
      netMargin,
      cumulativeMargin: cumMargin,
      cashIn: b.cashIn,
      subCashOut: b.subCashOut,
      vendorCashOut: b.vendorCashOut,
      totalCashOut,
      netCash,
      cumulativeCash: cumCash,
      revenueActual: b.revenueActual,
      revenueForecast: b.revenueForecast,
      retainageActual: b.retainageActual,
      retainageForecast: b.retainageForecast,
      cashOutActual: b.cashOutActual,
      cashOutForecast: b.cashOutForecast,
      confidence,
      hasActualBilling: b.hasActualBilling,
      hasActualCost: b.hasActualCost,
      isPast: iso < todayIso,
      isCurrent: iso === todayIso,
    };
  });

  // Totals across the horizon (excluding past months so we report forward view).
  let revenue = 0,
    cost = 0,
    margin = 0,
    cashIn = 0,
    cashOut = 0,
    cashNet = 0;
  for (const r of rows) {
    revenue += r.revenueRecognized;
    cost += r.totalCost;
    margin += r.netMargin;
    cashIn += r.cashIn;
    cashOut += r.totalCashOut;
    cashNet += r.netCash;
  }

  return {
    rows,
    warnings,
    notes,
    totals: { revenue, cost, margin, cashIn, cashOut, cashNet },
  };
}
