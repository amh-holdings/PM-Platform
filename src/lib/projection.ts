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
import { aggregateConfidence, estimateTaskProgress, type Confidence } from "@/lib/progress";

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
  kind: "po_missing_milestones" | "billing_line_no_link" | "task_no_dates" | "underbilled" | "overbilled";
  ref: string;
  message: string;
};

export type ProjectionResult = {
  rows: ProjectionRow[];
  warnings: ProjectionWarning[];
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

  const [projectRes, entriesRes, forecastsRes, paymentsRes, posRes, linesRes, tasksRes] =
    await Promise.all([
      supabase
        .from("projects")
        .select("owner_payment_terms_days, retainage_pct_default")
        .eq("id", projectId)
        .maybeSingle(),
      supabase
        .from("billing_entries")
        .select(
          "period_month, cash_in_month, planned_amount, actual_amount, retainage_amount, status, billing_lines!inner(project_id)",
        )
        .eq("billing_lines.project_id", projectId),
      supabase
        .from("cost_forecasts")
        .select(
          "period_month, planned_amount, actual_amount, cost_codes!inner(project_id, subcontractor_id, procurement_order_id, subcontractors(payment_terms_days, retainage_pct))",
        )
        .eq("cost_codes.project_id", projectId),
      supabase
        .from("procurement_payments")
        .select(
          "expected_date, paid_at, amount, paid_amount, procurement_orders!inner(project_id, po_number)",
        )
        .eq("procurement_orders.project_id", projectId),
      supabase
        .from("procurement_orders")
        .select("id, po_number, vendor_name, status")
        .eq("project_id", projectId),
      supabase
        .from("billing_lines")
        .select("id, item_number, description, linked_task_wbs_codes")
        .eq("project_id", projectId),
      supabase
        .from("schedule_tasks")
        .select("wbs_code, status, start_date, end_date, pct_complete")
        .eq("project_id", projectId),
    ]);

  const warnings: ProjectionWarning[] = [];

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
  for (const p of paymentsRes.data ?? []) {
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
  for (const e of entriesRes.data ?? []) {
    const gross = effectiveAmount(e.actual_amount, e.planned_amount);
    if (gross <= 0) continue;
    const accrualMonth = e.period_month;
    const cashMonth =
      e.cash_in_month ??
      (ownerTermsDays > 0 ? shiftByDaysToMonth(e.period_month, ownerTermsDays) : e.period_month);
    const retainage = Number(e.retainage_amount ?? 0);

    const accrualBucket = get(accrualMonth);
    accrualBucket.revenueRecognized += gross;
    if (Number(e.actual_amount ?? 0) > 0 || e.status === "paid") {
      accrualBucket.hasActualBilling = true;
      accrualBucket.confidenceSignals.push("high");
    } else {
      accrualBucket.confidenceSignals.push("medium"); // forecast
    }

    const cashBucket = get(cashMonth);
    cashBucket.cashIn += Math.max(0, gross - retainage);
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
  }

  // ---- VENDOR PAYMENTS -> Cost (accrual, at milestone) + Cash Out ----
  for (const p of paymentsRes.data ?? []) {
    const date = p.paid_at ?? p.expected_date;
    if (!date) continue;
    const amount = Number(p.paid_amount ?? p.amount ?? 0);
    if (amount <= 0) continue;
    const month = monthIsoFromDate(date);

    const bucket = get(month);
    bucket.vendorCostIncurred += amount;
    bucket.vendorCashOut += amount;
    if (p.paid_at) {
      bucket.hasActualCost = true;
      bucket.confidenceSignals.push("high");
    } else {
      bucket.confidenceSignals.push("medium");
    }
  }

  // ---- RETAINAGE RELEASE on cash basis at the last cash month + 1 ----
  let totalOwnerRetainage = 0;
  for (const e of entriesRes.data ?? []) {
    totalOwnerRetainage += Number(e.retainage_amount ?? 0);
  }
  let totalSubRetainage = 0;
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
    totals: { revenue, cost, margin, cashIn, cashOut, cashNet },
  };
}
