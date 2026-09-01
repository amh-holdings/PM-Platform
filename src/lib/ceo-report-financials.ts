// The money half of the CEO Report - BUILT AND TESTED, DELIBERATELY DORMANT.
//
// Phil's call on 2026-09-01: the CEO Report ships as a progress report first,
// and financials get folded in later. This module is that later. Nothing
// renders it today - `ceo-report.ts` and both report pages are progress-only,
// so no dollar figure can reach the printed sheet by accident.
//
// It is kept rather than deleted because the derivation is not obvious and was
// expensive to get right. Three traps were found by checking these numbers
// against the executed contract, and each one produced a confident, wrong
// figure that looked entirely plausible on a page:
//
//  1. Approved change orders must NOT be added to `projects.contract_value`.
//     The Sweet Springs SOV already carries the CO scope as line items 13.00
//     through 16.00, so adding the change_orders table double-counts $1.28M.
//  2. `v_project_billing_summary` must not be read. The live database still
//     has the pre-0007 definition, whose join against billing_entries
//     multi-counts scheduled_value - it reports $8.14M on a $3.79M job.
//  3. Cost codes are hierarchical. "SSC T" (Main Components, $674,773) is the
//     parent of SSC T.1 .. SSC T.15, which sum to $565,459. Summing every row
//     makes the budget exceed the contract and reports a healthy 12% job as a
//     $112,904 loss. See `rollUpCostCodes`.
//
// Its tests run in `scripts/ceo-report/run-tests.ts` and must keep passing, so
// the traps stay closed while the module waits.

import {
  fmtMoney,
  pctOf,
  round2,
  type CeoCheck,
  type CeoProjectRow,
} from "@/lib/ceo-report";

// ---------------------------------------------------------------- input rows
export type CeoBillingLineRow = {
  item_number: string | null;
  description: string | null;
  scheduled_value: number | null;
};

export type CeoPayAppRow = {
  app_number: string | null;
  status: string | null;
  period_start: string | null;
  period_end: string | null;
  /**
   * NOTE: despite the AIA name, this column holds THIS PERIOD's completed
   * work, not the cumulative to-date figure. Verified against the
   * `previous_billings` chain on all 13 Sweet Springs applications.
   */
  total_completed: number | null;
  total_retainage: number | null;
  previous_billings: number | null;
  amount_due: number | null;
  paid_at: string | null;
};

export type CeoCostCodeRow = {
  code: string;
  name: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  is_change_order: boolean | null;
};

export type CeoSubRow = {
  company_name: string | null;
  trade: string | null;
  contract_value: number | null;
  active: boolean | null;
};

export type CeoPoRow = {
  vendor_name: string | null;
  description: string | null;
  total_value: number | null;
  status: string | null;
};

export type CeoSubPayAppRow = {
  status: string | null;
  approved_this_period: number | null;
  billed_this_period: number | null;
};

export type CeoChangeOrderRow = {
  co_number: string | null;
  description: string | null;
  status: string | null;
  co_value: number | null;
  cost_amount: number | null;
};

/** Everything the dormant money half needs. Assembled only when it is revived. */
export type CeoFinancialInput = {
  asOf: string;
  project: CeoProjectRow;
  billingLines: CeoBillingLineRow[];
  payApps: CeoPayAppRow[];
  costCodes: CeoCostCodeRow[];
  subs: CeoSubRow[];
  purchaseOrders: CeoPoRow[];
  subPayApps: CeoSubPayAppRow[];
  changeOrders: CeoChangeOrderRow[];
};

const num = (v: number | null | undefined): number =>
  v == null || !Number.isFinite(Number(v)) ? 0 : Number(v);

const sum = <T,>(rows: T[], pick: (r: T) => number | null | undefined): number =>
  rows.reduce((s, r) => s + num(pick(r)), 0);

/** Money compared at the cent, so floating point noise is not a finding. */
const differs = (a: number, b: number, tolerance = 0.01): boolean =>
  Math.abs(a - b) > tolerance;

// ------------------------------------------------------------ contract value

export type ContractValue = {
  value: number;
  /** Which record the figure came from. */
  source: "sov" | "project" | "none";
  sovTotal: number | null;
  projectTotal: number | null;
  /** Approved COs, reported for context only - never added to `value`. */
  approvedChangeOrders: number;
  changeOrderCount: number;
};

