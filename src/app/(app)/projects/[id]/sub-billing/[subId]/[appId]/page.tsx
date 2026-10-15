import Link from "next/link";
import { notFound } from "next/navigation";

import { formatCurrency, formatDate } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole, guardCapability } from "@/lib/roles-server";
import {
  billVerdict,
  recommendedApproval,
  summarizeEvidence,
  verifyLine,
  type BillLine,
  type SovLine,
} from "@/lib/sub-billing";
import { buildSubLetter, groupGaps, type LetterHold } from "@/lib/sub-billing-letter";
import { createClient } from "@/lib/supabase/server";
import { subBillingClient } from "@/lib/sub-billing-db";
import { loadEvidence } from "@/lib/sub-billing-run";
import { cn } from "@/lib/utils";

import { STATUS_LABEL, STATUS_TONE } from "../../constants";
import { CopyLetterButton } from "./copy-letter-button";
import { ReviewForm } from "./review-form";

type Params = { id: string; subId: string; appId: string };

// One decision, one to-do list, one table. The page used to stack a verdict
// banner, a "what to pay" box, a checks list, per-line flag chips and an
// evidence column of task-by-task percentages - Phil: "different warnings all
// over the page". Everything that says whether to pay is in the decision card;
// everything that is paperwork is in "Before you pay"; the table carries the
// four numbers per SOV line he asked for.

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

const round2 = (v: number) => Math.round(v * 100) / 100;

