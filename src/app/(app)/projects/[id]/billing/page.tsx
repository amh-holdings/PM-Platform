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

import { Button } from "@/components/ui/button";

import { BillingLinkForm } from "../billing-link-form";
import { BillingPoLinkForm } from "../billing-po-link-form";
import { BillingLineDialog } from "./billing-line-dialog";
import { BillingLineRowActions } from "./billing-line-row-actions";
import { SovImportDialog } from "./sov-import-dialog";
import { BillThisPeriodPanel } from "./bill-this-period-panel";
import { BillingPeriodSelector } from "./billing-period-selector";
import { LinkCatalogProvider, type TaskOption } from "./link-catalog";
import { periodEndOf, periodLabel } from "@/lib/billing-period";
import { effectiveLineProgress } from "@/lib/sov-amendments";
import { readAmendments } from "@/lib/sov-amendments-db";
import { resolveBillingPeriod } from "@/lib/billing-period-resolve";

type Params = { id: string };

/**
 * Tint for the two columns that hold money actually billed: Previous billed
 * and Current bill.
 *
 * Neutral on purpose. Everything else coloured on this table means something -
 * amber for a forecast with nothing behind it, emerald for a line at 100%,
 * destructive for one billed past its value - so a green or red band here
 * would read as a verdict on the numbers rather than as "these two belong
 * together". Slate says grouping and nothing else.
 */
