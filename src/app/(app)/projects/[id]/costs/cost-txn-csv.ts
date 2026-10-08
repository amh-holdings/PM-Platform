import type { CostTxn, MonthCode } from "./cost-by-month";

/**
 * Every QuickBooks cost transaction on the project, both bases, as a CSV the
 * auditor can open beside the Controller's own reports. One row per QB line,
 * with the app cost code it was booked to.
 */
export function downloadCostTransactionsCsv(transactions: CostTxn[], codes: MonthCode[]) {
  const codeById = new Map(codes.map((c) => [c.id, c]));
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "Basis", "Month", "Date", "Cost code", "Cost code name", "QB item",
    "Type", "Number", "Vendor", "Paid from", "Amount", "QB cutoff",
  ];
  const lines = [...transactions]
    .sort((a, b) => a.basis.localeCompare(b.basis) || a.txn_date.localeCompare(b.txn_date))
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
  a.download = `cost-transactions-qb-${transactions[0]?.qb_cutoff ?? "export"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
