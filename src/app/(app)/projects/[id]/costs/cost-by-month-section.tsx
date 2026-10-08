import { createClient } from "@/lib/supabase/server";

import { CostByMonth, type CostTxn, type MonthCode } from "./cost-by-month";

type Props = {
  projectId: string;
};

// Cost by month per cost code, for audit: every code down the side, every
// month across, and every cell opens to the QuickBooks transactions that make
// it up. Written by the monthly QuickBooks sync (scripts/cashflow/qb-sync.mts):
//
//   paid      cost_forecasts.actual_amount, the cash-basis monthly totals
//   incurred  cost_transactions basis 'accrual', dated when billed
//   the bills cost_transactions (0070)
//
// Without 0070 the paid grid still renders from cost_forecasts; only the
// drill-down and the incurred view wait for the migration.
export async function CostByMonthSection({ projectId }: Props) {
  const supabase = createClient();

  const { data: codes } = await supabase
    .from("cost_codes")
    .select("id, code, name, is_change_order, sort_order")
    .eq("project_id", projectId)
    .order("is_change_order", { ascending: true })
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("code", { ascending: true });

  const codeIds = (codes ?? []).map((c) => c.id);
  const { data: forecasts } = codeIds.length
    ? await supabase
        .from("cost_forecasts")
        .select("cost_code_id, period_month, actual_amount")
        .in("cost_code_id", codeIds)
    : { data: [] };

  // Not in the generated types until 0070 is applied and types regenerate,
  // and a missing table must not take the page down - so untyped, and any
  // error reads as "not applied yet".
  const untyped = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (k: string, v: string) => {
          order: (k: string) => { limit: (n: number) => Promise<{ data: CostTxn[] | null; error: { message: string } | null }> };
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

  const paid = (forecasts ?? [])
    .filter((f) => Number(f.actual_amount ?? 0) !== 0)
    .map((f) => ({
      cost_code_id: f.cost_code_id as string,
      month: String(f.period_month).slice(0, 7),
      amount: Number(f.actual_amount),
    }));

  const codeRows: MonthCode[] = (codes ?? []).map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    isChangeOrder: Boolean(c.is_change_order),
  }));

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Cost by month</h2>
        <p className="text-xs text-muted-foreground">
          Every cost code by month, from the Controller&apos;s QuickBooks
          export. Click a month to see the bills, checks and card charges
          behind it.
        </p>
      </div>
      <CostByMonth codes={codeRows} paid={paid} transactions={transactions} />
    </section>
  );
}