const BILLED_COL = "bg-slate-100/70 dark:bg-slate-800/40";

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
    { data: changeOrders },
  ] = await Promise.all([
    supabase
      .from("billing_lines")
      .select(
        "id, item_number, type, description, scheduled_value, linked_task_wbs_codes, linked_procurement_order_ids, sort_order, change_order_id, notes",
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
    // Only so an edit or a delete can say which CO owns a line by name rather
    // than by uuid.
    supabase
      .from("change_orders")
      .select("id, co_number")
      .eq("project_id", params.id),
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

  // Inputs for the line editor. Types already in use become the autocomplete
  // on the Type field, so a hand-added line does not invent "Sitework" beside
  // the existing "Site Work".
  const coNumberById = new Map(
    (changeOrders ?? []).map((c) => [c.id, c.co_number]),
  );

  // Change orders that raised the price of a line already on the sheet. With
  // no allocations - and before 0054 is applied - every rollup reports the
  // line's own scheduled value, so the page reads exactly as it did before.
  const amendments = await readAmendments(supabase, params.id);
  const coNumberByLineId = new Map<string, string>();
  for (const l of lines ?? []) {
    const n = l.change_order_id ? coNumberById.get(l.change_order_id) : null;
    if (n) coNumberByLineId.set(l.id, n);
  }
  const rollups = effectiveLineProgress(
    (lines ?? []).map((l) => ({
      id: l.id,
      itemNumber: l.item_number,
      description: l.description,
      scheduledValue: Number(l.scheduled_value ?? 0),
      changeOrderId: l.change_order_id,
    })),
    amendments.rows,
    periodByLine,
    coNumberByLineId,
  );

  /**
   * Whether ANY line on this project has been touched by a change order
   * allocation. The Original column only exists when there is something to
   * compare against - on a project with no allocations it would be a tenth
   * column repeating the ninth, and this table is already wide enough to get
   * squeezed on a laptop.
   */
  let anyAmended = false;
  rollups.forEach((r) => {
    if (r.amendedValue !== 0 || r.allocatedAway !== 0) anyAmended = true;
  });

  const footerOriginal = rows.reduce(
    (acc, r) => acc + Number(r.scheduled_value ?? 0),
    0,
  );

  /**
   * Scope and billing after allocations, for one line.
   *
   * An allocation moves both halves together, so a caller must never take
   * scope from here and billing from `periodByLine` - that pairing is what
   * makes a line read 226% complete. See src/lib/sov-amendments.ts.
   */
  const effectiveOf = (id: string, scheduledValue: number) => {
    const hit = rollups.get(id);
    if (hit) return hit;
    // Unreachable today - the rollup is built from these same rows - but the
    // fallback must be the line's OWN figures, never zeros. A default of zero
    // billing would erase real money off the page the day this stops holding.
    const p = periodByLine.get(id) ?? emptyLineBillingSummary();
    return {
      contractValue: scheduledValue,
      amendedValue: 0,
      allocatedAway: 0,
      allocatedToCount: 0,
      scope: scheduledValue,
      previous: p.previous,
      current: p.current,
      billed: p.previous + p.current,
      currentBilled: p.currentBilled,
      stalePrior: p.stalePrior,
      sources: [],
    };
  };
  const knownTypes = Array.from(
    new Set(rows.map((r) => (r.type ?? "").trim()).filter(Boolean)),
  ).sort();
  const existingForImport = rows.map((r) => {
    const p = periodByLine.get(r.id) ?? emptyLineBillingSummary();
    return {
      id: r.id,
      item_number: r.item_number,
      type: r.type,
      description: r.description,
      scheduled_value: r.scheduled_value === null ? null : Number(r.scheduled_value),
      sort_order: r.sort_order,
      notes: r.notes,
      change_order_id: r.change_order_id,
      // Same previous + current the table's % complete column runs on, so the
      // import warns on exactly the lines the page would show over 100%.
      billed_to_date: p.previous + p.current,
    };
  });

  const footer = rows.reduce(
    (acc, r) => {
      // Totals run on the SAME rolled-up figures as the rows. Summing raw
      // scheduled values here while the rows show current scope would leave a
      // footer that does not add up its own column. The roll-up is
      // conservative by construction - it only ever moves money between
      // lines - so this total still equals the SOV total.
      const e = effectiveOf(r.id, Number(r.scheduled_value ?? 0));
      acc.scheduled += e.scope;
      acc.previous += e.previous;
      acc.current += e.current;
      acc.remaining += remainingToFinish(
        { previous: e.previous, current: e.current, currentBilled: e.currentBilled, stalePrior: e.stalePrior },
        e.scope,
      );
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-2xl text-xs text-muted-foreground">
            Owner billing lines - the schedule of values the G703 bills against.
            Add them by hand or import the spreadsheet, then link schedule tasks
            per line so the dashboard can auto-suggest next-month billing.
          </p>
          <div className="flex shrink-0 gap-2">
            <SovImportDialog
              projectId={params.id}
              existing={existingForImport}
              trigger={<Button variant="outline">Import spreadsheet</Button>}
            />
            <BillingLineDialog
              projectId={params.id}
              knownTypes={knownTypes}
              trigger={<Button>Add SOV line</Button>}
            />
          </div>
        </div>

        <UnlinkedSovBanner rows={rows} />

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
                {anyAmended && (
                  <th className="px-3 py-2 text-right font-medium">
                    Original
                    <span className="block text-[10px] font-normal normal-case text-muted-foreground/70">
                      before change orders
                    </span>
                  </th>
                )}
                <th className="px-3 py-2 text-right font-medium">
                  Scheduled
                  {anyAmended && (
                    <span className="block text-[10px] font-normal normal-case text-muted-foreground/70">
                      after change orders
                    </span>
                  )}
                </th>
                <th className={cn("px-3 py-2 text-right font-medium", BILLED_COL)}>
                  Previous billed
                  <span className="block text-[10px] font-normal normal-case text-muted-foreground/70">
                    thru {priorPeriodLabel(period)}
                  </span>
                </th>
                <th className={cn("px-3 py-2 text-right font-medium", BILLED_COL)}>
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
                <th className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t = totalsById.get(r.id) ?? { planned: 0 };
                // Current scope and the billing that belongs to it, taken
                // together. A line a change order raised reads as finished the
                // moment its ORIGINAL value is billed, which is how POI 5.05
                // showed 100% on a job that was 71% done.
                const contractValue = Number(r.scheduled_value ?? 0);
                const eff = effectiveOf(r.id, contractValue);
                const p = {
                  previous: eff.previous,
                  current: eff.current,
                  currentBilled: eff.currentBilled,
                  stalePrior: eff.stalePrior,
                };
                const scheduled = eff.scope;
                const amended = eff.amendedValue;
                const allocatedAway = eff.allocatedAway;
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
                    {anyAmended && (
                      <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                        {formatCurrency(contractValue)}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {formatCurrency(scheduled)}
                      {/* The two columns show the arithmetic, so the note only
                          has to name WHICH change order - the part a column
                          cannot carry. */}
                      {amended !== 0 && (
                        <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
                          {eff.sources.map((src) => (
                            <span key={src.amendmentLineId} className="block">
                              {src.amount < 0 ? "-" : "+"}
                              {formatCurrency(Math.abs(src.amount))} from{" "}
                              {src.coNumber ?? `item ${src.itemNumber}`}
                            </span>
                          ))}
                        </span>
                      )}
                      {allocatedAway !== 0 && (
                        <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
                          {formatCurrency(Math.abs(allocatedAway))} moved into{" "}
                          {eff.allocatedToCount} contract line
                          {eff.allocatedToCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    <td
                      className={cn("px-3 py-2 text-right font-mono text-xs", BILLED_COL)}
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
                        BILLED_COL,
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
                    <td className="px-3 py-2 text-right">
                      <BillingLineRowActions
                        projectId={params.id}
                        knownTypes={knownTypes}
                        line={{
                          id: r.id,
                          item_number: r.item_number,
                          type: r.type,
                          description: r.description,
                          scheduled_value: scheduled,
                          sort_order: r.sort_order,
                          notes: r.notes,
                          coNumber: r.change_order_id
                            ? (coNumberById.get(r.change_order_id) ?? null)
                            : null,
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-10 text-center">
                    <p className="text-sm font-medium">
                      No schedule of values yet
                    </p>
                    <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                      Import the SOV out of the cash-flow workbook, or add the
                      lines one at a time. Either way you can edit them here
                      afterwards.
                    </p>
                    <div className="mt-4 flex justify-center gap-2">
                      <SovImportDialog
                        projectId={params.id}
                        existing={existingForImport}
                        trigger={
                          <Button variant="outline">Import spreadsheet</Button>
                        }
                      />
                      <BillingLineDialog
                        projectId={params.id}
                        knownTypes={knownTypes}
                        trigger={<Button>Add SOV line</Button>}
                      />
                    </div>
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
                  {anyAmended && (
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      {formatCurrency(footerOriginal)}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(footer.scheduled)}
                  </td>
                  <td className={cn("px-3 py-2 text-right font-mono", BILLED_COL)}>
                    {formatCurrency(footer.previous)}
                  </td>
                  <td className={cn("px-3 py-2 text-right font-mono", BILLED_COL)}>
                    {formatCurrency(footer.current)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatPct(footerPct)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(footer.remaining)}
                  </td>
                  <td className="px-3 py-2" />
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

// Unlinked lines are the difference between a schedule of values and a working
// one: nothing measures their progress, so they never appear in a billing
// suggestion and never reach the cash forecast. That is invisible if the only
// sign of it is a grey caption repeated down a column, which is how Sussexx sat
// with all nine lines unlinked without anyone noticing.
function UnlinkedSovBanner({
  rows,
}: {
  rows: { item_number: string; linked_task_wbs_codes: string[] | null; description: string | null; type: string | null }[];
}) {
  const unlinked = rows.filter(
    (r) =>
      !isProcurementLine({ type: r.type, description: r.description }) &&
      !(r.linked_task_wbs_codes ?? []).length,
  );
  if (!unlinked.length) return null;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-medium">
        {unlinked.length} of {rows.length} billing line
        {rows.length === 1 ? "" : "s"} {unlinked.length === 1 ? "is" : "are"} not
        linked to the schedule.
      </p>
      <p className="mt-1 text-xs">
        A line with no linked task has nothing to measure its progress against,
        so it never appears in a billing suggestion and never reaches the cash
        forecast. Use <span className="font-medium">Link schedule task</span> on
        each row below.
      </p>
      <p className="mt-1.5 font-mono text-xs">
        {unlinked.slice(0, 20).map((r) => r.item_number).join(", ")}
        {unlinked.length > 20 ? ", ..." : ""}
      </p>
    </div>
  );
}
