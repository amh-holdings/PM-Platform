import Link from "next/link";
import { notFound } from "next/navigation";

import { guardCapability } from "@/lib/roles-server";
import { subBillingClient } from "@/lib/sub-billing-db";

import { BillEntryForm } from "./bill-entry-form";

type Params = { id: string; subId: string };

export default async function NewSubBillPage({ params }: { params: Params }) {
  await guardCapability("enterSubBill");
  const db = subBillingClient();

  const { data: sub } = await db
    .from("subcontractors")
    .select("id, company_name, retainage_pct, payment_terms_days")
    .eq("id", params.subId)
    .single();
  if (!sub) notFound();

  const [{ data: sovRows }, { data: priorRows }] = await Promise.all([
    db.from("sub_sov_lines").select("*").eq("subcontractor_id", params.subId).eq("active", true).order("sort_order"),
    db
      .from("sub_pay_apps")
      .select("id, app_number, period_end, billed_to_date, retainage_to_date")
      .eq("subcontractor_id", params.subId)
      .order("app_number", { ascending: false })
      .limit(1),
  ]);

  const sovLines = sovRows ?? [];
  const prior = priorRows?.[0] ?? null;

  // Carry the prior application's completed-to-date forward as this bill's
  // "from previous" column. This is the number the sub's own form must match.
  let priorByItem = new Map<string, number>();
  if (prior) {
    const { data } = await db
      .from("sub_pay_app_lines")
      .select("item_number, total_completed")
      .eq("sub_pay_app_id", prior.id);
    priorByItem = new Map((data ?? []).map((l) => [l.item_number, Number(l.total_completed ?? 0)]));
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${params.id}/sub-billing/${params.subId}`}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {sub.company_name}
        </Link>
        <h2 className="text-lg font-semibold">
          Record application #{prior ? prior.app_number + 1 : 1}
        </h2>
        <p className="text-xs text-muted-foreground">
          Enter what the sub billed on each line this period. Completed to date,
          percent, balance and retainage are computed from our SOV and the last
          application, not taken from their form, so any disagreement shows up
          as a failed check instead of overwriting our numbers.
        </p>
      </div>

      <BillEntryForm
        projectId={params.id}
        subId={params.subId}
        appNumber={prior ? prior.app_number + 1 : 1}
        retainagePct={Number(sub.retainage_pct ?? 0)}
        paymentTermsDays={sub.payment_terms_days}
        priorAppNumber={prior?.app_number ?? null}
        priorBilledToDate={Number(prior?.billed_to_date ?? 0)}
        lines={sovLines.map((l) => ({
          item_number: l.item_number,
          section_name: l.section_name,
          description: l.description,
          scheduled_value: Number(l.scheduled_value ?? 0),
          from_previous: priorByItem.get(l.item_number) ?? 0,
        }))}
      />
    </div>
  );
}
