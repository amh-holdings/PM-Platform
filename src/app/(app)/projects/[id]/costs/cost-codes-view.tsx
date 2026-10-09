"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CostCodeList } from "../cost-list";
import { CostByMonth, type CostTxn, type MonthCode } from "./cost-by-month";
import { downloadCostTransactionsCsv } from "./cost-txn-csv";

type CostCodeRow = Parameters<typeof CostCodeList>[0]["codes"][number];

type Props = {
  projectId: string;
  codes: CostCodeRow[];
  paid: { cost_code_id: string; month: string; amount: number }[];
  /** Null until migration 0070 is applied. */
  transactions: CostTxn[] | null;
};

// One place for cost codes. "By code" is the budget table, each row opening to
// its months and the QuickBooks lines behind them. "By month" is the same money
// laid out as a grid, for "what did we spend in March across every code" - its
// column totals tie to QuickBooks month by month.
export function CostCodesView({ projectId, codes, paid, transactions }: Props) {
  const [view, setView] = useState<"code" | "month">("code");
  const monthCodes: MonthCode[] = codes.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    isChangeOrder: Boolean(c.is_change_order),
  }));
  const hasTx = transactions !== null && transactions.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border p-0.5 text-xs">
          {(
            [
              ["code", "By code"],
              ["month", "By month"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded px-2.5 py-1",
                view === v ? "bg-muted font-medium" : "text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {hasTx && view === "code" && <span>Click a code to see it month by month</span>}
          <Button
            size="sm"
            variant="outline"
            disabled={!hasTx}
            onClick={() => hasTx && downloadCostTransactionsCsv(transactions!, monthCodes)}
            title={hasTx ? "Every QuickBooks cost line, paid and incurred" : "Needs migration 0070"}
          >
            Download CSV
          </Button>
        </div>
      </div>

      {view === "code" ? (
        <CostCodeList projectId={projectId} codes={codes} transactions={transactions} />
      ) : (
        <CostByMonth codes={monthCodes} paid={paid} transactions={transactions} />
      )}
    </div>
  );
}
