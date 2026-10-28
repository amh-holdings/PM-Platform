// Build a sub's bill from what they sent, against OUR SOV and history.
//
// One implementation for both ways a bill comes in: typed into the Record a
// bill form, and read from the sub's emailed G702/G703 by the email sweep. If
// the two ever computed a bill differently, a bill from email would stop
// meaning the same thing as one entered by hand. Pure: callers load the rows
// and write the result.
//
// The sub's G703 this-period figures are taken verbatim, one per SOV line.
// Everything else - completed to date, percent, balance, retainage - is
// DERIVED from the SOV and the prior application, never taken from the sub's
// paperwork. A bill whose own arithmetic is wrong should show up as a
// mismatch against our numbers, not overwrite them. The sub's stated totals
// go in as the "billed" header so the checks can compare the two.

import { approvedToDateByItem, type BillHeader, type BillLine } from "./sub-billing";
import { nextAppNumber } from "./sub-app-numbering";
import type { SubPayAppRow } from "./sub-billing.types";

export type SubBillInput = {
  period_end: string;
  period_start?: string | null;
  app_number?: number | null;
  app_date?: string | null;
  retainage_pct?: number | null;
  payment_terms_days?: number | null;
  due_date?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  invoice_total?: number | null;
  /** The sub's stated header figures. Blank falls back to ours. */
  billed_previous?: number | null;
  billed_this_period?: number | null;
  billed_to_date?: number | null;
  retainage_this_period?: number | null;
  retainage_to_date?: number | null;
  amount_due?: number | null;
  lien_waiver_received?: boolean;
  lien_waiver_amount?: number | null;
  lien_waiver_through_date?: string | null;
  notes?: string | null;
  /** G703 this-period and stored-materials figures, keyed by SOV item number. */
  this_period: Record<string, number>;
  stored?: Record<string, number>;
};

export type SovForBuild = {
  id: string;
  item_number: string;
  description: string;
  scheduled_value: number | null;
};

export type HistoryForBuild = {
  id: string;
  app_number: number;
  status: string;
  retainage_to_date: number | null;
};

export type BuiltLine = BillLine & { sub_sov_line_id: string; sort_order: number };

export type BuiltBill = {
  appNumber: number;
  header: BillHeader;
  /** sub_pay_apps columns, less project_id, subcontractor_id and entered_by. */
  row: Partial<SubPayAppRow>;
  lines: BuiltLine[];
};

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Which prior applications set the baseline: every one AHC did not reject. */
export function acceptedHistory<T extends { status: string; app_number: number }>(history: readonly T[]): T[] {
  return [...history].sort((a, b) => a.app_number - b.app_number).filter((a) => a.status !== "rejected");
}

