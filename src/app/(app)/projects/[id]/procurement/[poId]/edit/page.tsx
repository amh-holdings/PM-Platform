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

  const [{ data: po }, { data: docs }, { data: lines }] = await Promise.all([
    supabase
      .from("procurement_orders")
      .select(
        "id, vendor_name, po_number, description, total_value, ordered_date, expected_delivery_date, actual_delivery_date, status, payment_terms_summary, document_id, notes",
      )
      .eq("id", params.poId)
      .maybeSingle(),
    supabase
      .from("project_documents")
      .select("id, file_name, category")
      .eq("project_id", params.id)
      .order("uploaded_at", { ascending: false }),
    supabase
      .from("procurement_order_lines")
      .select("description, quantity, unit, unit_price, notes")
      .eq("procurement_order_id", params.poId)
      .order("line_no", { ascending: true }),
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
        initialLines={(lines ?? []).map((l) => ({
          description: l.description,
          quantity: l.quantity == null ? null : Number(l.quantity),
          unit: l.unit,
          unit_price: l.unit_price == null ? null : Number(l.unit_price),
          notes: l.notes,
        }))}
        documents={(docs ?? []).map((d) => ({ id: d.id, label: d.file_name }))}
      />
    </div>
  );
}
