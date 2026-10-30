import Link from "next/link";
import { notFound } from "next/navigation";

import { guardCapability } from "@/lib/roles-server";
import { newestLiveApp, nextAppNumber, replacesRejected } from "@/lib/sub-app-numbering";
import { subBillingClient } from "@/lib/sub-billing-db";

import { BillEntryForm } from "./bill-entry-form";

type Params = { id: string; subId: string };

export default async function NewSubBillPage({ params }: { params: Params }) {
  await guardCapability("enterSubBill");
  const db = subBillingClient();

  const { data: sub } = await db
    .from("subcontractors")
    .select("id, company_name, retainage_pct, payment_terms_days, bills_by_invoice")
    .eq("id", params.subId)
    .single();
  if (!sub) notFound();

  const [{ data: sovRows }, { data: priorRows }] = await Promise.all([
    db.from("sub_sov_lines").select("*").eq("subcontractor_id", params.subId).eq("active", true).order("sort_order"),
    // Every application, not just the newest, and with its status. A rejected
    // one neither sets the baseline nor advances the number, and both of those
    // need the whole list to work out. See sub-app-numbering.
    db
      .from("sub_pay_apps")
      .select("id, app_number, period_end, billed_to_date, retainage_to_date, status, created_at")
      .eq("subcontractor_id", params.subId)
      .order("app_number", { ascending: false }),
  ]);

  const sovLines = sovRows ?? [];
  const history = priorRows ?? [];
  const prior = newestLiveApp(history);
  const appNumber = nextAppNumber(history);
  const isResubmission = replacesRejected(history, appNumber);

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
          {sub.bills_by_invoice ? `Record invoice #${appNumber}` : `Record application #${appNumber}`}
        </h2>
        {isResubmission && (
          <p className="text-xs text-amber-800">
            Application #{appNumber} was rejected. This replaces it under the
            same number, which is what {sub.company_name} will have on their own
            form. The rejected one stays on file, marked superseded.
          </p>
        )}
        {sub.bills_by_invoice ? (
          <p className="text-xs text-muted-foreground">
            {sub.company_name} bills by invoice, with no pay application. Enter
            the invoice, then put its amount on the SOV line it covers. The
            lines must add up to the invoice.
          </p>
        ) : (
        <p className="text-xs text-muted-foreground">
          Enter what the sub billed on each line this period. Completed to date,
          percent, balance and retainage are computed from our SOV and the last
          application, not taken from their form, so any disagreement shows up
          as a failed check instead of overwriting our numbers.
        </p>
        )}
      </div>

      <BillEntryForm
        projectId={params.id}
        subId={params.subId}
        appNumber={appNumber}
        retainagePct={Number(sub.retainage_pct ?? 0)}
        paymentTermsDays={sub.payment_terms_days}
        billsByInvoice={sub.bills_by_invoice}
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
