import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

import { CostCodeFormDialog } from "./cost-form-dialog";
import { CostCodeList } from "./cost-list";

type Props = {
  projectId: string;
};

export async function CostCodesSection({ projectId }: Props) {
  const supabase = createClient();
  const { data: codes, error } = await supabase
    .from("cost_codes")
    .select(
      "id, code, name, description, estimated_cost, actual_cost, is_change_order, sort_order",
    )
    .eq("project_id", projectId)
    .order("is_change_order", { ascending: true })
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("code", { ascending: true });

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Cost codes</h2>
          <p className="text-xs text-muted-foreground">
            AHC&apos;s internal cost categories for this project. Estimated vs
            actual spend. Change orders tracked separately.
          </p>
        </div>
        <CostCodeFormDialog
          projectId={projectId}
          trigger={<Button>Add cost code</Button>}
        />
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load cost codes: {error.message}
        </div>
      ) : (
        <CostCodeList projectId={projectId} codes={codes ?? []} />
      )}
    </section>
  );
}
