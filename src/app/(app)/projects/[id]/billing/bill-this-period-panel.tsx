import { getBillThisPeriodRows } from "../billing-actions";

import { BillThisPeriodClient } from "./bill-this-period-client";

type Props = {
  projectId: string;
  variant?: "page" | "widget";
};

// Server wrapper around the unified billing panel. Loads forecast entries +
// schedule-driven suggestions in one shot and hands them to the interactive
// client component.
export async function BillThisPeriodPanel({ projectId, variant = "page" }: Props) {
  const result = await getBillThisPeriodRows(projectId);
  if (!result.ok) return null;
  if (result.rows.length === 0 && result.hidden.length === 0) return null;
  return (
    <BillThisPeriodClient
      projectId={projectId}
      rows={result.rows}
      hidden={result.hidden}
      variant={variant}
    />
  );
}
