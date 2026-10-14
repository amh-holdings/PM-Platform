import Link from "next/link";
import { notFound } from "next/navigation";

import { formatCurrency, formatDate } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole, guardCapability } from "@/lib/roles-server";
import { billVerdict, recommendedApproval, summarizeChecks } from "@/lib/sub-billing";
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

  // What to pay, line by line: a figure someone already set (CM or approver)
  // wins, otherwise the engine's default. Summed here so the decision reads as
  // one number - billed, held, retainage, net - instead of a table to add up.
  const payLines = billedLines.map((l) => {
    const def = recommendedApproval({
      this_period: Number(l.this_period ?? 0),
      from_previous: Number(l.from_previous ?? 0),
      verified_amount: l.verified_amount != null ? Number(l.verified_amount) : null,
      flag_level: l.flag_level,
    });
    const billed = Number(l.this_period ?? 0);
    const amount = l.approved_this_period != null ? Number(l.approved_this_period) : def.amount;
    return { l, billed, amount, held: Math.round((billed - amount) * 100) / 100, basis: def.basis };
  });
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const billedGross = round2(payLines.reduce((s, p) => s + p.billed, 0));
  const payGross = round2(payLines.reduce((s, p) => s + p.amount, 0));
  const retRate = Number(app.retainage_pct ?? sub?.retainage_pct ?? 0) / 100;
  const payRetainage = round2(payGross * retRate);
  const heldLines = payLines.filter((p) => p.held > 0.004);
  const noEvidence = payLines.filter((p) => p.basis === "no_evidence");

  const verdict = billVerdict({
    checks: checks.map((c) => ({ status: c.status, severity: c.severity, label: c.label, message: c.message })),
    lines: payLines.map((p) => ({
      item_number: p.l.item_number,
      description: p.l.description,
      billed: p.billed,
      approve: p.amount,
      pct_billed: p.l.pct_billed != null ? Number(p.l.pct_billed) : null,
      verified_pct: p.l.verified_pct != null ? Number(p.l.verified_pct) : null,
      flag_level: p.l.flag_level,
      detail: p.l.verification_detail,
    })),
    approveGross: payGross,
    approveNet: round2(payGross - payRetainage),
    money: formatCurrency,
  });
  const VERDICT_TONE: Record<string, string> = {
    send_back: "border-destructive/50 bg-destructive/10",
    hold: "border-amber-400 bg-amber-50",
    needs_cm: "border-sky-300 bg-sky-50",
    approve: "border-emerald-400 bg-emerald-50",
  };
  const VERDICT_TAG: Record<string, string> = {
    send_back: "DO NOT APPROVE",
    hold: "APPROVE WITH HOLD",
    needs_cm: "NEEDS CM SIGN-OFF",
    approve: "APPROVE",
  };

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

      {/* ------------------------------ Verdict ------------------------------ */}
      {checks.length === 0 ? (
        <div className="rounded-md border p-4 text-sm">
          This bill has not been analyzed yet. Use <span className="font-medium">Analyze bill</span> below.
        </div>
      ) : (
        <section className={cn("space-y-2 rounded-md border-2 p-4", VERDICT_TONE[verdict.kind])}>
          <div className="text-[11px] font-bold tracking-wider">
            {decided ? `ANALYSIS (bill is ${STATUS_LABEL[app.status] ?? app.status})` : VERDICT_TAG[verdict.kind]}
          </div>
          <div className="text-base font-semibold">
            {showDollars ? verdict.headline : verdict.headline.replace(/\$[\d,]+\.\d{2}/g, "[amount]")}
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {verdict.reasons.map((r, i) => (
              <li key={i}>{showDollars ? r : r.replace(/\$[\d,]+\.\d{2}/g, "[amount]")}</li>
            ))}
          </ul>
          {verdict.notes.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {verdict.notes.length} other note{verdict.notes.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {verdict.notes.map((n, i) => (
                  <li key={i}>{showDollars ? n : n.replace(/\$[\d,]+\.\d{2}/g, "[amount]")}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="text-xs text-muted-foreground">
            {summary.passed} checks passed · {warnings.length} warning{warnings.length === 1 ? "" : "s"} ·{" "}
            {failures.length} failed · {flagged.length} line{flagged.length === 1 ? "" : "s"} ahead of the field record
            {unverifiable.length > 0 && ` · ${unverifiable.length} with no evidence source`}
          </div>
        </section>
      )}

      {/* ---------------------------- What to pay ---------------------------- */}
      {showDollars && billedLines.length > 0 && (
        <section className="space-y-2 rounded-md border bg-card p-4">
          <h3 className="text-sm font-semibold">
            {decided ? "What was approved" : "What to pay"}
          </h3>
          <table className="w-full max-w-md text-sm">
            <tbody>
              <tr>
                <td className="py-0.5 text-muted-foreground">Billed this period</td>
                <td className="py-0.5 text-right tabular-nums">{formatCurrency(billedGross)}</td>
              </tr>
              {heldLines.length > 0 && (
                <tr className="text-red-700">
                  <td className="py-0.5">Held - ahead of the field record</td>
                  <td className="py-0.5 text-right tabular-nums">
                    ({formatCurrency(round2(billedGross - payGross))})
                  </td>
                </tr>
              )}
              <tr className="font-medium">
                <td className="py-0.5">Approve (gross)</td>
                <td className="py-0.5 text-right tabular-nums">{formatCurrency(payGross)}</td>
              </tr>
              <tr>
                <td className="py-0.5 text-muted-foreground">Less {Math.round(retRate * 1000) / 10}% retainage</td>
                <td className="py-0.5 text-right tabular-nums">({formatCurrency(payRetainage)})</td>
              </tr>
              <tr className="border-t text-base font-semibold">
                <td className="py-1">AHC pays</td>
                <td className="py-1 text-right tabular-nums">{formatCurrency(round2(payGross - payRetainage))}</td>
              </tr>
            </tbody>
          </table>
          {heldLines.length > 0 && (
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {heldLines.map((p) => (
                <li key={p.l.id}>
                  <span className="font-medium text-foreground">{p.l.item_number}</span> {p.l.description}:
                  holding {formatCurrency(p.held)}. Billed to{" "}
                  {p.l.pct_billed != null ? `${(Number(p.l.pct_billed) * 100).toFixed(1)}%` : "?"}, field record supports{" "}
                  {p.l.verified_pct != null ? `${(Number(p.l.verified_pct) * 100).toFixed(1)}%` : "?"}.
                </li>
              ))}
            </ul>
          )}
          {noEvidence.length > 0 && (
            <p className="text-xs text-amber-800">
              Paid as billed with no field evidence to check against:{" "}
              {noEvidence.map((p) => p.l.item_number).join(", ")}. Certify a % below if any of these should be held.
            </p>
          )}
          {!decided && (
            <p className="text-xs text-muted-foreground">
              Lines within tolerance are paid as billed. Change any line in the Approve $ column below to
              pay a different amount; this box is what Approve for payment will record if you change nothing.
            </p>
          )}
        </section>
      )}

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
          recommended: recommendedApproval({
            this_period: Number(l.this_period ?? 0),
            from_previous: Number(l.from_previous ?? 0),
            verified_amount: l.verified_amount != null ? Number(l.verified_amount) : null,
            flag_level: l.flag_level,
          }).amount,
          cm_note: l.cm_note,
        }))}
      />
    </div>
  );
}
