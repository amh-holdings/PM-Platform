"use server";

import { revalidatePath } from "next/cache";

import { subBillingClient } from "@/lib/sub-billing-db";
import { createClient } from "@/lib/supabase/server";
import { can, toEffectiveRole, type Capability } from "@/lib/roles";
import { runVerificationCore } from "@/lib/sub-billing-run";
import { approvedToDateByItem, type BillHeader, type BillLine, type SovLine } from "@/lib/sub-billing";
import { parsePastedSovLines } from "@/lib/sub-sov-import";
import type { SubBillingClient, SubPayAppStatus } from "@/lib/sub-billing.types";

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

// ---------------------------------------------------------------------------
// SOV maintenance.
//
// The executed schedule of values is the spine of everything else on this
// screen: the bill entry form is built from it, the verification engine reads
// the mapping off it, and the projection prices its percentages against it.
// Until now those rows could only be loaded by a one-off import script, which
// meant a sub whose SOV was not scripted in could never be billed through the
// platform at all.
//
// These four actions are Phil-only (`enterSubBill`). Scheduled values are
// dollars, and the whole point of the CM's percent-only view is that he judges
// the work without seeing the money - letting him edit the SOV would hand back
// exactly what that split withholds.
// ---------------------------------------------------------------------------

type SovLineFields = {
  item_number: string;
  description: string;
  section_code: string | null;
  section_name: string | null;
  scheduled_value: number;
  quantity: number | null;
  unit: string | null;
  unit_cost: number | null;
  is_change_order: boolean;
  change_order_ref: string | null;
  sort_order: number | null;
};

function readSovFields(formData: FormData): SovLineFields | { error: string } {
  const itemNumber = str(formData.get("item_number"));
  const description = str(formData.get("description"));
  if (!itemNumber) return { error: "Item number is required" };
  if (!description) return { error: "Description is required" };

  const scheduledValue = optNum(formData.get("scheduled_value"));
  if (scheduledValue == null) return { error: "Scheduled value is required" };

  const quantity = optNum(formData.get("quantity"));
  const unitCost = optNum(formData.get("unit_cost"));

  return {
    item_number: itemNumber,
    description,
    section_code: str(formData.get("section_code")),
    section_name: str(formData.get("section_name")),
    scheduled_value: round2(scheduledValue),
    quantity,
    unit: str(formData.get("unit")),
    // A unit-price line pasted with a quantity and an extended value but no
    // rate can still carry one, and the verification engine reads it.
    unit_cost: unitCost ?? (quantity && quantity !== 0 ? scheduledValue / quantity : null),
    is_change_order: formData.get("is_change_order") === "on",
    change_order_ref: str(formData.get("change_order_ref")),
    sort_order: optNum(formData.get("sort_order")),
  };
}

/** The end of the current sort order, so a new line lands at the bottom. */
async function nextSortOrder(db: SubBillingClient, subcontractorId: string): Promise<number> {
  // Postgres sorts nulls first on a descending order, so an unordered row
  // would otherwise answer this query and restart numbering at 10.
  const { data } = await db
    .from("sub_sov_lines")
    .select("sort_order")
    .eq("subcontractor_id", subcontractorId)
    .not("sort_order", "is", null)
    .order("sort_order", { ascending: false })
    .limit(1);
  return Number(data?.[0]?.sort_order ?? 0) + 10;
}

export async function createSovLine(
  projectId: string,
  subcontractorId: string,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireCapability("enterSubBill");
  if (!auth.ok) return auth;
  const db = subBillingClient();

  const fields = readSovFields(formData);
  if ("error" in fields) return { ok: false, error: fields.error };

  const { data, error } = await db
    .from("sub_sov_lines")
    .insert({
      project_id: projectId,
      subcontractor_id: subcontractorId,
      ...fields,
      sort_order: fields.sort_order ?? (await nextSortOrder(db, subcontractorId)),
      verification_method: (str(formData.get("verification_method")) ?? "unmapped") as never,
      active: true,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `Item ${fields.item_number} already exists on this SOV` };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${projectId}/sub-billing/${subcontractorId}`);
  revalidatePath(`/projects/${projectId}/sub-billing`);
  return { ok: true, id: data.id };
}

export async function updateSovLine(
  projectId: string,
  sovLineId: string,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireCapability("enterSubBill");
  if (!auth.ok) return auth;
  const db = subBillingClient();

  const fields = readSovFields(formData);
  if ("error" in fields) return { ok: false, error: fields.error };

  const { data: existing } = await db
    .from("sub_sov_lines")
    .select("id, subcontractor_id, item_number")
    .eq("id", sovLineId)
    .single();
  if (!existing) return { ok: false, error: "SOV line not found" };

  // item_number is the key every recorded bill line carries and the key the
  // previously-billed baseline is looked up by. Renumbering a line that has
  // already been billed would orphan that history and reset the line's
  // previous column to zero, handing the sub the same money twice.
  if (fields.item_number !== existing.item_number) {
    const { count } = await db
      .from("sub_pay_app_lines")
      .select("id", { count: "exact", head: true })
      .eq("sub_sov_line_id", sovLineId);
    if ((count ?? 0) > 0) {
      return {
        ok: false,
        error: `Item ${existing.item_number} has already been billed, so its item number cannot be changed. Everything else on the line can still be edited.`,
      };
    }
  }

  // The edit form carries no sort_order input, so writing the parsed value
  // back would null out the ordering of every line that gets edited.
  const { sort_order, ...editable } = fields;
  const patch = sort_order == null ? editable : fields;

  const { error } = await db.from("sub_sov_lines").update(patch).eq("id", sovLineId);
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `Item ${fields.item_number} already exists on this SOV` };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${projectId}/sub-billing/${existing.subcontractor_id}`);
  revalidatePath(`/projects/${projectId}/sub-billing`);
  return { ok: true, id: sovLineId };
}

