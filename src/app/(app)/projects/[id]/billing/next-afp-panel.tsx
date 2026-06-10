import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { firstOfThisMonthIso, shortMonthLabel } from "@/lib/cashflow";

type Props = {
  projectId: string;
  variant?: "page" | "widget";
};

// Surfaces upcoming forecast/suggested/reviewed billing_entries so the PM
// can see what AFPs are queued up to be drafted next. Used both on the
// /billing page and embedded in the dashboard's Billing widget.
export async function NextAfpPanel({ projectId, variant = "page" }: Props) {
  const supabase = createClient();

  const { data: entries, error } = await supabase
    .from("billing_entries")
    .select(
      "period_month, planned_amount, retainage_amount, afp_number, status, billing_lines!inner(project_id, description, item_number)",
    )
    .eq("billing_lines.project_id", projectId)
    .order("period_month");

  if (error) return null;

  const thisMonthIso = firstOfThisMonthIso();
  const upcoming = (entries ?? [])
    .filter(
      (e) =>
        (e.status === "forecast" ||
          e.status === "suggested" ||
          e.status === "reviewed") &&
        e.period_month >= thisMonthIso,
    )
    .sort((a, b) => a.period_month.localeCompare(b.period_month))
    .slice(0, 5)
    .map((e) => {
      const line = e.billing_lines as unknown as {
        description: string | null;
        item_number: string | null;
      } | null;
      const gross = Number(e.planned_amount ?? 0);
      const retainage = Number(e.retainage_amount ?? 0);
      return {
        afp: e.afp_number ?? "(no number)",
        period: e.period_month,
        scope: line?.description ?? "(unlinked)",
        item: line?.item_number ?? "",
        gross,
        retainage,
        netCash: Math.max(0, gross - retainage),
        status: e.status,
      };
    });

  if (upcoming.length === 0) return null;

  return (
    <section
      className={cn(
        "rounded-lg border border-emerald-500/40 bg-emerald-500/5",
        variant === "page" ? "p-4 shadow-sm" : "p-3",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3
            className={cn(
              "font-semibold uppercase tracking-wide text-emerald-700",
              variant === "page" ? "text-sm" : "text-xs",
            )}
          >
            Next AFP to issue
          </h3>
          <p className="text-xs text-muted-foreground">
            Forecast bills queued up. Promote on this page to draft the AFP.
          </p>
        </div>
        {variant === "widget" && (
          <Link
            href={`/projects/${projectId}/billing`}
            className="text-xs font-medium text-emerald-700 hover:underline"
          >
            Open billing &rarr;
          </Link>
        )}
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-emerald-500/20">
              <th className="py-1.5 pr-2 text-left font-medium">AFP</th>
              <th className="py-1.5 pr-2 text-left font-medium">Period</th>
              <th className="py-1.5 pr-2 text-left font-medium">Scope</th>
              <th className="py-1.5 pr-2 text-left font-medium">Status</th>
              <th className="py-1.5 pr-2 text-right font-medium">Gross</th>
              <th className="py-1.5 text-right font-medium">Net cash</th>
            </tr>
          </thead>
          <tbody>
            {upcoming.map((a, i) => (
              <tr
                key={`${a.afp}-${a.period}`}
                className={cn(
                  "border-b border-emerald-500/10 last:border-0",
                  i === 0 && "font-semibold",
                )}
              >
                <td className="py-1.5 pr-2">{a.afp}</td>
                <td className="py-1.5 pr-2">{shortMonthLabel(a.period)}</td>
                <td className="py-1.5 pr-2 text-muted-foreground">
                  {a.item ? `${a.item} ` : ""}
                  {a.scope}
                </td>
                <td className="py-1.5 pr-2 text-muted-foreground">
                  {a.status}
                </td>
                <td className="py-1.5 pr-2 text-right">
                  {formatCurrency(a.gross)}
                </td>
                <td className="py-1.5 text-right text-emerald-700">
                  {formatCurrency(a.netCash)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
