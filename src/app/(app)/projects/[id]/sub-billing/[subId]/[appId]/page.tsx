import Link from "next/link";
import { notFound } from "next/navigation";

import { formatCurrency, formatDate } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole, guardCapability } from "@/lib/roles-server";
import { summarizeChecks } from "@/lib/sub-billing";
import { subBillingClient } from "@/lib/sub-billing-db";
import { cn } from "@/lib/utils";

import { FLAG_LABEL, FLAG_TONE, STATUS_LABEL, STATUS_TONE } from "../../constants";
import { ReviewForm } from "./review-form";

type Params = { id: string; subId: string; appId: string };

export default async function SubBillPage({ params }: { params: Params }) {
  await guardCapability("verifySubBilling");
  const { effective } = await getEffectiveRole();
  const showDollars = can(effective, "viewSubBillingDollars");
  const canRecommend = can(effective, "recommendSubBill");
  const canApprove = can(effective, "approveSubBilling");
  const db = subBillingClient();

  const { data: app } = await db.from("sub_pay_apps").select("*").eq("id", params.appId).single();
  if (!app) notFound();

  const [{ data: sub }, { data: lineRows }, { data: checkRows }] = await Promise.all([
    db.from("subcontractors").select("company_name, retainage_pct").eq("id", params.subId).single(),
    db.from("sub_pay_app_lines").select("*").eq("sub_pay_app_id", params.appId).order("sort_order"),
    db.from("sub_pay_app_checks").select("*").eq("sub_pay_app_id", params.appId).order("severity"),
  ]);

  const lines = lineRows ?? [];
  const checks = checkRows ?? [];
  const summary = summarizeChecks(
    checks.map((c) => ({ ...c, key: c.check_key, message: c.message ?? "" })),
  );
  const failures = checks.filter((c) => c.status === "fail");
  const warnings = checks.filter((c) => c.status === "warn");
  const passes = checks.filter((c) => c.status === "pass");

  const billedLines = lines.filter((l) => Number(l.this_period ?? 0) !== 0);
  const flagged = lines.filter((l) => l.flag_level === "flag" || l.flag_level === "review");
  const unverifiable = billedLines.filter((l) => l.flag_level === "unverifiable");

  const decided = app.status === "approved" || app.status === "rejected" || app.status === "paid";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={`/projects/${params.id}/sub-billing/${params.subId}`}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {sub?.company_name ?? "Subcontractor"}
          </Link>
          <h2 className="text-lg font-semibold">
            Application #{app.app_number}
            <span className={cn("ml-3 rounded px-2 py-0.5 align-middle text-xs font-medium", STATUS_TONE[app.status])}>
              {STATUS_LABEL[app.status] ?? app.status}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            Period {app.period_start ? `${formatDate(app.period_start)} to ` : "through "}
            {formatDate(app.period_end)}
            {app.invoice_number ? ` · Invoice ${app.invoice_number}` : ""}
            {app.payment_terms_days != null ? ` · Net ${app.payment_terms_days}` : ""}
          </p>
        </div>
        {showDollars && (
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Amount due as billed</div>
            <div className="text-2xl font-semibold tabular-nums">
              {formatCurrency(Number(app.amount_due ?? 0))}
            </div>
            {app.approved_amount_due != null && (
              <div className="text-xs text-muted-foreground">
                Approved {formatCurrency(Number(app.approved_amount_due))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* --------------------------- Verdict banner --------------------------- */}
      <div
        className={cn(
          "rounded-md border p-3 text-sm",
          summary.hardFail
            ? "border-destructive/40 bg-destructive/10"
            : flagged.length > 0
              ? "border-amber-300 bg-amber-50"
              : "border-emerald-300 bg-emerald-50",
        )}
      >
        <div className="font-medium">
          {summary.hardFail
            ? `${failures.length} check${failures.length === 1 ? "" : "s"} failed`
            : flagged.length > 0
              ? `Arithmetic is clean, ${flagged.length} line${flagged.length === 1 ? "" : "s"} outrun the field record`
              : "Arithmetic is clean and every billed line is supported"}
        </div>
        <div className="mt-1 text-xs">
          {summary.passed} passed · {warnings.length} warning{warnings.length === 1 ? "" : "s"} ·{" "}
          {failures.length} failed
          {unverifiable.length > 0 && ` · ${unverifiable.length} billed line${unverifiable.length === 1 ? "" : "s"} have no evidence source`}
        </div>
      </div>

      {/* ------------------------------ Checks ------------------------------- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Checks</h3>
        {checks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No checks have been run on this application.
          </p>
        ) : (
          <div className="space-y-1">
            {[...failures, ...warnings].map((c) => (
              <div
                key={c.id}
                className={cn(
                  "flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-sm",
                  c.status === "fail"
                    ? "border-destructive/40 bg-destructive/5"
                    : "border-amber-300 bg-amber-50/60",
                )}
              >
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                    c.status === "fail" ? "bg-destructive text-destructive-foreground" : "bg-amber-200 text-amber-900",
                  )}
                >
                  {c.status === "fail" ? "Fail" : "Warn"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{c.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {showDollars ? c.message : (c.message ?? "").replace(/\$[\d,]+\.\d{2}/g, "[amount]")}
                  </div>
                </div>
              </div>
            ))}
            {passes.length > 0 && (
              <details className="rounded-md border px-3 py-2 text-sm">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {passes.length} checks passed
                </summary>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {passes.map((c) => (
                    <li key={c.id}>
                      <span className="text-emerald-700">Pass</span> · {c.label}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>

      {/* ------------------------- Lines and review -------------------------- */}
      <ReviewForm
        projectId={params.id}
        appId={params.appId}
        status={app.status}
        decided={decided}
        showDollars={showDollars}
        canRecommend={canRecommend && !decided}
        canApprove={canApprove && !decided}
        retainagePct={Number(app.retainage_pct ?? sub?.retainage_pct ?? 0)}
        cmNotes={app.cm_notes}
        approvalNotes={app.approval_notes}
        lines={lines.map((l) => ({
          id: l.id,
          item_number: l.item_number,
          description: l.description,
          scheduled_value: Number(l.scheduled_value ?? 0),
          from_previous: Number(l.from_previous ?? 0),
          this_period: Number(l.this_period ?? 0),
          total_completed: Number(l.total_completed ?? 0),
          pct_billed: l.pct_billed != null ? Number(l.pct_billed) : null,
          verified_pct: l.verified_pct != null ? Number(l.verified_pct) : null,
          verified_amount: l.verified_amount != null ? Number(l.verified_amount) : null,
          verification_detail: l.verification_detail,
          verification_source: l.verification_source,
          variance_amount: l.variance_amount != null ? Number(l.variance_amount) : null,
          flag_level: l.flag_level,
          flagLabel: l.flag_level ? FLAG_LABEL[l.flag_level] ?? l.flag_level : null,
          flagTone: l.flag_level ? FLAG_TONE[l.flag_level] ?? "" : "",
          approved_this_period: l.approved_this_period != null ? Number(l.approved_this_period) : null,
          cm_note: l.cm_note,
        }))}
      />
    </div>
  );
}
