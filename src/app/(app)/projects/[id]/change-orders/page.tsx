import Link from "next/link";

import { NewChangeOrderButton } from "./new-co-button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole, guardCapability } from "@/lib/roles-server";
import { coClient } from "@/lib/database.types.co";
import {
  CO_STATUS_LABELS,
  countsTowardContract,
  type CoStatus,
} from "@/lib/change-order-pricing";

type Params = { id: string };

const STATUS_TONE: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-900",
  submitted: "bg-amber-100 text-amber-900",
  internal_review: "bg-sky-100 text-sky-900",
  rejected: "bg-destructive/10 text-destructive",
  void: "bg-muted text-muted-foreground line-through",
  draft: "bg-muted text-muted-foreground",
};

export default async function ChangeOrdersPage({ params }: { params: Params }) {
  await guardCapability("viewChangeOrders");
  const supabase = createClient();

  // Cost / profit margin columns are Phil-only (viewCosts).
  const { effective } = await getEffectiveRole();
  const showCosts = can(effective, "viewCosts");

  const db = coClient(supabase);
  const [{ data: cos, error }, { data: lines }, { data: costLines }, { data: backups }] =
    await Promise.all([
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
    db
      .from("change_order_cost_lines")
      .select("id, change_order_id")
      .eq("project_id", params.id),
    db
      .from("change_order_attachments")
      .select("change_order_id, cost_line_id")
      .eq("project_id", params.id),
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

  // Only approved change orders have moved the contract. Rolling drafts and
  // rejected COs into the same total was harmless when everything was created
  // as "approved"; with a real workflow it would overstate the contract.
  const approvedRows = rows.filter((r) => countsTowardContract(r.status ?? ""));
  const pendingRows = rows.filter((r) =>
    ["draft", "internal_review", "submitted"].includes(r.status ?? ""),
  );
  const totalCoValue = approvedRows.reduce((s, r) => s + Number(r.co_value ?? 0), 0);
  const totalCost = approvedRows.reduce((s, r) => s + Number(r.cost_amount ?? 0), 0);
  const totalProfit = totalCoValue - totalCost;
  const pendingValue = pendingRows.reduce((s, r) => s + Number(r.co_value ?? 0), 0);
  const approvedCount = approvedRows.length;

  // How much of each CO's priced scope has a quote behind it.
  const linesPerCo = new Map<string, Set<string>>();
  for (const l of costLines ?? []) {
    if (!linesPerCo.has(l.change_order_id)) linesPerCo.set(l.change_order_id, new Set());
    linesPerCo.get(l.change_order_id)!.add(l.id);
  }
  const backedLinesPerCo = new Map<string, Set<string>>();
  for (const a of backups ?? []) {
    if (!a.cost_line_id) continue;
    if (!backedLinesPerCo.has(a.change_order_id))
      backedLinesPerCo.set(a.change_order_id, new Set());
    backedLinesPerCo.get(a.change_order_id)!.add(a.cost_line_id);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            Scope changes to the prime contract. Price each one with a cost buildup,
            attach the quote behind every line, then submit. On approval the CO gets
            its own SOV line and bills on the next AFP.
          </p>
        </div>
        <NewChangeOrderButton projectId={params.id} />
      </div>

      <div className={cn("grid gap-3", showCosts ? "sm:grid-cols-4" : "sm:grid-cols-2")}>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Total COs
          </div>
          <div className="mt-1 text-2xl font-semibold">{rows.length}</div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {approvedCount} approved &middot; {pendingRows.length} in progress
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
            Approved (owner)
          </div>
          <div className="mt-1 text-2xl font-semibold text-emerald-700">
            {formatCurrency(totalCoValue)}
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {pendingValue !== 0
              ? `${formatCurrency(pendingValue)} pending approval`
              : "Nothing pending"}
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
              {showCosts && (
                <th className="px-3 py-2 text-right font-medium">Backup</th>
              )}
              <th className="px-3 py-2 text-right font-medium">SOV lines</th>
              <th className="px-3 py-2 text-right font-medium">Days</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Approved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const lineInfo = linesByCo.get(r.id);
              const costLineCount = linesPerCo.get(r.id)?.size ?? 0;
              const backedCount = backedLinesPerCo.get(r.id)?.size ?? 0;
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
                  {showCosts && (
                    <td className="px-3 py-2 text-right text-xs">
                      {costLineCount === 0 ? (
                        <span className="text-muted-foreground">no buildup</span>
                      ) : (
                        <span
                          className={cn(
                            "inline-flex rounded px-1.5 py-0.5",
                            backedCount === costLineCount
                              ? "bg-emerald-100 text-emerald-900"
                              : "bg-amber-100 text-amber-900",
                          )}
                        >
                          {backedCount}/{costLineCount}
                        </span>
                      )}
                    </td>
                  )}
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
                        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                        STATUS_TONE[r.status ?? ""] ?? "bg-muted",
                      )}
                    >
                      {CO_STATUS_LABELS[r.status as CoStatus] ?? r.status}
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
                <td colSpan={showCosts ? 10 : 7} className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No change orders yet. &quot;New change order&quot; opens a numbered draft ready
                  for its cost buildup.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