export default async function SubBillPage({ params }: { params: Params }) {
  await guardCapability("verifySubBilling");
  const { effective } = await getEffectiveRole();
  const showDollars = can(effective, "viewSubBillingDollars");
  const canRecommend = can(effective, "recommendSubBill");
  const canApprove = can(effective, "approveSubBilling");
  const db = subBillingClient();

  const { data: app } = await db.from("sub_pay_apps").select("*").eq("id", params.appId).single();
  if (!app) notFound();

  const [{ data: sub }, { data: lineRows }, { data: checkRows }, { data: sovRows }] = await Promise.all([
    db.from("subcontractors").select("company_name, retainage_pct, coi_status, w9_status").eq("id", params.subId).single(),
    db.from("sub_pay_app_lines").select("*").eq("sub_pay_app_id", params.appId).order("sort_order"),
    db.from("sub_pay_app_checks").select("*").eq("sub_pay_app_id", params.appId).order("severity"),
    db.from("sub_sov_lines").select("*").eq("subcontractor_id", params.subId).eq("active", true),
  ]);

  const lines = lineRows ?? [];
  const checks = checkRows ?? [];
  const analyzed = checks.length > 0;
  const decided = app.status === "approved" || app.status === "rejected" || app.status === "paid";
  const sovByItem = new Map(((sovRows ?? []) as unknown as SovLine[]).map((s) => [s.item_number, s]));

  // The same evidence the analysis used, read as of the bill's period end, so
  // the summary under each line describes what the percentages were judged on.
  const evidence = await loadEvidence(db, app.project_id, app.period_end, app.subcontractor_id);

  const rows = lines.map((l) => {
    const billed = Number(l.this_period ?? 0);
    const def = recommendedApproval({
      this_period: billed,
      from_previous: Number(l.from_previous ?? 0),
      verified_amount: l.verified_amount != null ? Number(l.verified_amount) : null,
      flag_level: l.flag_level,
    });
    const should = l.approved_this_period != null ? Number(l.approved_this_period) : def.amount;
    const sov = sovByItem.get(l.item_number);
    return {
      l,
      billed,
      should,
      evidence: sov ? summarizeEvidence(sov, evidence) : null,
    };
  });

  const billedRows = rows.filter((r) => r.billed !== 0);
  const billedGross = round2(billedRows.reduce((s, r) => s + r.billed, 0));
  const payGross = round2(billedRows.reduce((s, r) => s + r.should, 0));
  const retRate = Number(app.retainage_pct ?? sub?.retainage_pct ?? 0) / 100;
  const payRetainage = round2(payGross * retRate);
  const payNet = round2(payGross - payRetainage);

  const verdict = billVerdict({
    checks: checks.map((c) => ({ status: c.status, severity: c.severity, label: c.label, message: c.message })),
    lines: billedRows.map((r) => ({
      item_number: r.l.item_number,
      description: r.l.description,
      billed: r.billed,
      approve: r.should,
      pct_billed: r.l.pct_billed != null ? Number(r.l.pct_billed) : null,
      verified_pct: r.l.verified_pct != null ? Number(r.l.verified_pct) : null,
      flag_level: r.l.flag_level,
      detail: r.l.verification_detail,
      scheduled_value: Number(r.l.scheduled_value ?? 0),
      from_previous: Number(r.l.from_previous ?? 0),
      open: r.evidence?.open.length
        ? `${r.evidence.open.join(", ")}${r.evidence.more > 0 ? `, +${r.evidence.more} more` : ""}`
        : null,
    })),
    approveGross: payGross,
    approveNet: payNet,
    money: formatCurrency,
  });
  const hide = (t: string) => (showDollars ? t : t.replace(/\$[\d,]+\.\d{2}/g, "[amount]"));

  // ---- The review, worded as it goes back to the sub (sub-billing-letter) ----
  const { data: project } = await createClient().from("projects").select("name").eq("id", app.project_id).single();
  const todayIso = new Date().toISOString().slice(0, 10);
  const heldRows = billedRows.filter((r) => r.billed - r.should > 0.004 && r.l.verified_pct != null);
  // Where the held lines stand now, if the field has moved on since the period
  // end - so the sub is told how much of the hold the next bill can carry.
  const evidenceToday =
    heldRows.length && app.period_end < todayIso
      ? await loadEvidence(db, app.project_id, todayIso, app.subcontractor_id)
      : null;
  const letterHolds: LetterHold[] = heldRows.map((r) => {
    const sv = Number(r.l.scheduled_value ?? 0);
    const prev = Number(r.l.from_previous ?? 0);
    const built = Number(r.l.verified_pct);
    const held = round2(r.billed - r.should);
    let todayPct: number | null = null;
    const sov = sovByItem.get(r.l.item_number);
    if (evidenceToday && sov) {
      const stub: BillLine = {
        item_number: r.l.item_number,
        description: r.l.description,
        scheduled_value: sv,
        from_previous: prev,
        this_period: 0,
        materials_stored: 0,
        total_completed: prev,
        pct_billed: sv > 0 ? prev / sv : 0,
        balance_to_finish: sv - prev,
        retainage_amount: 0,
      };
      todayPct = verifyLine(sov, stub, evidenceToday).verifiedPct;
    }
    return {
      item: r.l.item_number,
      description: r.l.description,
      held,
      scheduledValue: sv,
      billedToPct: r.l.pct_billed != null ? Number(r.l.pct_billed) : 0,
      builtPct: built,
      prevAmount: prev,
      earned: Math.max(0, round2(built * sv - prev)),
      areas: groupGaps(r.evidence?.gaps ?? []),
      todayPct,
      nextBillable:
        todayPct != null ? Math.min(held, Math.max(0, round2(todayPct * sv - prev - r.should))) : null,
    };
  });
  const asks: string[] = [];
  if (!app.lien_waiver_received) asks.push(`The conditional lien waiver for ${formatCurrency(payNet)}`);
  if (!app.invoice_number || !app.invoice_date) asks.push("The invoice number and date for this application");
  if (!["current", "approved"].includes((sub?.coi_status ?? "").toLowerCase())) asks.push("A current certificate of insurance");
  if (!["received", "approved"].includes((sub?.w9_status ?? "").toLowerCase())) asks.push("A W-9");
  const letter = buildSubLetter({
    kind: verdict.kind,
    projectName: project?.name ?? "Project",
    appNumber: app.app_number,
    periodStart: app.period_start,
    periodEnd: app.period_end,
    todayIso,
    retainagePct: Math.round(retRate * 1000) / 10,
    approveGross: payGross,
    retainage: payRetainage,
    net: payNet,
    holds: letterHolds,
    sendBack: verdict.kind === "send_back" ? verdict.reasons : [],
    asks,
    money: formatCurrency,
  });
  // Paperwork the letter already asks for is not repeated under "Before you pay".
  const internalNotes = showDollars
    ? verdict.notes.filter((n) => !/lien waiver|waiver and release|COI status|W-9 status/i.test(n))
    : verdict.notes;
  const passed = checks.filter((c) => c.status === "pass");

  return (
    <div className="space-y-5">
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

      {/* ------------------------------ Decision ------------------------------ */}
      {!analyzed ? (
        <div className="rounded-md border p-4 text-sm">
          This bill has not been analyzed yet. Use <span className="font-medium">Analyze bill</span> at the bottom.
        </div>
      ) : (
        <section className={cn("rounded-md border-2 p-4", VERDICT_TONE[verdict.kind])}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="text-[11px] font-bold tracking-wider">
                {decided ? `${(STATUS_LABEL[app.status] ?? app.status).toUpperCase()}` : VERDICT_TAG[verdict.kind]}
              </div>
              {showDollars ? (
                <div className="space-y-3 text-sm">
                  <p>{letter.opening}</p>
                  {(letter.approved || letter.heldLine) && (
                    <div className="space-y-0.5">
                      {letter.approved && <p className="font-medium">{letter.approved}</p>}
                      {letter.heldLine && <p className="font-medium text-red-700">{letter.heldLine}</p>}
                    </div>
                  )}
                  {letter.kind === "send_back" && (
                    <ul className="list-disc space-y-0.5 pl-5">
                      {letter.sendBack.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {(letter.kind === "approve" || letter.kind === "needs_cm") && (
                    <ul className="list-disc space-y-0.5 pl-5">
                      {verdict.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {letter.holds.map((h) => (
                    <div key={h.item} className="space-y-2 rounded border border-amber-300 bg-background/70 p-3">
                      <div className="font-semibold">
                        Line {h.item} - {h.description}
                      </div>
                      <p>{h.paragraph}</p>
                      {h.areas.length > 0 && (
                        <table className="w-full text-xs">
                          <thead className="text-muted-foreground">
                            <tr>
                              <th className="py-0.5 pr-2 text-left font-normal">Area</th>
                              <th className="py-0.5 pr-2 text-left font-normal">
                                Work not complete as of {formatDate(app.period_end)}
                              </th>
                              <th className="py-0.5 text-right font-normal">% of line</th>
                              <th className="py-0.5 text-right font-normal">Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {h.areas.map((a) => (
                              <tr key={a.area} className="align-top">
                                <td className="py-0.5 pr-2 font-medium">{a.area}</td>
                                <td className="py-0.5 pr-2">{a.items}</td>
                                <td className="py-0.5 text-right tabular-nums">{(a.pct * 100).toFixed(2)}%</td>
                                <td className="py-0.5 text-right tabular-nums">
                                  {formatCurrency(round2(a.pct * h.scheduledValue))}
                                </td>
                              </tr>
                            ))}
                            <tr className="border-t font-semibold">
                              <td className="pt-1" colSpan={2}>
                                Total not complete
                              </td>
                              <td className="pt-1 text-right tabular-nums">{((1 - h.builtPct) * 100).toFixed(1)}%</td>
                              <td className="pt-1 text-right tabular-nums">
                                {formatCurrency(round2((1 - h.builtPct) * h.scheduledValue))}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      )}
                      <p>{h.next}</p>
                    </div>
                  ))}
                  {letter.asks.length > 0 && (
                    <div>
                      <div className="font-medium">Before payment is released, please send:</div>
                      <ul className="list-disc pl-5">
                        {letter.asks.map((a) => (
                          <li key={a}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <CopyLetterButton text={letter.text} />
                </div>
              ) : (
                <ul className="space-y-1 text-sm">
                  {verdict.reasons.map((r, i) => (
                    <li key={i}>{hide(r)}</li>
                  ))}
                </ul>
              )}
            </div>
            {showDollars && (
              <table className="text-sm">
                <tbody>
                  <tr>
                    <td className="pr-6 text-muted-foreground">Sub billed</td>
                    <td className="text-right tabular-nums">{formatCurrency(billedGross)}</td>
                  </tr>
                  {billedGross - payGross > 0.004 && (
                    <tr className="text-red-700">
                      <td className="pr-6">Hold</td>
                      <td className="text-right tabular-nums">({formatCurrency(round2(billedGross - payGross))})</td>
                    </tr>
                  )}
                  <tr className="font-medium">
                    <td className="pr-6">{decided ? "Approved" : "Approve"}</td>
                    <td className="text-right tabular-nums">
                      {formatCurrency(decided && app.approved_this_period != null ? Number(app.approved_this_period) : payGross)}
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-6 text-muted-foreground">Retainage {Math.round(retRate * 1000) / 10}%</td>
                    <td className="text-right tabular-nums">
                      ({formatCurrency(decided && app.approved_retainage != null ? Number(app.approved_retainage) : payRetainage)})
                    </td>
                  </tr>
                  <tr className="border-t text-base font-semibold">
                    <td className="pr-6 pt-1">AHC pays</td>
                    <td className="pt-1 text-right tabular-nums">
                      {formatCurrency(decided && app.approved_amount_due != null ? Number(app.approved_amount_due) : payNet)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {/* ---------------------------- Before you pay --------------------------- */}
      {analyzed && (internalNotes.length > 0 || passed.length > 0) && (
        <section className="rounded-md border p-3 text-sm">
          {internalNotes.length > 0 && (
            <>
              <div className="mb-1 text-xs font-semibold">Before you pay</div>
              <ul className="space-y-0.5 text-xs">
                {internalNotes.map((n, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-muted-foreground">☐</span>
                    <span>{hide(n)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {passed.length > 0 && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">{passed.length} math and contract checks passed</summary>
              <ul className="mt-1 space-y-0.5">
                {passed.map((c) => (
                  <li key={c.id}>{c.label}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {/* ----------------------------- Line detail ----------------------------- */}
      <ReviewForm
        projectId={params.id}
        appId={params.appId}
        status={app.status}
        decided={decided}
        showDollars={showDollars}
        canRecommend={canRecommend && !decided}
        canApprove={canApprove && !decided}
        cmNotes={app.cm_notes}
        approvalNotes={app.approval_notes}
        lines={rows.map((r) => ({
          id: r.l.id,
          item_number: r.l.item_number,
          description: r.l.description,
          scheduled_value: Number(r.l.scheduled_value ?? 0),
          from_previous: Number(r.l.from_previous ?? 0),
          this_period: r.billed,
          pct_billed: r.l.pct_billed != null ? Number(r.l.pct_billed) : null,
          built_pct: r.l.verified_pct != null ? Number(r.l.verified_pct) : null,
          built_amount: r.l.verified_amount != null ? Number(r.l.verified_amount) : null,
          should: r.should,
          evidence: r.evidence,
          cm_note: r.l.cm_note,
        }))}
      />
    </div>
  );
}
