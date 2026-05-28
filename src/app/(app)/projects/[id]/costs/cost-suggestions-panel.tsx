import { computeSpendSuggestions } from "../cost-actions";
import { formatCurrency, formatDate } from "@/lib/format";

import { PromoteSpendButton } from "./promote-spend-button";

type Props = {
  projectId: string;
};

export async function CostSuggestionsPanel({ projectId }: Props) {
  const result = await computeSpendSuggestions(projectId);

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
            Schedule-based spend suggestion for {formatDate(nextMonthIso)}
          </h3>
          <p className="text-xs text-muted-foreground">
            For each cost code linked to a schedule task, suggested
            <code className="px-1">planned_amount</code> based on task status.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Total suggested</div>
            <div className="text-base font-semibold">{formatCurrency(total)}</div>
          </div>
          <PromoteSpendButton projectId={projectId} disabled={suggestions.length === 0} />
        </div>
      </div>

      {suggestions.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No suggestions yet. Add linked schedule WBS codes per cost code
          below, then refresh.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 pr-2 text-left font-medium">Code</th>
                <th className="py-1.5 pr-2 text-left font-medium">Name</th>
                <th className="py-1.5 pr-2 text-right font-medium">Target %</th>
                <th className="py-1.5 pr-2 text-right font-medium">Spent</th>
                <th className="py-1.5 pr-2 text-right font-medium">Remaining</th>
                <th className="py-1.5 text-right font-medium">Suggest</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => (
                <tr key={s.costCodeId} className="border-b last:border-0">
                  <td className="py-1.5 pr-2 font-mono">{s.code}</td>
                  <td className="py-1.5 pr-2">{s.name}</td>
                  <td className="py-1.5 pr-2 text-right">
                    {(s.targetPct * 100).toFixed(0)}%
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    {formatCurrency(s.alreadySpent)}
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    {formatCurrency(s.remaining)}
                  </td>
                  <td className="py-1.5 text-right font-semibold text-amber-700">
                    {formatCurrency(s.suggestedAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
