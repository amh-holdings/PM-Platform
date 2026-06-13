import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

import { BillingLinkForm } from "../billing-link-form";
import { BillThisPeriodPanel } from "./bill-this-period-panel";

type Params = { id: string };

export default async function ProjectBillingPage({ params }: { params: Params }) {
  const supabase = createClient();

  const [{ data: lines, error: linesErr }, { data: totals }] = await Promise.all([
    supabase
      .from("billing_lines")
      .select(
        "id, item_number, type, description, scheduled_value, linked_task_wbs_codes, sort_order, change_order_id",
      )
      .eq("project_id", params.id)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("item_number", { ascending: true }),
    supabase
      .from("v_billing_line_totals")
      .select("billing_line_id, total_billed, total_planned, remaining_to_bill")
      .eq("project_id", params.id),
  ]);

  if (linesErr) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load billing lines: {linesErr.message}
      </div>
    );
  }

  const totalsById = new Map<string, { billed: number; planned: number; remaining: number }>();
  for (const t of totals ?? []) {
    if (!t.billing_line_id) continue;
    totalsById.set(t.billing_line_id, {
      billed: Number(t.total_billed ?? 0),
      planned: Number(t.total_planned ?? 0),
      remaining: Number(t.remaining_to_bill ?? 0),
    });
  }

  const rows = lines ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Billing schedule</h2>
        <p className="text-xs text-muted-foreground">
          Owner billing lines from the cash flow spreadsheet. Link schedule
          tasks per line so the dashboard can auto-suggest next-month billing.
        </p>
      </div>

      <BillThisPeriodPanel projectId={params.id} variant="page" />

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">Item</th>
              <th className="px-3 py-2 text-left font-medium">Type</th>
              <th className="px-3 py-2 text-left font-medium">Description</th>
              <th className="px-3 py-2 text-right font-medium">Scheduled</th>
              <th className="px-3 py-2 text-right font-medium">Billed</th>
              <th className="px-3 py-2 text-right font-medium">Planned</th>
              <th className="px-3 py-2 text-right font-medium">Remaining</th>
              <th className="px-3 py-2 text-left font-medium">Linked tasks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const t = totalsById.get(r.id) ?? {
                billed: 0,
                planned: 0,
                remaining: Number(r.scheduled_value ?? 0),
              };
              const links = r.linked_task_wbs_codes ?? [];
              const isOver = t.remaining < 0;
              const fullyBilled =
                Number(r.scheduled_value ?? 0) > 0 && t.billed >= Number(r.scheduled_value ?? 0);
              return (
                <tr
                  key={r.id}
                  className="border-b last:border-0 align-top"
                >
                  <td className="px-3 py-2 font-mono text-xs">{r.item_number}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.type ?? "-"}
                  </td>
                  <td className="px-3 py-2">{r.description}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatCurrency(Number(r.scheduled_value ?? 0))}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right font-mono text-xs",
                      fullyBilled && "text-emerald-600",
                    )}
                  >
                    {formatCurrency(t.billed)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatCurrency(t.planned)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right font-mono text-xs",
                      isOver && "text-destructive",
                    )}
                  >
                    {formatCurrency(t.remaining)}
                  </td>
                  <td className="px-3 py-2">
                    <BillingLinkForm
                      billingLineId={r.id}
                      projectId={params.id}
                      itemNumber={r.item_number}
                      description={r.description}
                      initialCodes={links}
                    />
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-6 text-center text-xs text-muted-foreground"
                >
                  No billing lines. Run the cash flow importer to populate.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
