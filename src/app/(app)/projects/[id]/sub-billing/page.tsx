import Link from "next/link";

import { formatCurrency, formatDate } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole, guardCapability } from "@/lib/roles-server";
import { subBillingClient } from "@/lib/sub-billing-db";
import { cn } from "@/lib/utils";

import { STATUS_LABEL, STATUS_TONE } from "./constants";

type Params = { id: string };

export default async function SubBillingPage({ params }: { params: Params }) {
  await guardCapability("verifySubBilling");
  const { effective } = await getEffectiveRole();
  const showDollars = can(effective, "viewSubBillingDollars");
  const db = subBillingClient();

  const [{ data: summary }, { data: openApps }] = await Promise.all([
    db
      .from("v_sub_billing_summary")
      .select("*")
      .eq("project_id", params.id)
      .order("company_name"),
    db
      .from("sub_pay_apps")
      .select("id, subcontractor_id, app_number, period_end, status, billed_this_period, amount_due")
      .eq("project_id", params.id)
      .in("status", ["received", "under_review", "cm_recommended"])
      .order("period_end", { ascending: false }),
  ]);

  const subs = summary ?? [];
  const open = openApps ?? [];
  const withSov = subs.filter((s) => Number(s.sov_line_count ?? 0) > 0);
  const totalApproved = subs.reduce((s, r) => s + Number(r.approved_to_date ?? 0), 0);
  const totalRetainage = subs.reduce((s, r) => s + Number(r.retainage_held ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Sub billing</h2>
        <p className="text-xs text-muted-foreground">
          What each subcontractor is entitled to under their executed schedule
          of values, what they billed, and whether the field record supports it.
          {!showDollars && " Percentages only in this view."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Subs with an SOV loaded" value={`${withSov.length} of ${subs.length}`} />
        <Stat label="Bills awaiting action" value={String(open.length)} />
        {showDollars && (
          <>
            <Stat label="Approved to date" value={formatCurrency(totalApproved)} />
            <Stat label="Retainage held" value={formatCurrency(totalRetainage)} />
          </>
        )}
      </div>

      {open.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Awaiting action</h3>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Subcontractor</th>
                  <th className="px-3 py-2">App</th>
                  <th className="px-3 py-2">Period end</th>
                  {showDollars && <th className="px-3 py-2 text-right">Billed</th>}
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {open.map((a) => {
                  const sub = subs.find((s) => s.subcontractor_id === a.subcontractor_id);
                  return (
                    <tr key={a.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <Link
                          className="font-medium underline-offset-2 hover:underline"
                          href={`/projects/${params.id}/sub-billing/${a.subcontractor_id}/${a.id}`}
                        >
                          {sub?.company_name ?? "Unknown"}
                        </Link>
                      </td>
                      <td className="px-3 py-2 tabular-nums">#{a.app_number}</td>
                      <td className="px-3 py-2">{formatDate(a.period_end)}</td>
                      {showDollars && (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCurrency(Number(a.billed_this_period ?? 0))}
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <span className={cn("rounded px-2 py-0.5 text-xs font-medium", STATUS_TONE[a.status])}>
                          {STATUS_LABEL[a.status] ?? a.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Subcontractors</h3>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Subcontractor</th>
                <th className="px-3 py-2 text-right">SOV lines</th>
                <th className="px-3 py-2 text-right">Unmapped</th>
                {showDollars && <th className="px-3 py-2 text-right">Contract</th>}
                <th className="px-3 py-2 text-right">Bills</th>
                {showDollars && <th className="px-3 py-2 text-right">Approved to date</th>}
                <th className="px-3 py-2 text-right">% complete</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {subs.map((s) => {
                const lineCount = Number(s.sov_line_count ?? 0);
                const unmapped = Number(s.unmapped_lines ?? 0);
                return (
                  <tr key={s.subcontractor_id} className="hover:bg-muted/30">
                    <td className="px-3 py-2">
                      {lineCount > 0 ? (
                        <Link
                          className="font-medium underline-offset-2 hover:underline"
                          href={`/projects/${params.id}/sub-billing/${s.subcontractor_id}`}
                        >
                          {s.company_name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{s.company_name}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {lineCount || <span className="text-muted-foreground">No SOV</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {lineCount === 0 ? (
                        <span className="text-muted-foreground">-</span>
                      ) : unmapped > 0 ? (
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                          {unmapped}
                        </span>
                      ) : (
                        <span className="text-emerald-700">0</span>
                      )}
                    </td>
                    {showDollars && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCurrency(Number(s.contract_value ?? 0))}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right tabular-nums">{Number(s.apps_received ?? 0)}</td>
                    {showDollars && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCurrency(Number(s.approved_to_date ?? 0))}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.pct_approved != null ? `${(Number(s.pct_approved) * 100).toFixed(1)}%` : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          An unmapped SOV line can be checked for arithmetic but not
          substantiated against the field record. Those lines are reported as
          unverifiable on every bill until a mapping is confirmed.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
