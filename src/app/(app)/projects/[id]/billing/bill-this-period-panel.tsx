import { getBillThisPeriodRows } from "../billing-actions";

import { BillThisPeriodClient } from "./bill-this-period-client";

type Props = {
  projectId: string;
  variant?: "page" | "widget";
  /** YYYY-MM-01 of the month being billed. Defaults to the last full month. */
  periodMonth?: string;
};

// Server wrapper around the unified billing panel. Loads forecast entries +
// schedule-driven suggestions in one shot and hands them to the interactive
// client component.
export async function BillThisPeriodPanel({
  projectId,
  variant = "page",
  periodMonth,
}: Props) {
  const result = await getBillThisPeriodRows(projectId, periodMonth);
  if (!result.ok) return null;
  // On the Billing page the panel always renders, even with nothing billable -
  // "no rows for August" is information, and the period selector above it needs
  // something to sit against. The dashboard widget still collapses when empty.
  if (variant === "widget" && result.rows.length === 0) return null;
  return (
    <BillThisPeriodClient
      projectId={projectId}
      rows={result.rows}
      hidden={result.hidden}
      variant={variant}
      periodMonth={result.periodMonth}
    />
  );
}
