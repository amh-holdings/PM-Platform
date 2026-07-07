import Link from "next/link";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole } from "@/lib/roles-server";

type Params = { id: string };

const STATUS_TONE: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-900",
  submitted: "bg-amber-100 text-amber-900",
  rejected: "bg-destructive/10 text-destructive",
  draft: "bg-muted text-muted-foreground",
};

export default async function ChangeOrdersPage({ params }: { params: Params }) {
  const supabase = createClient();

  // The CM sees change orders but not AHC's internal cost / profit margin -
  // only the owner-facing billable value. Phil (viewCosts) sees everything.
  const { effective } = await getEffectiveRole();
  const showCosts = can(effective, "viewCosts");

  const [{ data: cos, error }, { data: lines }] = await Promise.all([
    supabase
      .from("change_orders")
      .select(
        "id, co_number, description, co_value, cost_amount, profit_pct, schedule_impact_days, status, submitted_at, approved_at",
      )
      .eq("project_id", params.id)
      .order("co_number"),
    supabase
      .from("billing_lines")
      .select("change_order_id, scheduled_value")
      .eq("project_id", params.id)
      .not("change_order_id", "is", null),
  ]);

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load change orders: {error.message}
      </div>
    );
  }

  // Roll up: SOV-line count + total scheduled value per CO
  const linesByCo = new Map<string, { count: number; total: number }>();
  for (const l of lines ?? []) {
    if (!l.change_order_id) continue;
    if (!linesByCo.has(l.change_order_id))
      linesByCo.set(l.change_order_id, { count: 0, total: 0 });
    const c = linesByCo.get(l.change_order_id)!;
    c.count += 1;
    c.total += Number(l.scheduled_value ?? 0);
  }

  const rows = cos ?? [];
  const totalCoValue = rows.reduce((s, r) => s + Number(r.co_value ?? 0), 0);
  const totalCost = rows.reduce((s, r) => s + Number(r.cost_amount ?? 0), 0);
  const totalProfit = totalCoValue - totalCost;
  const approvedCount = rows.filter((r) => r.status === "approved").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Change orders</h2>
          <p className="text-xs text-muted-foreground">
            Approved scope changes to the prime contract. Each CO can carry
            one or more SOV line items that get billed on subsequent AFPs.
          </p>
        </div>
        <Button asChild>
          <Link href={`/projects/${params.id}/change-orders/new`}>
            New change order
          </Link>
        </Button>
      </div>

      <div className={cn("grid gap-3", showCosts ? "sm:grid-cols-4" : "sm:grid-cols-2")}>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Total COs
          </div>
          <div className="mt-1 text-2xl font-semibold">{rows.length}</div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {approvedCount} approved
          </div>
        </div>
        {showCosts && (
          <div className="rounded-md border bg-card p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Total cost (AHC)
            </div>
            <div className="mt-1 text-2xl font-semibold">
              {formatCurrency(totalCost)}
            </div>
          </div>
        )}
        {showCosts && (
          <div className="rounded-md border bg-card p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Total profit
            </div>
            <div className="mt-1 text-2xl font-semibold text-emerald-700">
              {formatCurrency(totalProfit)}
            </div>
          </div>
        )}
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Total billable (owner)
          </div>
          <div className="mt-1 text-2xl font-semibold text-emerald-700">
            {formatCurrency(totalCoValue)}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">CO #</th>
              <th className="px-3 py-2 text-left font-medium">Description</th>
              {showCosts && (
                <th className="px-3 py-2 text-right font-medium">Cost</th>
              )}
              {showCosts && (
                <th className="px-3 py-2 text-right font-medium">Profit %</th>
              )}
              <th className="px-3 py-2 text-right font-medium">Billable</th>
              <th className="px-3 py-2 text-right font-medium">SOV lines</th>
              <th className="px-3 py-2 text-right font-medium">Days</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Approved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const lineInfo = linesByCo.get(r.id);
              return (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2 font-mono font-medium">
                    <Link
                      href={`/projects/${params.id}/change-orders/${r.id}`}
                      className="hover:underline"
                    >
                      {r.co_number}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className="line-clamp-2">{r.description ?? "-"}</span>
                  </td>
                  {showCosts && (
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                      {r.cost_amount != null ? formatCurrency(Number(r.cost_amount)) : "-"}
                    </td>
                  )}
                  {showCosts && (
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                      {r.profit_pct != null ? `${Number(r.profit_pct)}%` : "-"}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold">
                    {formatCurrency(Number(r.co_value ?? 0))}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {lineInfo
                      ? `${lineInfo.count} (${formatCurrency(lineInfo.total)})`
                      : "0"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {r.schedule_impact_days ?? "-"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        STATUS_TONE[r.status ?? ""] ?? "bg-muted",
                      )}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.approved_at ? formatDate(r.approved_at) : "-"}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={showCosts ? 9 : 7} className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No change orders yet. Click &quot;New change order&quot; to add the first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