/**
 * The contract the CEO is being measured against.
 *
 * The schedule of values IS the contract - it is what the owner signed and
 * what every pay application bills against - so it wins when both are present.
 * `projects.contract_value` is a denormalized convenience copy and is used
 * only as a cross-check, and as the fallback when no SOV has been imported.
 *
 * Approved change orders are counted and reported but deliberately NOT added.
 * On Sweet Springs the CO scope is already inside the SOV as items 13.00-16.00;
 * adding the change_orders table on top would inflate the contract by $1.28M
 * and understate percent complete by a third.
 */
export function contractValue(
  billingLines: CeoBillingLineRow[],
  project: CeoProjectRow,
  changeOrders: CeoChangeOrderRow[],
): ContractValue {
  const sovTotal = billingLines.length > 0 ? round2(sum(billingLines, (l) => l.scheduled_value)) : null;
  const projectTotal = project.contract_value == null ? null : round2(num(project.contract_value));

  const approved = changeOrders.filter((c) => (c.status ?? "").toLowerCase() === "approved");

  const value = sovTotal ?? projectTotal ?? 0;
  const source: ContractValue["source"] =
    sovTotal != null ? "sov" : projectTotal != null ? "project" : "none";

  return {
    value,
    source,
    sovTotal,
    projectTotal,
    approvedChangeOrders: round2(sum(approved, (c) => c.co_value)),
    changeOrderCount: approved.length,
  };
}

// ---------------------------------------------------------- cost code rollup

export type CostRollup = {
  /** The de-duplicated budget: parents only, descendants folded in. */
  budget: number;
  /** What a naive sum of every row would have said. */
  naiveTotal: number;
  /** naiveTotal - budget. Zero when the codes are flat. */
  doubleCounted: number;
  /** Codes dropped as descendants of a code that is already counted. */
  rolledUpCodes: string[];
  /** Actual cost recorded against the counted rows. */
  actual: number;
  /** How many counted rows carry a non-zero actual. */
  rowsWithActual: number;
  countedRows: number;
};

/**
 * Fold hierarchical cost codes to their top level so nothing is counted twice.
 *
 * Cost codes are dotted: "SSC T" is Main Components at $674,773 and
 * "SSC T.1".."SSC T.15" are the equipment items inside it, totalling $565,459.
 * They are a breakdown of the parent, not additional scope, so a plain
 * `sum(estimated_cost)` reports $3.90M of budget against a $3.79M contract and
 * tells the CEO the job is losing money. It is not - it is at about 12%.
 *
 * The parent is kept rather than the children because the parent is the
 * authoritative budget line and the children are a partial breakdown (SSC T.15
 * carries no estimate at all). Keeping the parent is also the conservative
 * choice: it is the larger cost, so it reports the lower margin.
 *
 * A descendant whose parent carries NO estimate is kept - otherwise a costed
 * breakdown under an uncosted heading would vanish from the budget entirely.
 */
export function rollUpCostCodes(rows: CeoCostCodeRow[]): CostRollup {
  const estimated = new Map<string, number | null>();
  for (const r of rows) estimated.set(r.code, r.estimated_cost == null ? null : num(r.estimated_cost));

  // A row is a descendant if any ANCESTOR prefix of its dotted code is itself
  // a row that carries an estimate. Checking every ancestor rather than just
  // the immediate parent means "A.1.1" is still folded when "A.1" is absent.
  const isRolledUp = (code: string): boolean => {
    const parts = code.split(".");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join(".");
      const est = estimated.get(ancestor);
      if (est != null && est !== 0) return true;
    }
    return false;
  };

  const rolledUpCodes: string[] = [];
  const counted: CeoCostCodeRow[] = [];
  for (const r of rows) {
    if (isRolledUp(r.code)) rolledUpCodes.push(r.code);
    else counted.push(r);
  }

  const naiveTotal = round2(sum(rows, (r) => r.estimated_cost));
  const budget = round2(sum(counted, (r) => r.estimated_cost));

  return {
    budget,
    naiveTotal,
    doubleCounted: round2(naiveTotal - budget),
    rolledUpCodes,
    // Actuals are read across ALL rows: an actual booked to a child is real
    // spend against the parent's budget, so folding the budget must not hide it.
    actual: round2(sum(rows, (r) => r.actual_cost)),
    rowsWithActual: rows.filter((r) => num(r.actual_cost) > 0).length,
    countedRows: counted.length,
  };
}

