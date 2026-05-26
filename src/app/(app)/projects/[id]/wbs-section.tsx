import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

import { WbsFormDialog } from "./wbs-form-dialog";
import { WbsList } from "./wbs-list";

type Props = {
  projectId: string;
};

export async function WbsSection({ projectId }: Props) {
  const supabase = createClient();

  const [{ data: items, error }, { data: subs }] = await Promise.all([
    supabase
      .from("wbs_sov")
      .select(
        "id, wbs_code, description, trade, subcontractor_id, contract_value, pct_complete_sub, pct_complete_ahc, retainage_pct, billed_to_date",
      )
      .eq("project_id", projectId)
      .order("wbs_code", { ascending: true }),
    supabase
      .from("subcontractors")
      .select("id, company_name")
      .eq("project_id", projectId)
      .eq("active", true)
      .order("company_name"),
  ]);

  const subOptions = (subs ?? []).map((s) => ({ id: s.id, company_name: s.company_name }));
  const subById: Record<string, string> = {};
  for (const s of subOptions) subById[s.id] = s.company_name;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">WBS / SOV</h2>
          <p className="text-xs text-muted-foreground">
            Schedule of Values line items. Tracks contract value, % complete,
            and billed-to-date per line.
          </p>
        </div>
        <WbsFormDialog
          projectId={projectId}
          subs={subOptions}
          trigger={<Button>Add line item</Button>}
        />
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load WBS items: {error.message}
        </div>
      ) : (
        <WbsList
          projectId={projectId}
          items={items ?? []}
          subs={subOptions}
          subById={subById}
        />
      )}
    </section>
  );
}
