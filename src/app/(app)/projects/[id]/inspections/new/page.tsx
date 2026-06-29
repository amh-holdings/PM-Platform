import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { NewInspectionForm } from "./inspection-form";

type Params = { id: string };

export default async function NewInspectionPage({
  params,
}: {
  params: Params;
}) {
  const supabase = createClient();
  const { data: subs } = await supabase
    .from("subcontractors")
    .select("id, company_name")
    .eq("project_id", params.id)
    .order("company_name");

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/inspections`}
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Back to inspections
        </Link>
        <h2 className="mt-1 text-lg font-semibold">New field inspection</h2>
        <p className="text-xs text-muted-foreground">
          Tap the basemap to drop a location pin, then describe what was
          inspected.
        </p>
      </div>
      <NewInspectionForm projectId={params.id} subs={subs ?? []} />
    </div>
  );
}