// ------------------------------------------------------------ money position

/** Pay application statuses that mean the owner has settled. */
const PAID_STATUSES = new Set(["paid"]);
/** Billed and sitting with the owner. */
const OUTSTANDING_STATUSES = new Set(["submitted", "approved", "pending"]);

export type PayAppLine = {
  appNumber: string;
  status: string;
  periodEnd: string | null;
  completed: number;
  retainage: number;
  amountDue: number;
  paid: boolean;
};

export type MoneyPosition = {
  contract: ContractValue;
  /** Cumulative work completed across every application on or before as-of. */
  billedToDate: number;
  pctBilled: number | null;
  /** Contract not yet billed. The revenue still to earn. */
  backlog: number;
  /** Net retainage the owner is holding (releases net off). */
  retainageHeld: number;
  /** Applications marked paid. */
  collected: number;
  /** Billed, not yet paid - AHC's exposure to the owner. */
  outstanding: number;
  outstandingApps: string[];
  applications: PayAppLine[];
  latestPeriodEnd: string | null;
};

/**
 * Where the money stands with the owner.
 *
 * `total_completed` is per-period despite its AIA name, so billed-to-date is
 * the sum across applications. That is cross-checked against the independent
 * `previous_billings + total_completed` of the newest application; the two are
 * derived from different columns, so a mismatch means an application is
 * missing, duplicated, or out of sequence, and that raises a check.
 */
export function moneyPosition(
  input: CeoFinancialInput,
  contract: ContractValue,
  checks: CeoCheck[],
): MoneyPosition {
  const inScope = input.payApps
    .filter((a) => !a.period_end || a.period_end <= input.asOf)
    .slice()
    .sort((a, b) => String(a.period_end).localeCompare(String(b.period_end)));

  const applications: PayAppLine[] = inScope.map((a) => ({
    appNumber: a.app_number ?? "-",
    status: a.status ?? "unknown",
    periodEnd: a.period_end,
    completed: round2(num(a.total_completed)),
    retainage: round2(num(a.total_retainage)),
    amountDue: round2(num(a.amount_due)),
    paid: PAID_STATUSES.has((a.status ?? "").toLowerCase()),
  }));

  const billedToDate = round2(sum(applications, (a) => a.completed));
  const retainageHeld = round2(sum(applications, (a) => a.retainage));
  const collected = round2(sum(applications.filter((a) => a.paid), (a) => a.amountDue));

  const outstandingRows = applications.filter(
    (a) => !a.paid && OUTSTANDING_STATUSES.has(a.status.toLowerCase()),
  );
  const outstanding = round2(sum(outstandingRows, (a) => a.amountDue));

  const newest = inScope.length > 0 ? inScope[inScope.length - 1] : null;

  // Cross-check: the chain of previous_billings must land on the same total.
  if (newest) {
    const chained = round2(num(newest.previous_billings) + num(newest.total_completed));
    if (differs(chained, billedToDate)) {
      checks.push({
        id: "billing-chain",
        label: "Pay application sequence",
        severity: "warn",
        detail:
          `Summing every application gives ${fmtMoney(billedToDate)} billed to date, but ` +
          `${newest.app_number ?? "the newest application"} carries previous billings of ` +
          `${fmtMoney(num(newest.previous_billings))} which chains to ${fmtMoney(chained)}. ` +
          `A ${fmtMoney(Math.abs(chained - billedToDate))} gap means an application is missing, ` +
          `duplicated, or out of sequence.`,
      });
    }
  }

  // Cross-check: amount due should be completed work less retainage taken.
  const expectedDue = round2(billedToDate - retainageHeld);
  const actualDue = round2(sum(applications, (a) => a.amountDue));
  if (differs(expectedDue, actualDue)) {
    checks.push({
      id: "retainage-arithmetic",
      label: "Retainage arithmetic",
      severity: "warn",
      detail:
        `Work completed less retainage is ${fmtMoney(expectedDue)}, but the applications ` +
        `request ${fmtMoney(actualDue)} - a ${fmtMoney(Math.abs(expectedDue - actualDue))} ` +
        `difference. Usually a retainage release that was not carried into the amount due ` +
        `on the same application.`,
    });
  }

  if (applications.length > 0 && applications.every((a) => !a.paid) === false) {
    const paidWithoutDate = inScope.filter(
      (a) => PAID_STATUSES.has((a.status ?? "").toLowerCase()) && !a.paid_at,
    );
    if (paidWithoutDate.length > 0) {
      checks.push({
        id: "payment-dates",
        label: "Payment dates not recorded",
        severity: "warn",
        detail:
          `${paidWithoutDate.length} of ${applications.length} applications are marked paid but ` +
          `carry no payment date, so days-to-pay and receivable ageing cannot be reported.`,
      });
    }
  }

  return {
    contract,
    billedToDate,
    pctBilled: pctOf(billedToDate, contract.value),
    backlog: round2(contract.value - billedToDate),
    retainageHeld,
    collected,
    outstanding,
    outstandingApps: outstandingRows.map((a) => a.appNumber),
    applications,
    latestPeriodEnd: newest?.period_end ?? null,
  };
}

