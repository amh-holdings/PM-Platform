import { computeBillingSuggestions } from "../billing-actions";
import { formatCurrency, formatDate } from "@/lib/format";

import { PromoteSuggestionsButton } from "./promote-suggestions-button";

type Props = {
  projectId: string;
};

export async function BillingSuggestionsPanel({ projectId }: Props) {
  const result = await computeBillingSuggestions(projectId);

  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to compute suggestions: {result.error}
      </div>
    );
  }

  const { suggestions, nextMonthIso } = result;
  const total = suggestions.reduce((s, x) => s + x.suggestedAmount, 0);

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            Schedule-based suggestion for {formatDate(nextMonthIso)}
          </h3>
          <p className="text-xs text-muted-foreground">
            Based on each linked task&apos;s current status. Promote to{" "}
            <code>planned_amount</code> for next month, then tweak per line.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Total suggested</div>
            <div className="text-base font-semibold">{formatCurrency(total)}</div>
          </div>
          <PromoteSuggestionsButton
            projectId={projectId}
            disabled={suggestions.length === 0}
          />
        </div>
      </div>

      {suggestions.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No suggestions yet. Add linked schedule WBS codes per billing line
          below, then refresh.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 pr-2 text-left font-medium">Item</th>
                <th className="py-1.5 pr-2 text-left font-medium">Description</th>
                <th className="py-1.5 pr-2 text-left font-medium">Confidence</th>
                <th className="py-1.5 pr-2 text-right font-medium">Target %</th>
                <th className="py-1.5 pr-2 text-right font-medium">Billed</th>
                <th className="py-1.5 pr-2 text-right font-medium">Remaining</th>
                <th className="py-1.5 text-right font-medium">Suggest</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => {
                const confColor =
                  s.confidence === "high"
                    ? "text-emerald-700"
                    : s.confidence === "medium"
                      ? "text-amber-700"
                      : s.confidence === "low"
                        ? "text-orange-700"
                        : "text-muted-foreground";
                return (
                  <tr
                    key={s.billingLineId}
                    className="border-b last:border-0"
                    title={s.reasons.join(" | ")}
                  >
                    <td className="py-1.5 pr-2 font-mono">{s.itemNumber}</td>
                    <td className="py-1.5 pr-2">{s.description}</td>
                    <td className="py-1.5 pr-2">
                      <span className={`text-[10px] font-semibold uppercase ${confColor}`}>
                        {s.confidence}
                      </span>
                      <div className="text-[10px] text-muted-foreground">
                        {s.sourcesSummary}
                      </div>
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      {(s.targetPct * 100).toFixed(0)}%
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      {formatCurrency(s.alreadyBilled)}
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      {formatCurrency(s.remaining)}
                    </td>
                    <td className="py-1.5 text-right font-semibold text-emerald-600">
                      {formatCurrency(s.suggestedAmount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
