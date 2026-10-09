"use client";

import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";
import type { CostTxn } from "./cost-by-month";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

type Props = {
  /** This code's QuickBooks transactions, both bases. */
  transactions: CostTxn[];
  /** cost_codes.actual_cost - the Actual column this panel has to tie to. */
  incurredTotal: number;
};

// One cost code opened up: month by month, incurred (dated when billed - the
// basis of the Actual column) beside paid (dated when paid), and each figure
// opens to the QuickBooks lines that make it up.
export function CodeMonths({ transactions, incurredTotal }: Props) {
  const [pick, setPick] = useState<{ month: string; basis: "cash" | "accrual" } | null>(null);

  const { months, byMonth, totals } = useMemo(() => {
    const byMonth = new Map<string, { accrual: number; cash: number }>();
    const totals = { accrual: 0, cash: 0 };
    for (const t of transactions) {
      const m = t.txn_date.slice(0, 7);
      const row = byMonth.get(m) ?? { accrual: 0, cash: 0 };
      row[t.basis] = round2(row[t.basis] + Number(t.amount));
      totals[t.basis] = round2(totals[t.basis] + Number(t.amount));
      byMonth.set(m, row);
    }
    return { months: Array.from(byMonth.keys()).sort(), byMonth, totals };
  }, [transactions]);

  const lines = pick
    ? transactions
        .filter((t) => t.basis === pick.basis && t.txn_date.slice(0, 7) === pick.month)
        .sort((a, b) => a.txn_date.localeCompare(b.txn_date))
    : [];

  if (months.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">No QuickBooks cost on this code yet.</p>;
  }

  const owed = round2(totals.accrual - totals.cash);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Incurred {formatCurrency(totals.accrual)}
          {Math.abs(totals.accrual - incurredTotal) > 0.005 && (
            <span className="ml-1 text-destructive">
              (Actual column says {formatCurrency(incurredTotal)})
            </span>
          )}
        </span>
        <span>Paid {formatCurrency(totals.cash)}</span>
        {owed !== 0 && <span>Billed, not yet paid {formatCurrency(owed)}</span>}
      </div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <table className="text-xs lg:w-80">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Month</th>
              <th className="px-2 py-1 text-right font-medium">Incurred</th>
              <th className="px-2 py-1 text-right font-medium">Paid</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {months.map((m) => {
              const row = byMonth.get(m)!;
              return (
                <tr key={m}>
                  <td className="whitespace-nowrap px-2 py-0.5">{monthLabel(m)}</td>
                  {(["accrual", "cash"] as const).map((b) => (
                    <td key={b} className="whitespace-nowrap px-1 py-0.5 text-right tabular-nums">
                      {row[b] ? (
                        <button
                          type="button"
                          onClick={() => setPick({ month: m, basis: b })}
                          className={cn(
                            "rounded px-1.5 py-0.5 hover:bg-muted",
                            pick?.month === m && pick.basis === b && "bg-primary/10 font-medium",
                          )}
                        >
                          {formatCurrency(row[b])}
                        </button>
                      ) : (
                        <span className="px-1.5 text-muted-foreground/40">-</span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="min-w-0 flex-1">
          {pick ? (
            <>
              <p className="mb-1 text-xs font-medium">
                {monthLabel(pick.month)} · {pick.basis === "accrual" ? "incurred, dated when billed" : "paid, dated when paid"} ·{" "}
                {lines.length} line{lines.length === 1 ? "" : "s"} ·{" "}
                {formatCurrency(round2(lines.reduce((s, t) => s + Number(t.amount), 0)))}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="border-b text-left text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 font-medium">Date</th>
                      <th className="px-2 py-1 font-medium">Type</th>
                      <th className="px-2 py-1 font-medium">Number</th>
                      <th className="px-2 py-1 font-medium">Vendor</th>
                      <th className="px-2 py-1 font-medium">Paid from</th>
                      <th className="px-2 py-1 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map((t, i) => (
                      <tr key={i}>
                        <td className="whitespace-nowrap px-2 py-1">{formatDate(t.txn_date)}</td>
                        <td className="whitespace-nowrap px-2 py-1">{t.qb_type}</td>
                        <td className="whitespace-nowrap px-2 py-1">{t.qb_num ?? "-"}</td>
                        <td className="px-2 py-1">{t.vendor ?? "-"}</td>
                        <td className="px-2 py-1 text-muted-foreground">{t.paid_from ?? "-"}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                          {formatCurrency(Number(t.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Click a month&apos;s figure to see the QuickBooks lines behind it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