/** Whole-dollar money, for prose inside checks. */
// ------------------------------------------------------------- cost position

export type ChangeOrderMargin = {
  coNumber: string;
  description: string | null;
  value: number;
  cost: number | null;
  margin: number | null;
  marginPct: number | null;
};

export type CostPosition = {
  rollup: CostRollup;
  /** Budgeted cost to deliver the whole contract. */
  budget: number;
  /** Contract less budget: the margin AHC planned to make. */
  marginAtBudget: number | null;
  marginAtBudgetPct: number | null;
  /** Subcontracts executed, from the sub register. */
  committedSubs: number;
  activeSubs: number;
  /** Purchase orders with a recorded value. */
  committedPos: number;
  posWithValue: number;
  posTotal: number;
  /** Subs + POs. The share of budget already locked in by contract. */
  committedTotal: number;
  pctBudgetCommitted: number | null;
  /**
   * Actual cost incurred. Null when coverage is too thin to mean anything -
   * see `actualCostUsable`.
   */
  actualCost: number | null;
  actualCostUsable: boolean;
  actualCoveragePct: number | null;
  /** Margin realised to date. Null whenever actual cost is not usable. */
  marginToDate: number | null;
  changeOrders: ChangeOrderMargin[];
  coValue: number;
  coCost: number | null;
  coMargin: number | null;
};

/**
 * Cost codes with an actual booked must cover at least this share of the
 * counted budget before "actual cost" is reported as a number.
 *
 * Below it, the figure is not a small loss or a big win - it is an empty
 * ledger, and reporting `budget - actual` as margin would show a spectacular
 * profit purely because nobody has entered the invoices. Sweet Springs sits at
 * roughly 5%: two rows out of forty-one.
 */
export const ACTUAL_COST_COVERAGE_FLOOR = 0.5;

