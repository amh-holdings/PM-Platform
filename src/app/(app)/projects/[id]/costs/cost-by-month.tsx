"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";

export type MonthCode = {
  id: string;
  code: string;
  name: string;
  isChangeOrder: boolean;
};

export type CostTxn = {
  cost_code_id: string | null;
  basis: "cash" | "accrual";
  txn_date: string;
  qb_type: string;
  qb_num: string | null;
  vendor: string | null;
  qb_item: string | null;
  paid_from: string | null;
  amount: number;
  qb_cutoff: string;
};

type PaidCell = { cost_code_id: string; month: string; amount: number };

type Props = {
  codes: MonthCode[];
  paid: PaidCell[];
  /** Null until migration 0070 is applied. */
  transactions: CostTxn[] | null;
};

type Basis = "cash" | "accrual";
const UNMAPPED = "__unmapped__";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function CostByMonth({ codes, paid, transactions }: Props) {
  const hasTx = transactions !== null && transactions.length > 0;
  const [basis, setBasis] = useState<Basis>("cash");
  const [open, setOpen] = useState<{ codeId: string; month: string | null } | null>(null);

  // Cell totals. With the transactions loaded, both bases are summed from
  // them, so a cell always equals the bills listed under it. Without them,
  // the paid view reads cost_forecasts - the same QuickBooks figures, already
  // rolled up by month.
  const { grid, months, rowTotals, colTotals, grand } = useMemo(() => {
    const grid = new Map<string, Map<string, number>>();
    const add = (codeId: string, month: string, amount: number) => {
      const row = grid.get(codeId) ?? new Map<string, number>();
      row.set(month, round2((row.get(month) ?? 0) + amount));
      grid.set(codeId, row);
    };
    if (hasTx) {
      for (const t of transactions!) {
        if (t.basis !== basis) continue;
        add(t.cost_code_id ?? UNMAPPED, t.txn_date.slice(0, 7), Number(t.amount));
      }
    } else {
      for (const p of paid) add(p.cost_code_id, p.month, p.amount);
    }
    const monthSet = new Set<string>();
    grid.forEach((row) => row.forEach((_, m) => monthSet.add(m)));
    const months = Array.from(monthSet).sort();
    const rowTotals = new Map<string, number>();
    const colTotals = new Map<string, number>();
    let grand = 0;
    grid.forEach((row, codeId) => {
      let t = 0;
      row.forEach((v, m) => {
        t += v;
        colTotals.set(m, round2((colTotals.get(m) ?? 0) + v));
      });
      rowTotals.set(codeId, round2(t));
      grand += t;
    });
    return { grid, months, rowTotals, colTotals, grand: round2(grand) };
  }, [hasTx, transactions, paid, basis]);

  const rows: MonthCode[] = [
    ...codes.filter((c) => grid.has(c.id)),
    ...(grid.has(UNMAPPED)
      ? [{ id: UNMAPPED, code: "-", name: "No matching cost code", isChangeOrder: false }]
      : []),
  ];

  const detail = useMemo(() => {
    if (!open || !hasTx) return [];
    return transactions!
      .filter(
        (t) =>
          t.basis === basis &&
          (t.cost_code_id ?? UNMAPPED) === open.codeId &&
          (open.month == null || t.txn_date.slice(0, 7) === open.month),
      )
      .sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  }, [open, hasTx, transactions, basis]);

  const openCode = open ? rows.find((r) => r.id === open.codeId) : null;
  const detailTotal = round2(detail.reduce((s, t) => s + Number(t.amount), 0));
  const cellTotal = open
    ? open.month
      ? grid.get(open.codeId)?.get(open.month) ?? 0
      : rowTotals.get(open.codeId) ?? 0
    : 0;

  const downloadCsv = () => {
    if (!hasTx) return;
    const codeById = new Map(codes.map((c) => [c.id, c]));
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Basis", "Month", "Date", "Cost code", "Cost code name", "QB item", "Type", "Number", "Vendor", "Paid from", "Amount", "QB cutoff"];
    const lines = transactions!
      .filter((t) => t.basis === basis)
      .sort((a, b) => a.txn_date.localeCompare(b.txn_date))
      .map((t) => {
        const c = t.cost_code_id ? codeById.get(t.cost_code_id) : null;
        return [
          t.basis === "cash" ? "Paid" : "Incurred",
          t.txn_date.slice(0, 7),
          t.txn_date,
          c?.code ?? "",
          c?.name ?? "",
          t.qb_item,
          t.qb_type,
          t.qb_num,
          t.vendor,
          t.paid_from,
          Number(t.amount).toFixed(2),
          t.qb_cutoff,
        ]
          .map(esc)
          .join(",");
      });
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cost-transactions-${basis === "cash" ? "paid" : "incurred"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        No monthly cost recorded yet. It fills in when the QuickBooks sync runs.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border p-0.5 text-xs">
          {(["cash", "accrual"] as const).map((b) => (
            <button
              key={b}
              type="button"
              disabled={b === "accrual" && !hasTx}
              onClick={() => {
                setBasis(b);
                setOpen(null);
              }}
              className={cn(
                "rounded px-2.5 py-1",
                basis === b ? "bg-muted font-medium" : "text-muted-foreground",
                b === "accrual" && !hasTx && "cursor-not-allowed opacity-50",
              )}
            >
              {b === "cash" ? "Paid (cash basis)" : "Incurred (accrual basis)"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {hasTx && <span>QuickBooks through {formatDate(transactions![0]?.qb_cutoff)}</span>}
          <Button size="sm" variant="outline" onClick={downloadCsv} disabled={!hasTx}>
            Download CSV
          </Button>
        </div>
      </div>

      {!hasTx && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          Showing paid cost by month. The bills behind each month, the incurred
          view and the CSV need migration 0070_cost_transactions.sql applied in
          Supabase, then one run of the QuickBooks sync.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-xs">
          <thead className="border-b bg-muted/40 text-muted-foreground">
            <tr>
              <th className="sticky left-0 z-10 bg-muted px-3 py-2 text-left font-medium">Cost code</th>
              {months.map((m) => (
                <th key={m} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                  {monthLabel(m)}
                </th>
              ))}
              <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.id} className={cn(open?.codeId === r.id && "bg-muted/30")}>
                <td className="sticky left-0 z-10 bg-card px-3 py-1.5">
                  <button
                    type="button"
                    className="text-left hover:underline disabled:no-underline"
                    disabled={!hasTx}
                    onClick={() => setOpen({ codeId: r.id, month: null })}
                    title={hasTx ? "All transactions on this code" : undefined}
                  >
                    <span className="font-medium">{r.code}</span>{" "}
                    <span className="text-muted-foreground">{r.name}</span>
                  </button>
                </td>
                {months.map((m) => {
                  const v = grid.get(r.id)?.get(m);
                  const selected = open?.codeId === r.id && open.month === m;
                  return (
                    <td key={m} className="whitespace-nowrap px-1 py-1 text-right tabular-nums">
                      {v ? (
                        <button
                          type="button"
                          disabled={!hasTx}
                          onClick={() => setOpen({ codeId: r.id, month: m })}
                          className={cn(
                            "rounded px-2 py-0.5",
                            hasTx && "hover:bg-muted",
                            selected && "bg-primary/10 font-medium",
                          )}
                        >
                          {formatCurrency(v)}
                        </button>
                      ) : (
                        <span className="px-2 text-muted-foreground/40">-</span>
                      )}
                    </td>
                  );
                })}
                <td className="whitespace-nowrap px-3 py-1.5 text-right font-medium tabular-nums">
                  {formatCurrency(rowTotals.get(r.id) ?? 0)}
                </td>
              </tr>
            ))}
            <tr className="bg-muted/20 font-medium">
              <td className="sticky left-0 z-10 bg-muted px-3 py-2 text-right uppercase tracking-wide text-muted-foreground">
                Total
              </td>
              {months.map((m) => (
                <td key={m} className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                  {formatCurrency(colTotals.get(m) ?? 0)}
                </td>
              ))}
              <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">
                {formatCurrency(grand)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {open && hasTx && (
        <div className="rounded-lg border bg-card p-3 shadow-sm">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">
                {openCode?.code} {openCode?.name}
                {open.month ? ` - ${monthLabel(open.month)}` : " - all months"}
              </h3>
              <p className="text-xs text-muted-foreground">
                {basis === "cash" ? "Paid, dated when paid" : "Incurred, dated when billed"} ·{" "}
                {detail.length} transaction{detail.length === 1 ? "" : "s"} ·{" "}
                {formatCurrency(detailTotal)}
                {Math.abs(detailTotal - cellTotal) > 0.005 && (
                  <span className="ml-1 text-destructive">
                    (does not match the grid&apos;s {formatCurrency(cellTotal)})
                  </span>
                )}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
              Close
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 font-medium">Type</th>
                  <th className="px-2 py-1.5 font-medium">Number</th>
                  <th className="px-2 py-1.5 font-medium">Vendor</th>
                  <th className="px-2 py-1.5 font-medium">QB item</th>
                  <th className="px-2 py-1.5 font-medium">Paid from</th>
                  <th className="px-2 py-1.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {detail.map((t, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap px-2 py-1.5">{formatDate(t.txn_date)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{t.qb_type}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{t.qb_num ?? "-"}</td>
                      <td className="px-2 py-1.5">{t.vendor ?? "-"}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{t.qb_item ?? "-"}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{t.paid_from ?? "-"}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                        {formatCurrency(Number(t.amount))}
                      </td>
                    </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
