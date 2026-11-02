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

/** One bid's price by category (0081). */
export function PriceBreakdown({ lines, size }: { lines: BdCostLine[]; size: number | null }) {
  const { byCategory, total } = rollUpCostLines(lines);
  return (
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
  );
}
