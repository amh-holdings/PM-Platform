import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

import { SubFormDialog } from "./sub-form-dialog";
import { SubList } from "./sub-list";

type Props = {
  projectId: string;
};

export async function SubcontractorsSection({ projectId }: Props) {
  const supabase = createClient();
  const { data: subs, error } = await supabase
    .from("subcontractors")
    .select(
      "id, company_name, trade, contact_name, contact_email, contact_phone, contract_value, retainage_pct, coi_status, w9_status, payment_terms, active",
    )
    .eq("project_id", projectId)
    .order("active", { ascending: false })
    .order("company_name", { ascending: true });

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Subcontractors</h2>
          <p className="text-xs text-muted-foreground">
            Roster of subs on this project. Tracks contract value, COI, and W9
            compliance.
          </p>
        </div>
        <SubFormDialog
          projectId={projectId}
          trigger={<Button>Add subcontractor</Button>}
        />
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load subcontractors: {error.message}
        </div>
      ) : (
        <SubList projectId={projectId} subs={subs ?? []} />
      )}
    </section>
  );
}