export function costPosition(
  input: CeoFinancialInput,
  contract: ContractValue,
  checks: CeoCheck[],
): CostPosition {
  const rollup = rollUpCostCodes(input.costCodes);

  if (rollup.doubleCounted > 0) {
    checks.push({
      id: "cost-code-rollup",
      label: "Cost codes rolled up",
      severity: "ok",
      detail:
        `${rollup.rolledUpCodes.length} cost codes are a breakdown of a parent code that already ` +
        `carries the budget (${rollup.rolledUpCodes.slice(0, 4).join(", ")}` +
        `${rollup.rolledUpCodes.length > 4 ? ", ..." : ""}). They are folded into their parent ` +
        `rather than added, which keeps ${fmtMoney(rollup.doubleCounted)} from being counted twice.`,
    });
  }

  const budget = rollup.budget;
  const marginAtBudget = budget > 0 && contract.value > 0 ? round2(contract.value - budget) : null;

  const activeSubs = input.subs.filter((s) => s.active !== false);
  const committedSubs = round2(sum(activeSubs, (s) => s.contract_value));

  const posWithValue = input.purchaseOrders.filter(
    (p) => p.total_value != null && num(p.total_value) > 0,
  );
  const committedPos = round2(sum(posWithValue, (p) => p.total_value));

  if (input.purchaseOrders.length > 0 && posWithValue.length === 0) {
    checks.push({
      id: "po-values-missing",
      label: "Purchase orders carry no value",
      severity: "blocker",
      detail:
        `All ${input.purchaseOrders.length} purchase orders on this project have an empty ` +
        `total value, so committed equipment cost is not in the figure below. Committed cost ` +
        `is understated by whatever those orders are worth.`,
    });
  }

  const committedTotal = round2(committedSubs + committedPos);

  const actualCoverage = budget > 0 ? rollup.actual / budget : 0;
  const actualCostUsable = budget > 0 && actualCoverage >= ACTUAL_COST_COVERAGE_FLOOR;

  if (!actualCostUsable) {
    checks.push({
      id: "actual-cost-empty",
      label: "Actual cost is not being captured",
      severity: "blocker",
      detail:
        `Only ${rollup.rowsWithActual} of ${input.costCodes.length} cost codes carry any actual ` +
        `cost - ${fmtMoney(rollup.actual)} against a ${fmtMoney(budget)} budget. Margin earned ` +
        `to date cannot be computed, and nothing on this report should be read as the profit ` +
        `this job is actually making. Only the margin PLANNED at budget is shown.`,
    });
  }

  // Change order margin. `change_orders.cost_amount` is empty on every row, so
  // the cost side is recovered from the CO-numbered cost codes instead, which
  // is where the estimates were actually entered.
  const costByCoNumber = new Map<string, number>();
  for (const c of input.costCodes) {
    if (c.is_change_order && c.estimated_cost != null) {
      costByCoNumber.set(normalizeCo(c.code), num(c.estimated_cost));
    }
  }

  const approvedCos = input.changeOrders.filter(
    (c) => (c.status ?? "").toLowerCase() === "approved",
  );
  const changeOrders: ChangeOrderMargin[] = approvedCos.map((c) => {
    const value = round2(num(c.co_value));
    const cost =
      c.cost_amount != null
        ? round2(num(c.cost_amount))
        : (costByCoNumber.get(normalizeCo(c.co_number ?? "")) ?? null);
    const margin = cost == null ? null : round2(value - cost);
    return {
      coNumber: c.co_number ?? "-",
      description: c.description ?? null,
      value,
      cost,
      margin,
      marginPct: margin == null ? null : pctOf(margin, value),
    };
  });

  const costedCos = changeOrders.filter((c) => c.cost != null);
  const coValue = round2(sum(changeOrders, (c) => c.value));
  const coCost = costedCos.length > 0 ? round2(sum(costedCos, (c) => c.cost)) : null;

  if (changeOrders.length > 0 && costedCos.length < changeOrders.length) {
    checks.push({
      id: "co-cost-missing",
      label: "Change orders without a cost",
      severity: "warn",
      detail:
        `${changeOrders.length - costedCos.length} of ${changeOrders.length} approved change ` +
        `orders have no cost recorded, so the margin shown on change orders covers only the ` +
        `${costedCos.length} that do.`,
    });
  }

  return {
    rollup,
    budget,
    marginAtBudget,
    marginAtBudgetPct:
      marginAtBudget == null ? null : pctOf(marginAtBudget, contract.value),
    committedSubs,
    activeSubs: activeSubs.length,
    committedPos,
    posWithValue: posWithValue.length,
    posTotal: input.purchaseOrders.length,
    committedTotal,
    pctBudgetCommitted: budget > 0 ? pctOf(committedTotal, budget) : null,
    actualCost: actualCostUsable ? rollup.actual : null,
    actualCostUsable,
    actualCoveragePct: budget > 0 ? actualCoverage * 100 : null,
    marginToDate: null,
    changeOrders,
    coValue,
    coCost,
    coMargin: coCost == null ? null : round2(round2(sum(costedCos, (c) => c.value)) - coCost),
  };
}

/** "CO-01" / "CO 1" / "co-1" all key the same. */
function normalizeCo(raw: string): string {
  const m = raw.match(/(\d+)/);
  return m ? `CO-${String(Number(m[1])).padStart(2, "0")}` : raw.trim().toUpperCase();
}
