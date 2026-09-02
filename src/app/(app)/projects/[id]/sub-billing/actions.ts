"use server";

import { revalidatePath } from "next/cache";

import { subBillingClient } from "@/lib/sub-billing-db";
import { createClient } from "@/lib/supabase/server";
import { can, toEffectiveRole, type Capability } from "@/lib/roles";
import { runVerificationCore } from "@/lib/sub-billing-run";
import { approvedToDateByItem, type BillHeader, type BillLine, type SovLine } from "@/lib/sub-billing";
import type { SubPayAppStatus } from "@/lib/sub-billing.types";

export type ActionResult =
  | { ok: true; id?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

// Server-side capability gate. The tab/UI hiding is cosmetic; this is the
// enforcement. Always re-reads the true DB role, never the view-as cookie.
async function requireCapability(cap: Capability) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = toEffectiveRole(profile?.role);
  if (!can(role, cap)) {
    return { ok: false as const, error: "You do not have access to this action" };
  }
  return { ok: true as const, userId: user.id, role };
}

const num = (v: FormDataEntryValue | null): number => {
  if (typeof v !== "string" || !v.trim()) return 0;
  const cleaned = v.replace(/[$,\s]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
};
const optNum = (v: FormDataEntryValue | null): number | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const cleaned = v.replace(/[$,%\s]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};
const str = (v: FormDataEntryValue | null): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const round2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Record a bill received from a subcontractor.
//
// The form posts the sub's G703 verbatim: one this-period figure per SOV line.
// Everything else - completed to date, percent, balance, retainage, the header
// totals - is DERIVED here from the SOV and the prior application, never taken
// from the sub's paperwork. That is deliberate: a bill whose own arithmetic is
// wrong should show up as a mismatch against our numbers, not overwrite them.
// The sub's stated totals go in as the "billed" header so the checks can
// compare the two.
// ---------------------------------------------------------------------------
export async function recordSubBill(
  projectId: string,
  subcontractorId: string,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireCapability("enterSubBill");
  if (!auth.ok) return auth;
  const db = subBillingClient();

  const periodEnd = str(formData.get("period_end"));
  if (!periodEnd) return { ok: false, error: "Period end date is required" };

  const { data: sub } = await db
    .from("subcontractors")
    .select("id, company_name, contract_value, retainage_pct, payment_terms, payment_terms_days, coi_status, w9_status")
    .eq("id", subcontractorId)
    .single();
  if (!sub) return { ok: false, error: "Subcontractor not found" };

  const { data: sovRows } = await db
    .from("sub_sov_lines")
    .select("*")
    .eq("subcontractor_id", subcontractorId)
    .eq("active", true)
    .order("sort_order");
  const sovLines = sovRows ?? [];
  if (sovLines.length === 0) {
    return { ok: false, error: "This subcontractor has no SOV loaded yet" };
  }

  // The application history for this sub answers two different questions, and
  // they need two different answers:
  //
  //   numbering  - the next number follows the highest we have ever recorded,
  //                rejected applications included. A rejected app 3 still
  //                consumed the number 3, and reusing it collides on the
  //                unique key.
  //   continuity - the baseline this bill opens from must EXCLUDE rejected
  //                applications. A bill AHC refused is not history, and
  //                letting it set the previously-billed floor hands back the
  //                exact amount that was refused.
  const { data: historyRows } = await db
    .from("sub_pay_apps")
    .select("id, app_number, period_end, billed_to_date, retainage_to_date, approved_this_period, status")
    .eq("subcontractor_id", subcontractorId)
    .order("app_number", { ascending: true });
  const history = historyRows ?? [];
  const latestApp = history.length > 0 ? history[history.length - 1] : null;
  const accepted = history.filter((a) => a.status !== "rejected");
  const priorApp = accepted.length > 0 ? accepted[accepted.length - 1] : null;

  // Seed the previous column from what AHC APPROVED to date, never from what
  // the sub billed. See approvedToDateByItem() for why, and for how a line
  // carrying no recorded decision is handled.
  let priorByItem = new Map<string, number>();
  if (accepted.length > 0) {
    const { data } = await db
      .from("sub_pay_app_lines")
      .select("item_number, this_period, materials_stored, approved_this_period")
      .in("sub_pay_app_id", accepted.map((a) => a.id));
    priorByItem = approvedToDateByItem(data ?? []);
  }
  const priorRetainageHeld = Number(priorApp?.retainage_to_date ?? 0);

  const appNumber = optNum(formData.get("app_number")) ?? (latestApp ? latestApp.app_number + 1 : 1);
  const retainagePct = optNum(formData.get("retainage_pct")) ?? Number(sub.retainage_pct ?? 0);
  const rate = retainagePct / 100;

  // Build the line set from OUR SOV, not from what the sub sent.
  const lines: (BillLine & { sub_sov_line_id: string; sort_order: number })[] = sovLines.map(
    (sov, i) => {
      const sv = Number(sov.scheduled_value ?? 0);
      const fromPrevious = priorByItem.get(sov.item_number) ?? 0;
      const thisPeriod = num(formData.get(`this_period__${sov.item_number}`));
      const stored = num(formData.get(`stored__${sov.item_number}`));
      const totalCompleted = round2(fromPrevious + thisPeriod + stored);
      return {
        sub_sov_line_id: sov.id,
        item_number: sov.item_number,
        description: sov.description,
        scheduled_value: sv,
        from_previous: fromPrevious,
        this_period: thisPeriod,
        materials_stored: stored,
        total_completed: totalCompleted,
        pct_billed: sv > 0 ? totalCompleted / sv : 0,
        balance_to_finish: round2(sv - totalCompleted),
        retainage_amount: round2(totalCompleted * rate),
        sort_order: (i + 1) * 10,
      };
    },
  );

  const derivedThisPeriod = round2(lines.reduce((s, l) => s + Number(l.this_period), 0));
  const derivedToDate = round2(lines.reduce((s, l) => s + Number(l.total_completed), 0));
  const derivedPrevious = round2(lines.reduce((s, l) => s + Number(l.from_previous), 0));

  // The sub's own stated totals, entered from their form. When left blank we
  // fall back to ours, and the corresponding check simply passes.
  const statedThisPeriod = optNum(formData.get("billed_this_period")) ?? derivedThisPeriod;
  const statedToDate = optNum(formData.get("billed_to_date")) ?? derivedToDate;
  const statedRetainageThis =
    optNum(formData.get("retainage_this_period")) ??
    round2(round2(derivedToDate * rate) - priorRetainageHeld);
  const statedRetainageToDate =
    optNum(formData.get("retainage_to_date")) ?? round2(derivedToDate * rate);
  const statedAmountDue =
    optNum(formData.get("amount_due")) ?? round2(statedThisPeriod - statedRetainageThis);

  const header: BillHeader = {
    app_number: appNumber,
    period_start: str(formData.get("period_start")),
    period_end: periodEnd,
    retainage_pct: retainagePct,
    payment_terms_days: optNum(formData.get("payment_terms_days")),
    invoice_total: optNum(formData.get("invoice_total")),
    billed_previous: optNum(formData.get("billed_previous")) ?? derivedPrevious,
    billed_this_period: statedThisPeriod,
    billed_to_date: statedToDate,
    retainage_this_period: statedRetainageThis,
    retainage_to_date: statedRetainageToDate,
    amount_due: statedAmountDue,
    lien_waiver_received: formData.get("lien_waiver_received") === "on",
    lien_waiver_amount: optNum(formData.get("lien_waiver_amount")),
    lien_waiver_through_date: str(formData.get("lien_waiver_through_date")),
  };

  const { data: app, error: appErr } = await db
    .from("sub_pay_apps")
    .insert({
      project_id: projectId,
      subcontractor_id: subcontractorId,
      app_number: appNumber,
      app_date: str(formData.get("app_date")),
      period_start: header.period_start,
      period_end: periodEnd,
      retainage_pct: retainagePct,
      payment_terms_days: header.payment_terms_days,
      due_date: str(formData.get("due_date")),
      invoice_number: str(formData.get("invoice_number")),
      invoice_date: str(formData.get("invoice_date")),
      invoice_total: header.invoice_total,
      billed_previous: header.billed_previous,
      billed_this_period: header.billed_this_period,
      billed_to_date: header.billed_to_date,
      retainage_this_period: header.retainage_this_period,
      retainage_to_date: header.retainage_to_date,
      amount_due: header.amount_due,
      status: "received" as SubPayAppStatus,
      lien_waiver_received: header.lien_waiver_received ?? false,
      lien_waiver_amount: header.lien_waiver_amount,
      lien_waiver_through_date: header.lien_waiver_through_date,
      notes: str(formData.get("notes")),
      entered_by: auth.userId,
    })
    .select("id")
    .single();

  if (appErr || !app) {
    if (appErr?.code === "23505") {
      return { ok: false, error: `Application ${appNumber} already exists for this subcontractor` };
    }
    return { ok: false, error: appErr?.message ?? "Could not save the bill" };
  }

  const { error: lineErr } = await db.from("sub_pay_app_lines").insert(
    lines.map((l) => ({
      sub_pay_app_id: app.id,
      sub_sov_line_id: l.sub_sov_line_id,
      item_number: l.item_number,
      description: l.description,
      scheduled_value: l.scheduled_value,
      from_previous: l.from_previous,
      this_period: l.this_period,
      materials_stored: l.materials_stored,
      total_completed: l.total_completed,
      pct_billed: l.pct_billed,
      balance_to_finish: l.balance_to_finish,
      retainage_amount: l.retainage_amount,
      sort_order: l.sort_order,
    })),
  );
  if (lineErr) return { ok: false, error: lineErr.message };

  await runVerification(projectId, app.id);

  revalidatePath(`/projects/${projectId}/sub-billing`);
  return { ok: true, id: app.id };
}

// ---------------------------------------------------------------------------
// Run both passes over a saved bill and persist the results.
// ---------------------------------------------------------------------------
export async function runVerification(
  projectId: string,
  appId: string,
): Promise<ActionResult> {
  const auth = await requireCapability("verifySubBilling");
  if (!auth.ok) return auth;
  const db = subBillingClient();

  const { data: app } = await db
    .from("sub_pay_apps")
    .select("subcontractor_id")
    .eq("id", appId)
    .single();

  const res = await runVerificationCore(db, appId);
  if (!res.ok) return { ok: false, error: res.error ?? "Verification failed" };

  revalidatePath(`/projects/${projectId}/sub-billing/${app?.subcontractor_id}/${appId}`);
  return { ok: true, id: appId };
}

// ---------------------------------------------------------------------------
// Mapping. Confirming a line's evidence source is what turns math-checking
// into real verification, so it is recorded with who confirmed it and when.
// ---------------------------------------------------------------------------
export async function updateLineMapping(
  projectId: string,
  sovLineId: string,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireCapability("verifySubBilling");
  if (!auth.ok) return auth;
  const db = subBillingClient();

  const method = (str(formData.get("verification_method")) ?? "unmapped") as SovLine["verification_method"];
  const taskCodes = (str(formData.get("linked_task_wbs_codes")) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const commodityIds = formData.getAll("linked_commodity_ids").filter((v): v is string => typeof v === "string");

  const { error } = await db
    .from("sub_sov_lines")
    .update({
      verification_method: method as never,
      linked_task_wbs_codes: taskCodes,
      linked_commodity_ids: commodityIds,
      milestone_task_wbs_code: str(formData.get("milestone_task_wbs_code")),
      mapping_notes: str(formData.get("mapping_notes")),
      mapping_confirmed_at: new Date().toISOString(),
      mapping_confirmed_by: auth.userId,
    })
    .eq("id", sovLineId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/sub-billing`);
  return { ok: true, id: sovLineId };
}

// ---------------------------------------------------------------------------
// The CM's line-level verdict. Percent only - the CM never sees or sets
// dollars. The dollar figure is derived from the percent he signs off on.
// ---------------------------------------------------------------------------
export async function recommendBill(
  projectId: string,
  appId: string,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireCapability("recommendSubBill");
  if (!auth.ok) return auth;
  const db = subBillingClient();

  const { data: app } = await db
    .from("sub_pay_apps")
    .select("id, subcontractor_id, status")
    .eq("id", appId)
    .single();
  if (!app) return { ok: false, error: "Bill not found" };
  if (app.status === "approved" || app.status === "paid") {
    return { ok: false, error: "This bill has already been approved" };
  }

  const { data: lines } = await db
    .from("sub_pay_app_lines")
    .select("id, item_number, scheduled_value, from_previous")
    .eq("sub_pay_app_id", appId);

  for (const line of lines ?? []) {
    const pctRaw = formData.get(`verified_pct__${line.item_number}`);
    const note = str(formData.get(`cm_note__${line.item_number}`));
    if (typeof pctRaw !== "string" || !pctRaw.trim()) {
      if (note) await db.from("sub_pay_app_lines").update({ cm_note: note }).eq("id", line.id);
      continue;
    }
    const pct = Math.max(0, Math.min(100, Number(pctRaw.replace(/[%\s]/g, "")))) / 100;
    const sv = Number(line.scheduled_value ?? 0);
    const verifiedAmount = round2(pct * sv);
    // What the CM certifies as earned this period, net of what was already
    // billed in prior applications.
    const approvedThisPeriod = Math.max(0, round2(verifiedAmount - Number(line.from_previous ?? 0)));
    await db
      .from("sub_pay_app_lines")
      .update({
        verified_pct: pct,
        verified_amount: verifiedAmount,
        verification_source: "cm",
        verification_confidence: "high",
        verification_detail: note ?? "Verified by the Construction Manager.",
        approved_this_period: approvedThisPeriod,
        cm_note: note,
      })
      .eq("id", line.id);
  }

  const { error } = await db
    .from("sub_pay_apps")
    .update({
      status: "cm_recommended" as SubPayAppStatus,
      cm_reviewed_by: auth.userId,
      cm_reviewed_at: new Date().toISOString(),
      cm_notes: str(formData.get("cm_notes")),
    })
    .eq("id", appId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/sub-billing/${app.subcontractor_id}/${appId}`);
  return { ok: true, id: appId };
}

// ---------------------------------------------------------------------------
// Final approval. Phil only. Approved totals are rolled up from the per-line
// approved amounts, so a partial approval carries all the way to the check.
// ---------------------------------------------------------------------------
export async function decideBill(
  projectId: string,
  appId: string,
  decision: "approved" | "rejected",
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireCapability("approveSubBilling");
  if (!auth.ok) return auth;
  const db = subBillingClient();

  const { data: app } = await db
    .from("sub_pay_apps")
    .select("id, subcontractor_id, retainage_pct, billed_this_period, retainage_to_date")
    .eq("id", appId)
    .single();
  if (!app) return { ok: false, error: "Bill not found" };

  if (decision === "rejected") {
    const { error } = await db
      .from("sub_pay_apps")
      .update({
        status: "rejected" as SubPayAppStatus,
        approved_by: auth.userId,
        approved_at: new Date().toISOString(),
        approval_notes: str(formData.get("approval_notes")),
      })
      .eq("id", appId);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/projects/${projectId}/sub-billing/${app.subcontractor_id}/${appId}`);
    return { ok: true, id: appId };
  }

  const { data: lines } = await db
    .from("sub_pay_app_lines")
    .select("id, item_number, this_period, approved_this_period")
    .eq("sub_pay_app_id", appId);

  // Any line Phil overrode on the approval form wins; otherwise take the CM's
  // approved figure; otherwise, absent any decision, the amount as billed.
  let approvedTotal = 0;
  for (const line of lines ?? []) {
    const override = optNum(formData.get(`approved__${line.item_number}`));
    const amount =
      override ?? (line.approved_this_period != null ? Number(line.approved_this_period) : Number(line.this_period ?? 0));
    approvedTotal += amount;
    if (override != null) {
      await db.from("sub_pay_app_lines").update({ approved_this_period: override }).eq("id", line.id);
    } else if (line.approved_this_period == null) {
      await db.from("sub_pay_app_lines").update({ approved_this_period: amount }).eq("id", line.id);
    }
  }
  approvedTotal = round2(approvedTotal);
  const rate = Number(app.retainage_pct ?? 0) / 100;
  const approvedRetainage = round2(approvedTotal * rate);

  const { error } = await db
    .from("sub_pay_apps")
    .update({
      status: "approved" as SubPayAppStatus,
      approved_this_period: approvedTotal,
      approved_retainage: approvedRetainage,
      approved_amount_due: round2(approvedTotal - approvedRetainage),
      approved_by: auth.userId,
      approved_at: new Date().toISOString(),
      approval_notes: str(formData.get("approval_notes")),
    })
    .eq("id", appId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/sub-billing/${app.subcontractor_id}/${appId}`);
  return { ok: true, id: appId };
}

export async function markBillPaid(
  projectId: string,
  appId: string,
  paidOn: string,
): Promise<ActionResult> {
  const auth = await requireCapability("approveSubBilling");
  if (!auth.ok) return auth;
  const db = subBillingClient();
  const { data: app } = await db
    .from("sub_pay_apps")
    .select("subcontractor_id")
    .eq("id", appId)
    .single();
  const { error } = await db
    .from("sub_pay_apps")
    .update({ status: "paid" as SubPayAppStatus, paid_at: paidOn })
    .eq("id", appId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}/sub-billing/${app?.subcontractor_id}/${appId}`);
  return { ok: true, id: appId };
}
