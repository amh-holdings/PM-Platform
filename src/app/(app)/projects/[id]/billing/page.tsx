import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

import { isProcurementLine } from "@/lib/progress";
import { guardCapability } from "@/lib/roles-server";
import {
  completionPct,
  emptyLineBillingSummary,
  formatPct,
  remainingToFinish,
  summarizeLineBilling,
} from "@/lib/billing-progress";

import { BillingLinkForm } from "../billing-link-form";
import { BillingPoLinkForm } from "../billing-po-link-form";
import { BillThisPeriodPanel } from "./bill-this-period-panel";
import { BillingPeriodSelector } from "./billing-period-selector";
import { LinkCatalogProvider, type TaskOption } from "./link-catalog";
import { periodEndOf, periodLabel } from "@/lib/billing-period";
import { resolveBillingPeriod } from "@/lib/billing-period-resolve";

type Params = { id: string };

/** "thru Jul 2026" - the month before the one being billed. */
function priorPeriodLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return periodLabel(
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`,
  );
}

export default async function ProjectBillingPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: { period?: string };
}) {
  await guardCapability("viewBilling");
  const supabase = createClient();

  // Not the calendar month - the month the next AFP covers. See
  // resolveBillingPeriod.
  const period =
    searchParams?.period ?? (await resolveBillingPeriod(supabase, params.id));
  const periodEnd = periodEndOf(period);

  const [
    { data: lines, error: linesErr },
    { data: totals },
    { data: pos },
    { data: entries },
    { data: tasks },
  ] = await Promise.all([
    supabase
      .from("billing_lines")
      .select(
        "id, item_number, type, description, scheduled_value, linked_task_wbs_codes, linked_procurement_order_ids, sort_order, change_order_id",
      )
      .eq("project_id", params.id)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("item_number", { ascending: true }),
    supabase
      .from("v_billing_line_totals")
      .select("billing_line_id, total_planned")
      .eq("project_id", params.id),
    supabase
      .from("procurement_orders")
      .select("id, po_number, vendor_name, total_value, status")
      .eq("project_id", params.id)
      .order("po_number"),
    // Previous / current billing is bucketed per line in the app rather than
    // read off v_billing_line_totals, because that view has no notion of a
    // period - it only knows lifetime totals.
    supabase
      .from("billing_entries")
      .select(
        "billing_line_id, period_month, actual_amount, planned_amount, pay_application_id, afp_number, status, billing_lines!inner(project_id)",
      )
      .eq("billing_lines.project_id", params.id),
    supabase
      .from("schedule_tasks")
      .select("wbs_code, task_name, status, pct_complete, parent_wbs_code, sort_order")
      .eq("project_id", params.id)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("wbs_code", { ascending: true }),
  ]);

  const availablePos = (pos ?? []).map((p) => ({
    id: p.id,
    poNumber: p.po_number,
    vendorName: p.vendor_name,
    totalValue: Number(p.total_value ?? 0),
    status: p.status,
  }));

  if (linesErr) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load billing lines: {linesErr.message}
      </div>
    );
  }

  // A parent WBS code carries no measured work of its own - its percent is a
  // rollup, and computeBillingSuggestions refuses to bill off one (see
  // summaryWbsCodes in billing-actions.ts). Same definition here so the
  // autocomplete can warn before the link is made rather than after.
  const summaryCodes = new Set<string>();
  for (const t of tasks ?? []) {
    if (t.parent_wbs_code) summaryCodes.add(t.parent_wbs_code);
  }
  const taskOptions: TaskOption[] = (tasks ?? []).map((t) => ({
    wbsCode: t.wbs_code,
    taskName: t.task_name,
    status: t.status,
    pctComplete: t.pct_complete === null ? null : Number(t.pct_complete),
    isSummary: summaryCodes.has(t.wbs_code),
  }));

  // Only the lifetime forecast is read off the view now. Billed, remaining and
  // percent complete are all bucketed against the selected period below - the
  // view has no notion of one.
  const totalsById = new Map<string, { planned: number }>();
  for (const t of totals ?? []) {
    if (!t.billing_line_id) continue;
    totalsById.set(t.billing_line_id, { planned: Number(t.total_planned ?? 0) });
  }

  const periodByLine = summarizeLineBilling(entries ?? [], period, periodEnd);

  const rows = lines ?? [];
  const footer = rows.reduce(
    (acc, r) => {
      const p = periodByLine.get(r.id) ?? emptyLineBillingSummary();
      acc.scheduled += Number(r.scheduled_value ?? 0);
      acc.previous += p.previous;
      acc.current += p.current;
      acc.remaining += remainingToFinish(p, Number(r.scheduled_value ?? 0));
      return acc;
    },
    { scheduled: 0, previous: 0, current: 0, remaining: 0 },
  );
  const footerPct =
    footer.scheduled > 0
      ? Math.min(100, ((footer.previous + footer.current) / footer.scheduled) * 100)
      : 0;

  return (
    <LinkCatalogProvider tasks={taskOptions} pos={availablePos}>
      <div className="space-y-6">
        <div>
          <p className="text-xs text-muted-foreground">
            Owner billing lines from the cash flow spreadsheet. Link schedule
            tasks per line so the dashboard can auto-suggest next-month billing.
          </p>
        </div>

        <BillingPeriodSelector projectId={params.id} selected={period} />
        <BillThisPeriodPanel
          projectId={params.id}
          variant="page"
          periodMonth={period}
        />

        <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 text-left font-medium">Item</th>
                <th className="px-3 py-2 text-left font-medium">Type</th>
                <th className="px-3 py-2 text-left font-medium">
                  Description / links
                </th>
                <th className="px-3 py-2 text-right font-medium">Scheduled</th>
                <th className="px-3 py-2 text-right font-medium">
                  Previous billed
                  <span className="block text-[10px] font-normal normal-case text-muted-foreground/70">
                    thru {priorPeriodLabel(period)}
                  </span>
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  Current bill
                  <span className="block text-[10px] font-normal normal-case text-muted-foreground/70">
                    {periodLabel(period)}
                  </span>
                </th>
                <th className="px-3 py-2 text-right font-medium">% Complete</th>
                <th className="px-3 py-2 text-right font-medium">
                  Remaining
                  <span className="block text-[10px] font-normal normal-case text-muted-foreground/70">
                    balance to finish
                  </span>
                </th>
                <th className="px-3 py-2 text-right font-medium">Planned</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t = totalsById.get(r.id) ?? { planned: 0 };
                const p = periodByLine.get(r.id) ?? emptyLineBillingSummary();
                const scheduled = Number(r.scheduled_value ?? 0);
                const pct = completionPct(p, scheduled);
                const links = r.linked_task_wbs_codes ?? [];
                // Balance to finish is measured through this period, not over
                // the line's lifetime. A lifetime remaining next to a
                // through-this-period percent contradicts itself: SOV 6.02 read
                // 0% complete in July while its August billing had already come
                // off the balance.
                const remaining = remainingToFinish(p, scheduled);
                const isOver = remaining < 0;
                const fullyBilled = scheduled > 0 && remaining <= 0;
                const currentPending = p.current - p.currentBilled;
                return (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{r.item_number}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.type ?? "-"}
                    </td>
                    <td className="px-3 py-2">
                      <div>{r.description}</div>
                      <div className="mt-1">
                        {isProcurementLine({
                          type: r.type,
                          description: r.description,
                        }) ? (
                          <BillingPoLinkForm
                            billingLineId={r.id}
                            projectId={params.id}
                            itemNumber={r.item_number}
                            description={r.description}
                            initialPoIds={
                              (r as unknown as {
                                linked_procurement_order_ids: string[] | null;
                              }).linked_procurement_order_ids ?? []
                            }
                          />
                        ) : (
                          <BillingLinkForm
                            billingLineId={r.id}
                            projectId={params.id}
                            itemNumber={r.item_number}
                            description={r.description}
                            initialCodes={links}
                          />
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {formatCurrency(scheduled)}
                    </td>
                    <td
                      className="px-3 py-2 text-right font-mono text-xs"
                      title={
                        p.stalePrior > 0
                          ? `${formatCurrency(
                              p.stalePrior,
                            )} sits in earlier months as forecast only - no AFP or pay app behind it, so it is not counted as billed.`
                          : undefined
                      }
                    >
                      {formatCurrency(p.previous)}
                      {p.stalePrior > 0 && (
                        <span className="ml-1 text-amber-600">*</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-mono text-xs",
                        p.current > 0 && "font-medium text-foreground",
                      )}
                      title={
                        currentPending > 0
                          ? `${formatCurrency(
                              currentPending,
                            )} of this is still a forecast - it bills once it lands on an AFP.`
                          : undefined
                      }
                    >
                      {p.current > 0 ? formatCurrency(p.current) : "-"}
                      {currentPending > 0 && (
                        <span className="ml-1 text-muted-foreground">*</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div
                        className={cn(
                          "font-mono text-xs",
                          pct >= 100 && "text-emerald-600",
                        )}
                        title="Billed through this period divided by the scheduled value."
                      >
                        {scheduled > 0 ? formatPct(pct) : "-"}
                      </div>
                      {scheduled > 0 && (
                        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              pct >= 100 ? "bg-emerald-500" : "bg-sky-500",
                            )}
                            style={{ width: `${Math.max(pct, 0)}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-mono text-xs",
                        isOver && "text-destructive",
                        fullyBilled && !isOver && "text-emerald-600",
                      )}
                    >
                      {formatCurrency(remaining)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                      {formatCurrency(t.planned)}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-6 text-center text-xs text-muted-foreground"
                  >
                    No billing lines. Run the cash flow importer to populate.
                  </td>
                </tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="border-t bg-muted/40 text-xs font-medium">
                <tr>
                  <td className="px-3 py-2" colSpan={3}>
                    Total
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(footer.scheduled)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(footer.previous)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(footer.current)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatPct(footerPct)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(footer.remaining)}
                  </td>
                  <td className="px-3 py-2" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </LinkCatalogProvider>
  );
}