/**
 * Removes a line. A line that has never been billed is deleted outright; one
 * that appears on a recorded bill is retired instead, because the bill lines
 * point at it and an approved application has to stay reconstructible.
 */
export async function removeSovLine(
  projectId: string,
  sovLineId: string,
): Promise<ActionResult> {
  const auth = await requireCapability("enterSubBill");
  if (!auth.ok) return auth;
  const db = subBillingClient();

  const { data: existing } = await db
    .from("sub_sov_lines")
    .select("id, subcontractor_id")
    .eq("id", sovLineId)
    .single();
  if (!existing) return { ok: false, error: "SOV line not found" };

  const { count } = await db
    .from("sub_pay_app_lines")
    .select("id", { count: "exact", head: true })
    .eq("sub_sov_line_id", sovLineId);

  const { error } =
    (count ?? 0) > 0
      ? await db.from("sub_sov_lines").update({ active: false }).eq("id", sovLineId)
      : await db.from("sub_sov_lines").delete().eq("id", sovLineId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/sub-billing/${existing.subcontractor_id}`);
  revalidatePath(`/projects/${projectId}/sub-billing`);
  return { ok: true, id: sovLineId };
}

/**
 * Loads a whole SOV from a pasted spreadsheet range.
 *
 * Existing item numbers are updated in place rather than duplicated, so a
 * re-paste after a change order keeps every confirmed mapping instead of
 * throwing the evidence links away and starting over as unmapped.
 */
export async function importSovLines(
  projectId: string,
  subcontractorId: string,
  formData: FormData,
): Promise<ActionResult & { imported?: number; updated?: number; skipped?: string[] }> {
  const auth = await requireCapability("enterSubBill");
  if (!auth.ok) return auth;
  const db = subBillingClient();

  const text = typeof formData.get("paste") === "string" ? String(formData.get("paste")) : "";
  if (!text.trim()) return { ok: false, error: "Nothing pasted" };

  const parsed = parsePastedSovLines(text);
  if (parsed.lines.length === 0) {
    return {
      ok: false,
      error:
        parsed.skipped.length > 0
          ? `No lines could be read. First problem: row ${parsed.skipped[0].row} - ${parsed.skipped[0].reason}`
          : "No lines could be read from that paste",
    };
  }

  const { data: existingRows } = await db
    .from("sub_sov_lines")
    .select("id, item_number, sort_order")
    .eq("subcontractor_id", subcontractorId);
  const existing = new Map((existingRows ?? []).map((r) => [r.item_number.toLowerCase(), r]));

  // Auto-numbering for a paste with no item column, continuing past whatever
  // is already on the SOV rather than colliding with it.
  let autoSeed = 0;
  for (const r of existingRows ?? []) {
    const n = Number(r.item_number.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n)) autoSeed = Math.max(autoSeed, Math.floor(n));
  }
  // Item numbers spoken for either by the existing SOV or by an earlier row of
  // this same paste. Without this, five unnumbered rows pasted alongside an
  // explicit item 5 both land on "5" and the whole insert fails on the unique
  // key with a raw Postgres error.
  const claimed = new Set(existing.keys());
  const nextAuto = () => {
    do autoSeed += 1;
    while (claimed.has(String(autoSeed).toLowerCase()));
    return String(autoSeed);
  };

  let sortOrder = await nextSortOrder(db, subcontractorId);
  const isChangeOrder = formData.get("is_change_order") === "on";
  const changeOrderRef = str(formData.get("change_order_ref"));

  const inserts: Record<string, unknown>[] = [];
  let updated = 0;

  for (const line of parsed.lines) {
    const itemNumber = line.itemNumber ?? nextAuto();
    claimed.add(itemNumber.toLowerCase());
    const prior = existing.get(itemNumber.toLowerCase());
    const shared = {
      description: line.description,
      scheduled_value: line.scheduledValue,
      quantity: line.quantity,
      unit: line.unit,
      unit_cost:
        line.unitCost ??
        (line.quantity && line.quantity !== 0 ? line.scheduledValue / line.quantity : null),
      section_name: line.sectionName,
    };

    if (prior) {
      // Deliberately does NOT touch verification_method, the evidence links or
      // the mapping confirmation. Those are the expensive part to rebuild.
      const { error } = await db.from("sub_sov_lines").update(shared).eq("id", prior.id);
      if (error) return { ok: false, error: error.message };
      updated += 1;
      continue;
    }

    inserts.push({
      project_id: projectId,
      subcontractor_id: subcontractorId,
      item_number: itemNumber,
      ...shared,
      is_change_order: isChangeOrder,
      change_order_ref: changeOrderRef,
      verification_method: "unmapped",
      sort_order: sortOrder,
      active: true,
    });
    sortOrder += 10;
  }

  if (inserts.length > 0) {
    const { error } = await db.from("sub_sov_lines").insert(inserts as never);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${projectId}/sub-billing/${subcontractorId}`);
  revalidatePath(`/projects/${projectId}/sub-billing`);
  return {
    ok: true,
    imported: inserts.length,
    updated,
    skipped: parsed.skipped.map((s) => `Row ${s.row}: ${s.reason}`),
  };
}
