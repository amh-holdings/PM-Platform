import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { ProcurementForm } from "../../procurement-form";

type Params = { id: string; poId: string };

export default async function EditProcurementPage({
  params,
}: {
  params: Params;
}) {
  const supabase = createClient();

  const [{ data: po }, { data: items }, { data: docs }] = await Promise.all([
    supabase
      .from("procurement_orders")
      .select(
        "id, vendor_name, po_number, description, total_value, ordered_date, expected_delivery_date, actual_delivery_date, status, payment_terms_summary, document_id, notes",
      )
      .eq("id", params.poId)
      .maybeSingle(),
    supabase
      .from("procurement_order_items")
      .select(
        "id, sort_order, item_number, description, quantity, unit, unit_price, is_freight, notes",
      )
      .eq("procurement_order_id", params.poId)
      .order("sort_order", { ascending: true, nullsFirst: false }),
    supabase
      .from("project_documents")
      .select("id, file_name, category")
      .eq("project_id", params.id)
      .order("uploaded_at", { ascending: false }),
  ]);

  if (!po) notFound();

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/procurement/${params.poId}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; {po.vendor_name}
        </Link>
        <h2 className="mt-1 text-lg font-semibold">Edit purchase order</h2>
      </div>

      <ProcurementForm
        projectId={params.id}
        mode="edit"
        initial={po}
        initialItems={(items ?? []).map((i) => ({
          id: i.id,
          item_number: i.item_number ?? "",
          description: i.description,
          quantity: String(i.quantity ?? 1),
          unit: i.unit ?? "",
          unit_price: String(i.unit_price ?? 0),
          is_freight: i.is_freight === true,
          notes: i.notes ?? "",
        }))}
        documents={(docs ?? []).map((d) => ({ id: d.id, label: d.file_name }))}
      />
    </div>
  );
}
