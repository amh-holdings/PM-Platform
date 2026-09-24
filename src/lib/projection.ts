// 12-month rolling cash flow + margin projection.
//
// Pulls billing_entries, cost_forecasts, procurement_payments,
// schedule_tasks, and the project's payment-terms metadata, then projects
// every month from today out to N months ahead on BOTH bases:
//   accrual (revenue when billed, cost when incurred) - drives margin
//   cash    (when money actually moves) - drives funding decisions
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
import {
  describePipelineCo,
  describePipelineCoCost,
  describeUncostedPipelineCo,
  normalizeCoNumber,
  planPipelineCoCost,
  planPipelineCoRevenue,
} from "@/lib/change-order-projection";
import {
  describeOwnerCashMove,
  ownerCashMonth,
} from "@/lib/billing-cash-date";
import {
  describeSovDateGap,
  describeSovDateSource,
  resolveSovMonth,
} from "@/lib/sov-forecast-date";
import { resolveBillingPeriod } from "@/lib/billing-period-resolve";
import {
  describeScheduleMove,
  forecastMilestoneDate,
} from "@/lib/po-payment-forecast";
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
    | "sub_sov_no_date";
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
    | "sov_date_from_mapping";
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
    subSovRes, subBilledRes, changeOrdersRes, payAppsRes, costCodesRes,
    commodityLinksRes, dprsRes,
  ] =
    await Promise.all([
      supabase
        .from("projects")
        .select("owner_payment_terms_days, retainage_pct_default")
        .eq("id", projectId)
        .maybeSingle(),
      supabase
        .from("billing_entries")
        .select(
          "billing_line_id, period_month, cash_in_month, paid_at, pay_application_id, planned_amount, actual_amount, retainage_amount, status, billing_lines!inner(project_id)",
        )
        .eq("billing_lines.project_id", projectId),
      supabase
        .from("cost_forecasts")
        .select(
          "period_month, planned_amount, actual_amount, cost_codes!inner(project_id, subcontractor_id, procurement_order_id, subcontractors(payment_terms_days, retainage_pct))",
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
        .select(
          "id, po_number, vendor_name, status, linked_delivery_task_wbs_code, actual_delivery_date, payment_terms_summary",
        )
        .eq("project_id", projectId),
      supabase
        .from("billing_lines")
        .select("id, item_number, description, type, scheduled_value, linked_task_wbs_codes")
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
        .select("sub_sov_line_id, total_completed, sub_pay_apps!inner(project_id)")
        .eq("sub_pay_apps.project_id", projectId),
      // Change orders that are not approved yet. An approved one is already in
      // the forecast through its own SOV line, so only the pipeline is read
      // here - see planPipelineCoRevenue.
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
      // CO-numbered cost codes. Where change order costs were entered before
      // the buildup existed, and still the fallback the CEO report uses.
      supabase
        .from("cost_codes")
        .select("code, is_change_order, estimated_cost")
        .eq("project_id", projectId),
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
    ]);

  const warnings: ProjectionWarning[] = [];
  const notes: ProjectionNote[] = [];

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

  for (const e of entriesRes.data ?? []) {
    const gross = effectiveAmount(e.actual_amount, e.planned_amount);
    if (gross <= 0) continue;
    const accrualMonth = e.period_month;

    const payApp = e.pay_application_id ? payAppById.get(e.pay_application_id) : null;
    const at = ownerCashMonth({
      periodMonth: e.period_month,
      cashInMonth: e.cash_in_month,
      entryPaidAt: e.paid_at,
      payAppPaidAt: payApp?.paid_at ?? null,
      ownerTermsDays,
    });
    const cashMonth = at.month;
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
    billedByLine.set(
      id,
      (billedByLine.get(id) ?? 0) + effectiveAmount(e.actual_amount, e.planned_amount),
    );
  }

  let forecastRetainage = 0;
  let forecastSubRetainage = 0;

  for (const line of linesRes.data ?? []) {
    const scheduled = Number((line as { scheduled_value?: number | null }).scheduled_value ?? 0);
    const remaining = scheduled - (billedByLine.get(line.id) ?? 0);
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

    const accrual = get(at.month);
    accrual.revenueRecognized += remaining;
    accrual.revenueForecast += remaining;
    accrual.confidenceSignals.push("low"); // estimated from the schedule

    const retainage = remaining * ownerRetPct;
    accrual.retainageForecast += retainage;
    forecastRetainage += retainage;
    const cashMonth =
      ownerTermsDays > 0 ? shiftByDaysToMonth(at.month, ownerTermsDays) : at.month;
    get(cashMonth).cashIn += remaining - retainage;
  }

  // ---- CHANGE ORDERS NOT APPROVED YET ----
  //
  // An approved CO is already above: it has its own SOV line and lands in the
  // month its work finishes. Everything before approval was in the forecast
  // nowhere, which on a projection whose job is to say what is coming is a
  // hole rather than caution. The pipeline is assumed billed one month after
  // the AFP being assembled now - see planPipelineCoRevenue.
  const openPeriodMonth = await resolveBillingPeriod(supabase, projectId, today);
  const coPlan = planPipelineCoRevenue({
    cos: changeOrdersRes.data ?? [],
    openPeriodMonth,
    ownerRetainagePct: ownerRetPct,
    ownerTermsDays,
  });
  if (coPlan.entries.length > 0) {
    const accrual = get(coPlan.month);
    accrual.revenueRecognized += coPlan.totalGross;
    accrual.revenueForecast += coPlan.totalGross;
    accrual.retainageForecast += coPlan.totalRetainage;
    // Low, deliberately. This is money resting on an assumption about approval
    // rather than on an entry, and the confidence badge should say so.
    accrual.confidenceSignals.push("low");
    forecastRetainage += coPlan.totalRetainage;
    get(coPlan.cashMonth).cashIn += coPlan.totalNet;

    // One line per CO, so nobody finds an extra six figures in October and has
    // to go looking for where it came from.
    for (const entry of coPlan.entries) {
      warnings.push({
        kind: "pipeline_change_order",
        ref: entry.coNumber,
        message: describePipelineCo(entry, coPlan.month),
      });
    }

    // And what it costs to do the work. Booking the revenue alone made every
    // pipeline CO pure margin, so Margin at completion read high by exactly
    // the cost. Same month as the revenue: that revenue already rests on an
    // assumption about when the CO gets billed, and spreading the cost on a
    // second assumption on top would be precision the number has not earned.
    const coCostByNumber = new Map<string, number>();
    for (const c of costCodesRes.data ?? []) {
      if (!c.is_change_order || c.estimated_cost == null) continue;
      coCostByNumber.set(normalizeCoNumber(c.code), Number(c.estimated_cost));
    }
    const coStoredCost = new Map<string, number>();
    for (const c of changeOrdersRes.data ?? []) {
      const stored = (c as { cost_amount?: number | null }).cost_amount;
      if (stored == null) continue;
      coStoredCost.set(normalizeCoNumber(c.co_number ?? ""), Number(stored));
    }

    const costPlan = planPipelineCoCost({
      cos: changeOrdersRes.data ?? [],
      costByCoNumber: coCostByNumber,
      costAmountByCoNumber: coStoredCost,
      month: coPlan.month,
    });

    if (costPlan.totalCost > 0) {
      const costBucket = get(costPlan.month);
      costBucket.subCostIncurred += costPlan.totalCost;
      costBucket.subCashOut += costPlan.totalCost;
      costBucket.cashOutForecast += costPlan.totalCost;
      costBucket.confidenceSignals.push("low");
      for (const entry of costPlan.entries) {
        notes.push({
          kind: "pipeline_co_cost",
          ref: entry.coNumber,
          message: describePipelineCoCost(entry, costPlan.month),
        });
      }
    }

    // Revenue in the curve with no cost behind it. A guessed cost would be
    // worse than a named hole, so it is named.
    for (const entry of costPlan.uncosted) {
      warnings.push({
        kind: "pipeline_co_no_cost",
        ref: entry.coNumber,
        message: describeUncostedPipelineCo(entry),
      });
    }
  }

  // The same treatment on the way out, off the subcontractor SOV.
  const subBilledByLine = new Map<string, number>();
  for (const l of subBilledRes.data ?? []) {
    const id = (l as { sub_sov_line_id?: string | null }).sub_sov_line_id;
    if (!id) continue;
    subBilledByLine.set(
      id,
      (subBilledByLine.get(id) ?? 0) +
        Number((l as { total_completed?: number | null }).total_completed ?? 0),
    );
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

    const at = { month: resolved.month, via: resolved.via ?? "" };

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
      subcontractors: { payment_terms_days: number | null; retainage_pct: number | null } | null;
    } | null;
    if (code?.procurement_order_id) continue;
    const gross = effectiveAmount(f.actual_amount, f.planned_amount);
    if (gross <= 0) continue;
    const subDays = Number(code?.subcontractors?.payment_terms_days ?? 0);
    const retPct = Number(code?.subcontractors?.retainage_pct ?? 0) / 100;
    const cashMonth = subDays > 0 ? shiftByDaysToMonth(f.period_month, subDays) : f.period_month;
    const netCash = gross * (1 - retPct);

    const accrualBucket = get(f.period_month);
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
  const poById = new Map((posRes.data ?? []).map((o) => [o.id, o]));
  const taskByWbs = new Map((tasksRes.data ?? []).map((t) => [t.wbs_code, t]));

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

    const month = monthIsoFromDate(at.date);

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
      subcontractors: { retainage_pct: number | null } | null;
    } | null;
    if (code?.procurement_order_id) continue;
    const retPct = Number(code?.subcontractors?.retainage_pct ?? 0) / 100;
    const gross = effectiveAmount(f.actual_amount, f.planned_amount);
    totalSubRetainage += gross * retPct;
  }
  if (totalOwnerRetainage > 0 || totalSubRetainage > 0) {
    const allMonths = Array.from(buckets.keys()).sort();
    const lastMonth = allMonths[allMonths.length - 1];
    if (lastMonth) {
      const release = addMonthsIso(lastMonth, 1);
      const bucket = get(release);
      bucket.cashIn += totalOwnerRetainage;
      bucket.subCashOut += totalSubRetainage;
      // The release is money moving, so it belongs in the actual/forecast split
      // as well. Leaving it out made the Cash Out timeline read $86,490 against
      // a $96,100 total - short by exactly the sub retainage.
      bucket.cashOutForecast += totalSubRetainage;
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
