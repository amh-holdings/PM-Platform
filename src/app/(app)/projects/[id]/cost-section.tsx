import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

import { CostCodeFormDialog } from "./cost-form-dialog";
import { CostCodesView } from "./costs/cost-codes-view";
import type { CostTxn } from "./costs/cost-by-month";

type Props = {
  projectId: string;
};

export async function CostCodesSection({ projectId }: Props) {
  const supabase = createClient();
  const { data: codes, error } = await supabase
    .from("cost_codes")
    .select(
      "id, code, name, description, estimated_cost, actual_cost, is_change_order, sort_order, linked_task_wbs_codes, subcontractor_id, procurement_order_id",
    )
    .eq("project_id", projectId)
    .order("is_change_order", { ascending: true })
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("code", { ascending: true });

  // Signed = the subcontract or PO the code points at. Only a PO with a
  // signed date counts: unsigned placeholder POs stand in for buys the
  // forecast expects, not money we are bound to.
  const [{ data: subs }, { data: pos }] = await Promise.all([
    supabase.from("subcontractors").select("id, contract_value, active").eq("project_id", projectId),
    supabase.from("procurement_orders").select("id, total_value, signed_at, status").eq("project_id", projectId),
  ]);
  const signedOf = (c: { subcontractor_id: string | null; procurement_order_id: string | null }) => {
    const sub = (subs ?? []).find((s) => s.id === c.subcontractor_id && s.active !== false);
    const po = (pos ?? []).find((p) => p.id === c.procurement_order_id && p.signed_at && p.status !== "cancelled");
    return Number(sub?.contract_value ?? 0) + Number(po?.total_value ?? 0);
  };
  const rows = (codes ?? []).map((c) => ({ ...c, signed: signedOf(c) }));

  // Month by month, from the monthly QuickBooks sync. Paid totals live in
  // cost_forecasts; the lines behind them, both bases, in cost_transactions
  // (0070). That table is not in the generated types, and a database without
  // it must still render the page, so it is read untyped and any error reads
  // as "not there yet".
  const codeIds = (codes ?? []).map((c) => c.id);
  const { data: forecasts } = codeIds.length
    ? await supabase
        .from("cost_forecasts")
        .select("cost_code_id, period_month, actual_amount")
        .in("cost_code_id", codeIds)
    : { data: [] };
  const paid = (forecasts ?? [])
    .filter((f) => Number(f.actual_amount ?? 0) !== 0)
    .map((f) => ({
      cost_code_id: f.cost_code_id as string,
      month: String(f.period_month).slice(0, 7),
      amount: Number(f.actual_amount),
    }));
  const untyped = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (k: string, v: string) => {
          order: (k: string) => {
            limit: (n: number) => Promise<{ data: CostTxn[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
  const txRes = await untyped
    .from("cost_transactions")
    .select("cost_code_id, basis, txn_date, qb_type, qb_num, vendor, qb_item, paid_from, amount, qb_cutoff")
    .eq("project_id", projectId)
    .order("txn_date")
    .limit(10000);
  const transactions = txRes.error ? null : (txRes.data ?? []);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Cost codes</h2>
          <p className="text-xs text-muted-foreground">
            Internal cost categories for this project. Actual is incurred to
            date from the books (QuickBooks, or IBT for a JV job); open a code
            to see it month by month. Projected over is where a code is headed
            past its estimate - the larger of what is signed and what is
            already incurred. Change orders tracked separately.
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
        <CostCodesView
          projectId={projectId}
          codes={rows}
          paid={paid}
          transactions={transactions}
        />
      )}
    </section>
  );
}
