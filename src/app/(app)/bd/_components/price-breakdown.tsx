import {
  COST_CATEGORIES,
  COST_CATEGORY_LABEL,
  dollarsPerWatt,
  formatPerWatt,
  rollUpCostLines,
} from "@/lib/bd";
import type { BdCostLine } from "@/lib/bd-db";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { tdClass, thClass } from "./fields";

/** One bid's price by category, with the form lines behind each number (0081). */
export function PriceBreakdown({ lines, size }: { lines: BdCostLine[]; size: number | null }) {
  const { byCategory, total } = rollUpCostLines(lines);
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className={thClass}>Category</th>
              <th className={cn(thClass, "text-right")}>Price</th>
              <th className={cn(thClass, "text-right")}>$/W</th>
              <th className={cn(thClass, "text-right")}>Share</th>
            </tr>
          </thead>
          <tbody>
            {COST_CATEGORIES.map((c) => (
              <tr key={c} className="border-b">
                <td className={tdClass}>{COST_CATEGORY_LABEL[c]}</td>
                <td className={cn(tdClass, "text-right tabular-nums")}>{formatCurrency(byCategory[c])}</td>
                <td className={cn(tdClass, "text-right tabular-nums")}>
                  {formatPerWatt(dollarsPerWatt(byCategory[c], size))}
                </td>
                <td className={cn(tdClass, "text-right tabular-nums")}>
                  {total ? `${Math.round((byCategory[c] / total) * 100)}%` : "-"}
                </td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className={tdClass}>Overall price</td>
              <td className={cn(tdClass, "text-right tabular-nums")}>{formatCurrency(total)}</td>
              <td className={cn(tdClass, "text-right tabular-nums")}>
                {formatPerWatt(dollarsPerWatt(total, size))}
              </td>
              <td className={cn(tdClass, "text-right tabular-nums")} />
            </tr>
          </tbody>
        </table>
      </div>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">Lines behind these numbers</summary>
        <p className="mt-2 text-xs text-muted-foreground">Source: {lines[0]?.source_file}</p>
        {COST_CATEGORIES.map((c) => {
          const list = lines.filter((l) => l.category === c);
          if (!list.length) return null;
          return (
            <div key={c} className="mt-3">
              <h3 className="flex justify-between text-xs font-semibold uppercase text-muted-foreground">
                <span>{COST_CATEGORY_LABEL[c]}</span>
                <span className="tabular-nums">{formatCurrency(byCategory[c])}</span>
              </h3>
              <table className="mt-1 w-full text-sm">
                <tbody>
                  {list.map((l) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className={tdClass}>{l.label}</td>
                      <td className={cn(tdClass, "w-32 text-right tabular-nums")}>{formatCurrency(Number(l.amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </details>
    </div>
  );
}
