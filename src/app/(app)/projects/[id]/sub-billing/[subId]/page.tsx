import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole, guardCapability } from "@/lib/roles-server";
import { projectNextBill, type Evidence, type SovLine } from "@/lib/sub-billing";
import { subBillingClient } from "@/lib/sub-billing-db";
import { cn } from "@/lib/utils";

import { METHOD_LABEL, STATUS_LABEL, STATUS_TONE } from "../constants";
import { MappingRow } from "./mapping-row";

type Params = { id: string; subId: string };

export default async function SubBillingDetailPage({ params }: { params: Params }) {
  await guardCapability("verifySubBilling");
  const { effective } = await getEffectiveRole();
  const showDollars = can(effective, "viewSubBillingDollars");
  const db = subBillingClient();

  const { data: sub } = await db
    .from("subcontractors")
    .select("id, company_name, trade, contract_value, retainage_pct, payment_terms, payment_terms_days, coi_status, w9_status")
    .eq("id", params.subId)
    .single();
  if (!sub) notFound();

  const [{ data: sovRows }, { data: appRows }, { data: taskRows }, { data: commodityRows }] =
    await Promise.all([
      db.from("sub_sov_lines").select("*").eq("subcontractor_id", params.subId).eq("active", true).order("sort_order"),
      db.from("sub_pay_apps").select("*").eq("subcontractor_id", params.subId).order("app_number", { ascending: false }),
      db.from("schedule_tasks").select("wbs_code, task_name, status, pct_complete, start_date, end_date, duration_days").eq("project_id", params.id).order("wbs_code"),
      db.from("commodities").select("id, label, uom, total_quantity").eq("project_id", params.id).eq("active", true).order("sort_order"),
    ]);

  const sovLines = sovRows ?? [];
  const apps = appRows ?? [];
  const tasks = taskRows ?? [];
  const commodities = commodityRows ?? [];

  // Billed-to-date per line, from the most recent application on record.
  const latest = apps[0];
  let billedByItem = new Map<string, number>();
  if (latest) {
    const { data: latestLines } = await db
      .from("sub_pay_app_lines")
      .select("item_number, total_completed")
      .eq("sub_pay_app_id", latest.id);
    billedByItem = new Map((latestLines ?? []).map((l) => [l.item_number, Number(l.total_completed ?? 0)]));
  }

  // ---- Next-bill projection, as of today ----
  const [{ data: production }, { data: firstDpr }] = await Promise.all([
    // All tracker production, matching loadEvidence in sub-billing-run.ts. What
    // the approved field record says was installed is what the next bill is
    // projected from.
    db
      .from("daily_production")
      .select("commodity_id, quantity")
      .eq("project_id", params.id),
    db
      .from("dprs")
      .select("report_date")
      .eq("project_id", params.id)
      .eq("subcontractor_id", params.subId)
      .order("report_date", { ascending: true })
      .limit(1),
  ]);
  const installed = new Map<string, number>();
  for (const row of production ?? []) {
    if (!row.commodity_id) continue;
    installed.set(row.commodity_id, (installed.get(row.commodity_id) ?? 0) + Number(row.quantity ?? 0));
  }
  const todayIso = new Date().toISOString().slice(0, 10);
  const evidence: Evidence = {
    tasks: new Map(tasks.map((t) => [t.wbs_code, { ...t, wbs_code: t.wbs_code, task_name: t.task_name }])),
    commodities: new Map(
      commodities.map((c) => [
        c.id,
        { label: c.label ?? "", installed: installed.get(c.id) ?? 0, total: Number(c.total_quantity ?? 0), uom: c.uom ?? null },
      ]),
    ),
    subOnSiteDate: firstDpr?.[0]?.report_date ?? null,
    todayIso,
  };

  const projection = projectNextBill({
    sovLines: sovLines as unknown as SovLine[],
    billedToDateByItem: billedByItem,
    evidenceAtPeriodEnd: evidence,
    retainagePct: Number(sub.retainage_pct ?? 0),
  });
  const projectedLines = projection.lines.filter((l) => l.projectedThisPeriod > 0);
  const unprojectable = projection.lines.filter((l) => l.projectedPctAtPeriodEnd == null);

  const sovTotal = sovLines.reduce((s, l) => s + Number(l.scheduled_value ?? 0), 0);
  const unmapped = sovLines.filter((l) => l.verification_method === "unmapped").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/projects/${params.id}/sub-billing`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            Sub billing
          </Link>
          <h2 className="text-lg font-semibold">{sub.company_name}</h2>
          <p className="text-xs text-muted-foreground">
            {sub.trade} · {sub.retainage_pct}% retainage
            {sub.payment_terms ? ` · ${sub.payment_terms}` : ""}
            {sub.payment_terms_days != null &&
              sub.payment_terms &&
              !sub.payment_terms.replace(/\D/g, "").includes(String(sub.payment_terms_days)) && (
                <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-900">
                  Terms conflict: record says Net {sub.payment_terms_days}
                </span>
              )}
          </p>
        </div>
        {can(effective, "enterSubBill") && sovLines.length > 0 && (
          <Button asChild>
            <Link href={`/projects/${params.id}/sub-billing/${params.subId}/new`}>Record a bill</Link>
          </Button>
        )}
      </div>

      {/* ---------------------------- Next bill ---------------------------- */}
      <section className="space-y-2 rounded-md border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">What we expect on the next bill</h3>
          <span className="text-xs text-muted-foreground">Evidence as of {formatDate(todayIso)}</span>
        </div>

        {projectedLines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing is projected. {unmapped > 0
              ? `${unmapped} of ${sovLines.length} SOV lines have no evidence source mapped, so no percentage can be computed for them.`
              : "The field record shows no earned work beyond what has already been billed."}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2 text-right">Earned %</th>
                    {showDollars && <th className="px-3 py-2 text-right">Already billed</th>}
                    {showDollars && <th className="px-3 py-2 text-right">Expect to bill</th>}
                    <th className="px-3 py-2">Basis</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {projectedLines.map((l) => (
                    <tr key={l.itemNumber}>
                      <td className="px-3 py-2 tabular-nums">{l.itemNumber}</td>
                      <td className="px-3 py-2">{l.description}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {((l.projectedPctAtPeriodEnd ?? 0) * 100).toFixed(1)}%
                      </td>
                      {showDollars && (
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {formatCurrency(l.billedToDate)}
                        </td>
                      )}
                      {showDollars && (
                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                          {formatCurrency(l.projectedThisPeriod)}
                        </td>
                      )}
                      <td className="px-3 py-2 text-xs text-muted-foreground">{l.basis}</td>
                    </tr>
                  ))}
                </tbody>
                {showDollars && (
                  <tfoot className="border-t-2 bg-muted/30 font-medium">
                    <tr>
                      <td className="px-3 py-2" colSpan={4}>
                        Projected gross
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(projection.grossTotal)}</td>
                      <td />
                    </tr>
                    <tr>
                      <td className="px-3 py-2" colSpan={4}>
                        Less {sub.retainage_pct}% retainage
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">({formatCurrency(projection.retainage)})</td>
                      <td />
                    </tr>
                    <tr>
                      <td className="px-3 py-2" colSpan={4}>
                        Expected amount due
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(projection.netDue)}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {unprojectable.length > 0 && (
              <p className="text-xs text-amber-800">
                {unprojectable.length} line{unprojectable.length === 1 ? "" : "s"} could not be
                projected because no evidence source is mapped. Anything the sub bills on
                those lines will arrive unverified.
              </p>
            )}
          </>
        )}
      </section>

      {/* ------------------------- Bill history --------------------------- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Bills received</h3>
        {apps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bills recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">App</th>
                  <th className="px-3 py-2">Period end</th>
                  <th className="px-3 py-2">Invoice</th>
                  {showDollars && <th className="px-3 py-2 text-right">Billed</th>}
                  {showDollars && <th className="px-3 py-2 text-right">Approved</th>}
                  {showDollars && <th className="px-3 py-2 text-right">Amount due</th>}
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {apps.map((a) => (
                  <tr key={a.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link
                        className="font-medium underline-offset-2 hover:underline"
                        href={`/projects/${params.id}/sub-billing/${params.subId}/${a.id}`}
                      >
                        #{a.app_number}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{formatDate(a.period_end)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{a.invoice_number ?? "-"}</td>
                    {showDollars && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCurrency(Number(a.billed_this_period ?? 0))}
                      </td>
                    )}
                    {showDollars && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {a.approved_this_period != null
                          ? formatCurrency(Number(a.approved_this_period))
                          : "-"}
                      </td>
                    )}
                    {showDollars && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCurrency(Number(a.approved_amount_due ?? a.amount_due ?? 0))}
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <span className={cn("rounded px-2 py-0.5 text-xs font-medium", STATUS_TONE[a.status])}>
                        {STATUS_LABEL[a.status] ?? a.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* -------------------- SOV and evidence mapping --------------------- */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Executed schedule of values</h3>
          <span className="text-xs text-muted-foreground">
            {sovLines.length} lines
            {showDollars ? ` · ${formatCurrency(sovTotal)}` : ""}
            {unmapped > 0 ? ` · ${unmapped} unmapped` : " · all mapped"}
          </span>
        </div>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Description</th>
                {showDollars && <th className="px-3 py-2 text-right">Scheduled value</th>}
                {showDollars && <th className="px-3 py-2 text-right">Billed to date</th>}
                <th className="px-3 py-2">Verified by</th>
                <th className="px-3 py-2">Evidence</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {sovLines.map((l) => (
                <MappingRow
                  key={l.id}
                  projectId={params.id}
                  line={{
                    id: l.id,
                    item_number: l.item_number,
                    description: l.description,
                    scheduled_value: Number(l.scheduled_value ?? 0),
                    verification_method: l.verification_method,
                    linked_task_wbs_codes: l.linked_task_wbs_codes ?? [],
                    linked_commodity_ids: l.linked_commodity_ids ?? [],
                    milestone_task_wbs_code: l.milestone_task_wbs_code,
                    mapping_notes: l.mapping_notes,
                    mapping_confirmed_at: l.mapping_confirmed_at,
                  }}
                  billedToDate={billedByItem.get(l.item_number) ?? 0}
                  showDollars={showDollars}
                  methodLabel={METHOD_LABEL[l.verification_method] ?? l.verification_method}
                  tasks={tasks.map((t) => ({ wbs_code: t.wbs_code, task_name: t.task_name ?? "" }))}
                  commodities={commodities.map((c) => ({ id: c.id, label: c.label ?? "" }))}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
