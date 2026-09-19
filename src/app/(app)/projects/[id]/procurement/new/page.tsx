import Link from "next/link";

import { createClient } from "@/lib/supabase/server";

import { ProcurementForm } from "../procurement-form";

type Params = { id: string };

export default async function NewProcurementPage({ params }: { params: Params }) {
  const supabase = createClient();

  const { data: docs } = await supabase
    .from("project_documents")
    .select("id, file_name, category")
    .eq("project_id", params.id)
    .in("category", ["subcontract", "prime_contract", "amendment", "exhibit", "other"])
    .order("uploaded_at", { ascending: false });

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/procurement`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; Procurement
        </Link>
        <h2 className="mt-1 text-lg font-semibold">Add purchase order</h2>
        <p className="text-xs text-muted-foreground">
          Capture vendor, PO number, and delivery timing, then itemize the
          scope below - one row per line on the vendor quote. Flag shipping
          rows as Freight and they stay out of the deposit basis. Link a
          contract document if you&apos;ve uploaded it to the project. The
          milestone payment schedule lives on the detail page after saving.
        </p>
      </div>

      <ProcurementForm
        projectId={params.id}
        mode="create"
        documents={(docs ?? []).map((d) => ({ id: d.id, label: d.file_name }))}
      />
    </div>
  );
}
