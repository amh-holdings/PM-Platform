import Link from "next/link";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";

type Params = { id: string };

const STATUS_TONE: Record<string, string> = {
  active: "bg-amber-100 text-amber-900",
  complete: "bg-emerald-100 text-emerald-900",
  cancelled: "bg-muted text-muted-foreground",
  delivered: "bg-blue-100 text-blue-900",
};

export default async function ProjectProcurementPage({ params }: { params: Params }) {
  const supabase = createClient();

  const [
    { data: orders, error },
    { data: payments },
    { data: lineLinks },
  ] = await Promise.all([
    supabase
      .from("procurement_orders")
      .select(
        "id, vendor_name, po_number, description, total_value, ordered_date, expected_delivery_date, actual_delivery_date, status, payment_terms_summary, signed_at",
      )
      .eq("project_id", params.id)
      .order("ordered_date", { ascending: false, nullsFirst: false })
      .order("vendor_name"),
    supabase
      .from("procurement_payments")
      .select(
        "procurement_order_id, amount, paid_amount, paid_at, expected_date, procurement_orders!inner(project_id)",
      )
      .eq("procurement_orders.project_id", params.id),
    supabase
      .from("billing_lines")
      .select("id, item_number, description, linked_procurement_order_ids")
      .eq("project_id", params.id),
  ]);

  // Reverse-index: PO id -> array of billing_line item numbers that link it.
  const linesByPoId = new Map<string, string[]>();
  for (const l of lineLinks ?? []) {
    const links =
      (l as unknown as { linked_procurement_order_ids: string[] | null })
        .linked_procurement_order_ids ?? [];
    for (const poId of links) {
      if (!linesByPoId.has(poId)) linesByPoId.set(poId, []);
      linesByPoId.get(poId)!.push(l.item_number);
    }
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load procurement: {error.message}
      </div>
    );
  }

  const milestoneByOrder = new Map<
    string,
    { totalPlanned: number; totalPaid: number; nextDue: string | null }
  >();
  for (const m of payments ?? []) {
    const id = m.procurement_order_id;
    if (!milestoneByOrder.has(id))
      milestoneByOrder.set(id, { totalPlanned: 0, totalPaid: 0, nextDue: null });
    const cur = milestoneByOrder.get(id)!;
    cur.totalPlanned += Number(m.amount ?? 0);
    cur.totalPaid += Number(m.paid_amount ?? 0);
    if (!m.paid_at && m.expected_date) {
      if (!cur.nextDue || m.expected_date < cur.nextDue) cur.nextDue = m.expected_date;
    }
  }

  const rows = orders ?? [];
  const totalOrders = rows.length;
  const totalValue = rows.reduce((s, r) => s + Number(r.total_value ?? 0), 0);
  const totalPaid = Array.from(milestoneByOrder.values()).reduce(
    (s, v) => s + v.totalPaid,
    0,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Procurement</h2>
          <p className="text-xs text-muted-foreground">
            Purchase orders for equipment and materials, with milestone payment
            schedules. Each PO drives its own cash-out timeline.
          </p>
        </div>
        <Button asChild>
          <Link href={`/projects/${params.id}/procurement/new`}>
            Add purchase order
          </Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Total POs
          </div>
          <div className="mt-1 text-2xl font-semibold">{totalOrders}</div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {rows.filter((r) => r.signed_at).length} signed,{" "}
            {rows.filter((r) => !r.signed_at && r.status !== "cancelled").length} draft
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Signed (committed)
          </div>
          <div className="mt-1 text-2xl font-semibold text-emerald-700">
            {formatCurrency(
              rows
                .filter((r) => r.signed_at && r.status !== "cancelled")
                .reduce((s, r) => s + Number(r.total_value ?? 0), 0),
            )}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Total committed
          </div>
          <div className="mt-1 text-2xl font-semibold">
            {formatCurrency(totalValue)}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Paid to date
          </div>
          <div className="mt-1 text-2xl font-semibold text-emerald-700">
            {formatCurrency(totalPaid)}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">Vendor / item</th>
              <th className="px-3 py-2 text-left font-medium">PO #</th>
              <th className="px-3 py-2 text-right font-medium">PO value</th>
              <th className="px-3 py-2 text-right font-medium">Paid</th>
              <th className="px-3 py-2 text-left font-medium">% Paid</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Signed</th>
              <th className="px-3 py-2 text-left font-medium">Billing line</th>
              <th className="px-3 py-2 text-left font-medium">Next milestone</th>
              <th className="px-3 py-2 text-left font-medium">Delivery</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const m = milestoneByOrder.get(r.id) ?? {
                totalPaid: 0,
                nextDue: null,
                totalPlanned: 0,
              };
              const poValue = Number(r.total_value ?? 0);
              const pctPaid = poValue > 0 ? (m.totalPaid / poValue) * 100 : 0;
              const linkedLines = linesByPoId.get(r.id) ?? [];
              return (
                <tr
                  key={r.id}
                  className={cn(
                    "border-b last:border-0 hover:bg-muted/30",
                    !r.signed_at && "bg-amber-50/40",
                  )}
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/projects/${params.id}/procurement/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.vendor_name}
                    </Link>
                    {r.description && (
                      <div className="text-xs text-muted-foreground">
                        {r.description}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.po_number ?? "-"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {formatCurrency(poValue)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {formatCurrency(m.totalPaid)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-emerald-500"
                          style={{ width: `${Math.min(100, pctPaid)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {Math.round(pctPaid)}%
                      </span>
                    </div>
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
                  <td className="px-3 py-2 text-xs">
                    {r.signed_at ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                        {new Date(r.signed_at).toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                        Draft
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {linkedLines.length === 0 ? (
                      <span className="italic text-muted-foreground">—</span>
                    ) : (
                      <span className="text-muted-foreground">
                        {linkedLines.join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {m.nextDue ? formatDate(m.nextDue) : "-"}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.actual_delivery_date
                      ? formatDate(r.actual_delivery_date)
                      : r.expected_delivery_date
                        ? `exp ${formatDate(r.expected_delivery_date)}`
                        : "-"}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={10}
                  className="px-3 py-6 text-center text-xs text-muted-foreground"
                >
                  No purchase orders yet. Upload contracts to /documents, then
                  add POs here with their milestone payment schedules.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