export function buildSubBill(input: {
  bill: SubBillInput;
  subRetainagePct: number | null;
  sovLines: readonly SovForBuild[];
  /** Every application for this sub, any status. */
  history: readonly HistoryForBuild[];
  /** Lines of the accepted applications, for the previous column. */
  priorLines: Parameters<typeof approvedToDateByItem>[0];
}): BuiltBill {
  const { bill, sovLines, history } = input;
  const accepted = acceptedHistory(history);
  const priorApp = accepted.length > 0 ? accepted[accepted.length - 1] : null;
  const priorByItem = accepted.length > 0 ? approvedToDateByItem(input.priorLines) : new Map<string, number>();
  const priorRetainageHeld = Number(priorApp?.retainage_to_date ?? 0);

  const appNumber = bill.app_number ?? nextAppNumber(history);
  const retainagePct = bill.retainage_pct ?? Number(input.subRetainagePct ?? 0);
  const rate = retainagePct / 100;

  const lines: BuiltLine[] = sovLines.map((sov, i) => {
    const sv = Number(sov.scheduled_value ?? 0);
    const fromPrevious = priorByItem.get(sov.item_number) ?? 0;
    const thisPeriod = Number(bill.this_period[sov.item_number] ?? 0);
    const stored = Number(bill.stored?.[sov.item_number] ?? 0);
    const totalCompleted = round2(fromPrevious + thisPeriod + stored);
    return {
      sub_sov_line_id: sov.id,
      item_number: sov.item_number,
      description: sov.description,
      scheduled_value: sv,
      from_previous: fromPrevious,
      this_period: thisPeriod,
      materials_stored: stored,
      total_completed: totalCompleted,
      pct_billed: sv > 0 ? totalCompleted / sv : 0,
      balance_to_finish: round2(sv - totalCompleted),
      retainage_amount: round2(totalCompleted * rate),
      sort_order: (i + 1) * 10,
    };
  });

  const derivedThisPeriod = round2(lines.reduce((s, l) => s + Number(l.this_period), 0));
  const derivedToDate = round2(lines.reduce((s, l) => s + Number(l.total_completed), 0));
  const derivedPrevious = round2(lines.reduce((s, l) => s + Number(l.from_previous), 0));

  const statedThisPeriod = bill.billed_this_period ?? derivedThisPeriod;
  const statedToDate = bill.billed_to_date ?? derivedToDate;
  const statedRetainageThis =
    bill.retainage_this_period ?? round2(round2(derivedToDate * rate) - priorRetainageHeld);
  const statedRetainageToDate = bill.retainage_to_date ?? round2(derivedToDate * rate);
  const statedAmountDue = bill.amount_due ?? round2(statedThisPeriod - statedRetainageThis);

  const header: BillHeader = {
    app_number: appNumber,
    period_start: bill.period_start ?? null,
    period_end: bill.period_end,
    retainage_pct: retainagePct,
    payment_terms_days: bill.payment_terms_days ?? null,
    invoice_total: bill.invoice_total ?? null,
    billed_previous: bill.billed_previous ?? derivedPrevious,
    billed_this_period: statedThisPeriod,
    billed_to_date: statedToDate,
    retainage_this_period: statedRetainageThis,
    retainage_to_date: statedRetainageToDate,
    amount_due: statedAmountDue,
    lien_waiver_received: bill.lien_waiver_received ?? false,
    lien_waiver_amount: bill.lien_waiver_amount ?? null,
    lien_waiver_through_date: bill.lien_waiver_through_date ?? null,
  };

  const row: Partial<SubPayAppRow> = {
    app_number: appNumber,
    app_date: bill.app_date ?? null,
    period_start: header.period_start,
    period_end: bill.period_end,
    retainage_pct: retainagePct,
    payment_terms_days: header.payment_terms_days,
    due_date: bill.due_date ?? null,
    invoice_number: bill.invoice_number ?? null,
    invoice_date: bill.invoice_date ?? null,
    invoice_total: header.invoice_total,
    billed_previous: header.billed_previous,
    billed_this_period: header.billed_this_period,
    billed_to_date: header.billed_to_date,
    retainage_this_period: header.retainage_this_period,
    retainage_to_date: header.retainage_to_date,
    amount_due: header.amount_due,
    status: "received",
    lien_waiver_received: header.lien_waiver_received ?? false,
    lien_waiver_amount: header.lien_waiver_amount,
    lien_waiver_through_date: header.lien_waiver_through_date,
    notes: bill.notes ?? null,
  };

  return { appNumber, header, row, lines };
}

/** The sub_pay_app_lines insert rows for a built bill. */
export function lineRows(appId: string, lines: readonly BuiltLine[]) {
  return lines.map((l) => ({
    sub_pay_app_id: appId,
    sub_sov_line_id: l.sub_sov_line_id,
    item_number: l.item_number,
    description: l.description,
    scheduled_value: l.scheduled_value,
    from_previous: l.from_previous,
    this_period: l.this_period,
    materials_stored: l.materials_stored,
    total_completed: l.total_completed,
    pct_billed: l.pct_billed,
    balance_to_finish: l.balance_to_finish,
    retainage_amount: l.retainage_amount,
    sort_order: l.sort_order,
  }));
}
