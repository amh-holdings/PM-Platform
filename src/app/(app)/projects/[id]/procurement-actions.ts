"use server";

import { revalidatePath } from "next/cache";

import { resolveBillingPeriod } from "@/lib/billing-period-resolve";
import {
  defaultAfpAmountForPo,
  hasBillingEvidence,
  pickAfpTargetLine,
} from "@/lib/billing-progress";
import { recordedPayment } from "@/lib/progress";
import { resolveNetTerms } from "@/lib/po-payment-forecast";

import type { ProcurementImportPlan } from "@/lib/procurement-import";
import {
  applyPoContribution,
  contributionTotal,
  overwriteWarning,
  planUndo,
  type PoAfpStanding,
  type PoContribution,
} from "@/lib/afp-po-staging";
import {
  splitDeliveryLinkChoices,
  type DeliveryLinkChoice,
} from "@/lib/schedule-po-delivery";
import { createClient } from "@/lib/supabase/server";
import { parseDraftLines, totalForNewPo } from "@/lib/procurement-lines";
import { formatCurrency } from "@/lib/format";
import type { TablesInsert, TablesUpdate } from "@/lib/database.types";

async function assertAhcUser() {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false as const, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || !["phil", "zarina", "ahc_super"].includes(profile.role)) {
    return { ok: false as const, error: "Restricted to AHC team members" };
  }
  return { ok: true as const, supabase, userId: user.id };
}

function getStr(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}
function getNum(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const n = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
/**
 * Net terms as a whole number of days, or null for "not stated".
 *
 * Blank stays null so the milestone keeps falling back to the PO's number,
 * and then to the summary, rather than quietly becoming same-day payment.
 * Zero is kept, because zero is somebody answering the question. Anything
 * outside 0 to 365 is a typo and is dropped rather than stored, matching the
 * check on the column.
 */
function getNetTermsDays(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n)) return null;
  const days = Math.trunc(n);
  return days >= 0 && days <= 365 ? days : null;
}

/**
 * Write a milestone's net_terms_days on its own, after the row is saved.
 *
 * Migration 0064 adds the column. A write naming a column that does not exist
 * fails the whole statement, so this cannot ride along in the insert or the
 * update: a milestone would refuse to save over one number somebody may not
 * even have typed. It is deliberately not reported either, because until 0064
 * runs the forecast falls back to the order's number and then to the summary
 * exactly as it does today, which is the behaviour being replaced, not lost.
 */
async function writeMilestoneNetTerms(
  supabase: ReturnType<typeof createClient>,
  milestoneId: string,
  formData: FormData,
): Promise<void> {
  if (!formData.has("net_terms_days")) return;
  await supabase
    .from("procurement_payments")
    .update({
      net_terms_days: getNetTermsDays(formData.get("net_terms_days")),
    } as unknown as TablesUpdate<"procurement_payments">)
    .eq("id", milestoneId);
}

function getDate(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value;
}

export type ProcurementOrderResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function createProcurementOrder(
  projectId: string,
  formData: FormData,
): Promise<ProcurementOrderResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const vendor = getStr(formData.get("vendor_name"));
  if (!vendor) {
    return { ok: false, error: "Vendor name is required", fieldErrors: { vendor_name: "Required" } };
  }

  // Line items typed on the form, before the PO had an id to hang them off.
  const draftLines = parseDraftLines(formData.get("draft_lines"));
  const salesTax = getNum(formData.get("sales_tax"));
  const freight = getNum(formData.get("freight"));

  const insert: TablesInsert<"procurement_orders"> = {
    project_id: projectId,
    vendor_name: vendor,
    po_number: getStr(formData.get("po_number")),
    description: getStr(formData.get("description")),
    // A typed total always wins. Only a blank one takes the line table, which
    // is what the form tells people to do.
    total_value: totalForNewPo({
      typedTotal: getNum(formData.get("total_value")),
      lines: draftLines,
      salesTax,
      freight,
    }),
    ordered_date: getDate(formData.get("ordered_date")),
    expected_delivery_date: getDate(formData.get("expected_delivery_date")),
    actual_delivery_date: getDate(formData.get("actual_delivery_date")),
    status: getStr(formData.get("status")) ?? "active",
    payment_terms_summary: getStr(formData.get("payment_terms_summary")),
    document_id: getStr(formData.get("document_id")),
    notes: getStr(formData.get("notes")),
  };

  const { data, error } = await auth.supabase
    .from("procurement_orders")
    .insert(insert)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  // Tax and freight live on the order. Migration 0061; without it the PO is
  // already saved and these two figures are what is lost, not the PO.
  if (salesTax !== null || freight !== null) {
    await auth.supabase
      .from("procurement_orders")
      .update({ sales_tax: salesTax, freight } as unknown as TablesUpdate<"procurement_orders">)
      .eq("id", data.id);
  }

  // Net terms, same reasoning, migration 0063. Written separately and not
  // reported, because a PO that refuses to save over one number somebody may
  // not even have typed is the worse outcome. Until 0063 runs the forecast
  // reads "Net NN" out of the summary exactly as it did before.

  // The lines go in after the order exists. A failure here is reported rather
  // than swallowed, and the PO stays: losing the vendor, the dates and the
  // contract link over a line table would be the worse outcome by far.
  if (draftLines.length > 0) {
    const { error: linesErr } = await auth.supabase
      .from("procurement_order_lines")
      .insert(
        draftLines.map((l, i) => ({
          procurement_order_id: data.id,
          line_no: l.lineNo,
          sort_order: l.lineNo ?? i + 1,
          quantity: l.quantity,
          description: l.description,
          units: l.units,
          unit_price: l.unitPrice,
          extended_price: l.extendedPrice,
        })) as unknown as TablesInsert<"procurement_order_lines">[],
      );
    if (linesErr) {
      revalidatePath(`/projects/${projectId}/procurement`);
      return {
        ok: false,
        error: isMissingLines(linesErr)
          ? `${vendor} was saved, but its line items need database migration 0061. Add them from the PO page once it has run.`
          : `${vendor} was saved, but its line items did not: ${linesErr.message}`,
      };
    }
  }

  revalidatePath(`/projects/${projectId}/procurement`);
  return { ok: true, id: data.id };
}

export async function updateProcurementOrder(
  poId: string,
  projectId: string,
  formData: FormData,
): Promise<ProcurementOrderResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const update: TablesUpdate<"procurement_orders"> = {
    vendor_name: getStr(formData.get("vendor_name")) ?? undefined,
    po_number: getStr(formData.get("po_number")),
    description: getStr(formData.get("description")),
    total_value: getNum(formData.get("total_value")),
    ordered_date: getDate(formData.get("ordered_date")),
    expected_delivery_date: getDate(formData.get("expected_delivery_date")),
    actual_delivery_date: getDate(formData.get("actual_delivery_date")),
    status: getStr(formData.get("status")) ?? undefined,
    payment_terms_summary: getStr(formData.get("payment_terms_summary")),
    document_id: getStr(formData.get("document_id")),
    notes: getStr(formData.get("notes")),
  };
  const { error } = await auth.supabase
    .from("procurement_orders")
    .update(update)
    .eq("id", poId);
  if (error) return { ok: false, error: error.message };


  revalidatePath(`/projects/${projectId}/procurement`);
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  return { ok: true, id: poId };
}

export async function deleteProcurementOrder(
  poId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const { error } = await auth.supabase
    .from("procurement_orders")
    .delete()
    .eq("id", poId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}/procurement`);
  return { ok: true };
}

// ============ MILESTONES ============

export type MilestoneResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * A payment milestone moves three pages, not one.
 *
 * buildProjection reads procurement_payments directly and buckets each one by
 * paid_at ?? expected_date, so a paid date IS the cash-out month on the
 * dashboard chart. estimateProcurementProgress reads the same rows to decide
 * what a procurement SOV line has earned, which drives the billing panel.
 *
 * All four milestone actions revalidated the PO page alone, so the two pages
 * the data actually feeds kept serving a cached render. Meanwhile the SOV
 * allocation actions - which nothing reads when billing - revalidated the
 * dashboard on every call. Exactly backwards.
 */
function revalidateMilestone(projectId: string, poId: string) {
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  revalidatePath(`/projects/${projectId}/procurement`);
  // Cash-out month and the cash flow chart.
  revalidatePath(`/projects/${projectId}`);
  // What a procurement line has earned, and so what it can bill.
  revalidatePath(`/projects/${projectId}/billing`);
}

export async function addMilestone(
  poId: string,
  projectId: string,
  formData: FormData,
): Promise<MilestoneResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const name = getStr(formData.get("milestone_name"));
  if (!name) return { ok: false, error: "Milestone name required" };

  const pct = getNum(formData.get("pct_of_total"));
  const amount = getNum(formData.get("amount"));

  // If pct is set but amount is missing, compute amount from pct * total_value
  let computedAmount = amount;
  if (computedAmount == null && pct != null) {
    const { data: po } = await auth.supabase
      .from("procurement_orders")
      .select("total_value")
      .eq("id", poId)
      .maybeSingle();
    const total = Number(po?.total_value ?? 0);
    computedAmount = total * (pct / 100);
  }

  // Recording a payment that already happened, in one step.
  //
  // Most POs on a job that predates the app were paid before anyone was
  // entering milestones, and their cost is then in the forecast nowhere at
  // all - the projection skips a cost code tied to a PO, on the assumption
  // the PO's milestones supply it. Adding a milestone and then marking it
  // paid is two actions for something that is one fact.
  const paid = recordedPayment(computedAmount, getDate(formData.get("paid_at")));
  if (!paid.ok) return paid;

  const insert: TablesInsert<"procurement_payments"> = {
    procurement_order_id: poId,
    milestone_name: name,
    pct_of_total: pct,
    trigger_event: getStr(formData.get("trigger_event")),
    expected_date: getDate(formData.get("expected_date")),
    amount: computedAmount,
    paid_at: paid.paid_at,
    paid_amount: paid.paid_amount,
    sort_order: getNum(formData.get("sort_order")),
    notes: getStr(formData.get("notes")),
  };

  const { data, error } = await auth.supabase
    .from("procurement_payments")
    .insert(insert)
    .select("id")
    .single();
  if (error) {
    return { ok: false, error: error.message };
  }
  await writeMilestoneNetTerms(auth.supabase, data.id, formData);
  revalidateMilestone(projectId, poId);
  return { ok: true, id: data.id };
}

export async function updateMilestone(
  milestoneId: string,
  poId: string,
  projectId: string,
  formData: FormData,
): Promise<MilestoneResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const update: TablesUpdate<"procurement_payments"> = {
    milestone_name: getStr(formData.get("milestone_name")) ?? undefined,
    pct_of_total: getNum(formData.get("pct_of_total")),
    trigger_event: getStr(formData.get("trigger_event")),
    expected_date: getDate(formData.get("expected_date")),
    amount: getNum(formData.get("amount")),
    sort_order: getNum(formData.get("sort_order")),
    notes: getStr(formData.get("notes")),
  };
  const { error } = await auth.supabase
    .from("procurement_payments")
    .update(update)
    .eq("id", milestoneId);
  if (error) return { ok: false, error: error.message };
  await writeMilestoneNetTerms(auth.supabase, milestoneId, formData);
  revalidateMilestone(projectId, poId);
  return { ok: true, id: milestoneId };
}

/**
 * Records when a milestone was paid, or clears it.
 *
 * `paidAt` null means "this was not paid after all" - these POs were paid on
 * paper long before the app, so the dates are entered from recollection and
 * a wrong one needs a way back. Clearing takes the amount with it, otherwise
 * the row reads as unpaid while still carrying money.
 */
export async function markMilestonePaid(
  milestoneId: string,
  poId: string,
  projectId: string,
  paidAt: string | null,
  paidAmount?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const patch: TablesUpdate<"procurement_payments"> = {
    paid_at: paidAt,
  };
  if (paidAt === null) patch.paid_amount = null;
  else if (paidAmount != null) patch.paid_amount = paidAmount;
  const { error } = await auth.supabase
    .from("procurement_payments")
    .update(patch)
    .eq("id", milestoneId);
  if (error) return { ok: false, error: error.message };
  revalidateMilestone(projectId, poId);
  return { ok: true };
}

// Attach an already-uploaded project_document to a procurement_orders row.
// Used by the inline "Upload signed PO" button on the PO detail page so
// the client doesn't need to re-submit the full edit form just to link
// a freshly uploaded PDF.
export async function linkProcurementDocument(
  poId: string,
  projectId: string,
  documentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("procurement_orders")
    .update({ document_id: documentId })
    .eq("id", poId)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  return { ok: true };
}

// Link a PO to a delivery schedule_task. If a wbs_code is provided, also
// sync procurement_orders.expected_delivery_date to that task's end_date
// so downstream consumers (AI extraction, cash projection) see a consistent
// delivery anchor. Pass null to clear the link.
export async function setProcurementDeliveryTaskLink(
  poId: string,
  projectId: string,
  wbsCode: string | null,
): Promise<{ ok: true; syncedDate: string | null } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  let syncedDate: string | null = null;

  if (wbsCode) {
    const { data: task, error: taskErr } = await auth.supabase
      .from("schedule_tasks")
      .select("end_date")
      .eq("project_id", projectId)
      .eq("wbs_code", wbsCode)
      .maybeSingle();
    if (taskErr) return { ok: false, error: taskErr.message };
    if (!task) {
      return { ok: false, error: `No schedule_task with wbs_code ${wbsCode} in this project` };
    }
    syncedDate = task.end_date;
  }

  const patch: {
    linked_delivery_task_wbs_code: string | null;
    expected_delivery_date?: string | null;
  } = {
    linked_delivery_task_wbs_code: wbsCode,
  };
  // Only set expected_delivery_date when we have a task date - don't
  // silently clear it if the user is just unlinking.
  if (wbsCode && syncedDate) {
    patch.expected_delivery_date = syncedDate;
  }

  const { error } = await auth.supabase
    .from("procurement_orders")
    .update(patch)
    .eq("id", poId)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/procurement`);
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, syncedDate };
}

// Mark a PO as signed (or unsigned). Only signed POs count toward
// procurement-driven billing suggestions, so this is the trigger that
// unlocks billing on a procurement-scope SOV line.
export async function setProcurementSignedStatus(
  poId: string,
  projectId: string,
  signed: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const patch: { signed_at: string | null; signed_by: string | null } = signed
    ? { signed_at: new Date().toISOString(), signed_by: auth.userId }
    : { signed_at: null, signed_by: null };

  const { error } = await auth.supabase
    .from("procurement_orders")
    .update(patch)
    .eq("id", poId)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/procurement`);
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function deleteMilestone(
  milestoneId: string,
  poId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const { error } = await auth.supabase
    .from("procurement_payments")
    .delete()
    .eq("id", milestoneId);
  if (error) return { ok: false, error: error.message };
  revalidateMilestone(projectId, poId);
  return { ok: true };
}

// ============ AI EXTRACTION OF PAYMENT MILESTONES FROM PO PDF ============

export type ExtractedMilestone = {
  milestone_name: string;
  pct_of_total: number | null;
  amount: number | null;
  trigger_event: string;
  expected_date: string | null;
  notes: string;
  /**
   * Days after the trigger this milestone pays. Migration 0064.
   *
   * Zarina: "If a PO is uploaded it will just pre-fill the columns and I will
   * just recheck and save." The relay does not return this, so it is seeded
   * here from what the PO already says and shown in the review table as a
   * number to correct rather than a blank to fill.
   */
  net_terms_days: number | null;
};

export type ExtractPoTermsResult =
  | {
      ok: true;
      milestones: ExtractedMilestone[];
      total_pct: number | null;
      payment_terms_summary: string;
      notes: string;
      source_document: string;
      elapsed_ms: number;
    }
  | { ok: false; error: string };

export async function extractPoPaymentTerms(
  procurementOrderId: string,
): Promise<ExtractPoTermsResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const relayUrl = process.env.RELAY_URL;
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (!relayUrl || !relaySecret) {
    return {
      ok: false,
      error:
        "PO extraction is not configured on this deployment. RELAY_URL and RELAY_SHARED_SECRET must be set (relay must be running).",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${relayUrl}/extract-po-payment-terms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${relaySecret}`,
      },
      body: JSON.stringify({ procurement_order_id: procurementOrderId }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { ok: false, error: `Could not reach the relay: ${msg}` };
  }

  if (!response.ok) {
    let errText = `Relay returned ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error) errText = data.error;
    } catch {
      // ignore
    }
    return { ok: false, error: errText };
  }

  const data = await response.json();
  const summary: string = data.payment_terms_summary ?? "";

  // Pre-fill the net terms column rather than handing back an empty one.
  //
  // The relay reads the PDF for the payment SCHEDULE - the names, the
  // percentages, what each one fires on - and says nothing about how long
  // after that the money goes. That half is already on record in two places,
  // so use them: the number on the PO if 0063 found one, otherwise the "Net
  // NN" in the summary the relay just read back. Every extracted row starts
  // on the same number, which is right far more often than blank is, and the
  // review table is where a row that differs gets corrected before Apply.
  const { data: poRow } = await auth.supabase
    .from("procurement_orders")
    .select("*")
    .eq("id", procurementOrderId)
    .maybeSingle();
  const seeded = resolveNetTerms({
    net_terms_days:
      (poRow as { net_terms_days?: number | null } | null)?.net_terms_days ??
      null,
    payment_terms_summary: summary || (poRow?.payment_terms_summary ?? null),
  });

  const milestones: ExtractedMilestone[] = (data.milestones ?? []).map(
    (m: Partial<ExtractedMilestone>) => ({
      milestone_name: m.milestone_name ?? "",
      pct_of_total: m.pct_of_total ?? null,
      amount: m.amount ?? null,
      trigger_event: m.trigger_event ?? "",
      expected_date: m.expected_date ?? null,
      notes: m.notes ?? "",
      net_terms_days: m.net_terms_days ?? (seeded > 0 ? seeded : null),
    }),
  );

  return {
    ok: true,
    milestones,
    total_pct: data.total_pct ?? null,
    payment_terms_summary: summary,
    notes: data.notes ?? "",
    source_document: data.source_document ?? "",
    elapsed_ms: data.elapsed_ms ?? 0,
  };
}

// Bulk-insert the milestones the user confirmed. Always replaces existing
// procurement_payments for this PO (atomically, via delete-then-insert).
export async function applyExtractedMilestones(
  procurementOrderId: string,
  projectId: string,
  milestones: ExtractedMilestone[],
  paymentTermsSummary?: string,
): Promise<{ ok: true; inserted: number } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  if (!Array.isArray(milestones) || milestones.length === 0) {
    return { ok: false, error: "No milestones to apply" };
  }

  // Wipe any existing milestones for this PO first (since the user explicitly
  // accepted the extracted set as authoritative).
  const { error: delErr } = await auth.supabase
    .from("procurement_payments")
    .delete()
    .eq("procurement_order_id", procurementOrderId);
  if (delErr) return { ok: false, error: delErr.message };

  const rows = milestones.map((m, idx) => ({
    procurement_order_id: procurementOrderId,
    milestone_name: (m.milestone_name ?? `Milestone ${idx + 1}`).trim() || `Milestone ${idx + 1}`,
    pct_of_total: m.pct_of_total == null ? null : Number(m.pct_of_total),
    amount: m.amount == null ? null : Number(m.amount),
    trigger_event: m.trigger_event ?? null,
    expected_date: m.expected_date || null,
    notes: m.notes ?? null,
    sort_order: idx + 1,
  }));

  const { data: inserted, error: insErr } = await auth.supabase
    .from("procurement_payments")
    .insert(rows)
    .select("id");
  if (insErr) return { ok: false, error: insErr.message };

  // Net terms goes on afterwards, for the same reason it does on a single
  // milestone: naming a column that 0064 has not added yet fails the whole
  // statement, and losing an extracted payment schedule over one number is a
  // far worse trade than losing the number. Grouped by value so a PO whose
  // rows all sit on Net 30 costs one update rather than one per row.
  const ids = (inserted ?? []).map((r) => r.id);
  if (ids.length === milestones.length) {
    const byTerms = new Map<number | null, string[]>();
    milestones.forEach((m, i) => {
      const days =
        m.net_terms_days == null ? null : Math.trunc(Number(m.net_terms_days));
      const key = days != null && days >= 0 && days <= 365 ? days : null;
      if (key === null) return;
      byTerms.set(key, [...(byTerms.get(key) ?? []), ids[i]]);
    });
    for (const [days, group] of Array.from(byTerms.entries())) {
      await auth.supabase
        .from("procurement_payments")
        .update({ net_terms_days: days } as unknown as TablesUpdate<"procurement_payments">)
        .in("id", group);
    }
  }

  // Also update the PO summary line if provided.
  if (paymentTermsSummary && paymentTermsSummary.trim()) {
    await auth.supabase
      .from("procurement_orders")
      .update({ payment_terms_summary: paymentTermsSummary.trim() })
      .eq("id", procurementOrderId);
  }

  revalidatePath(`/projects/${projectId}/procurement/${procurementOrderId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, inserted: rows.length };
}

// ============ PO billing-line allocations ============
// Split a single PO's dollars across multiple SOV (billing_lines) entries.
// Use when one signed PO bundles equipment that bills against different
// scheduled-value lines (e.g. Recloser + Primary Metering on one PO).

export type AllocationInput = {
  billingLineId: string;
  amount: number;
  description?: string | null;
  sortOrder?: number | null;
};

export async function addPoBillingAllocation(
  procurementOrderId: string,
  projectId: string,
  input: AllocationInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!input.billingLineId) return { ok: false, error: "SOV line is required" };
  if (!(input.amount > 0)) return { ok: false, error: "Amount must be > 0" };

  const { data, error } = await auth.supabase
    .from("procurement_order_billing_allocations")
    .insert({
      procurement_order_id: procurementOrderId,
      billing_line_id: input.billingLineId,
      amount: input.amount,
      description: input.description ?? null,
      sort_order: input.sortOrder ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" };

  revalidatePath(`/projects/${projectId}/procurement/${procurementOrderId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: data.id };
}

export async function updatePoBillingAllocation(
  allocationId: string,
  procurementOrderId: string,
  projectId: string,
  patch: Partial<AllocationInput>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const update: TablesUpdate<"procurement_order_billing_allocations"> = {};
  if (patch.billingLineId !== undefined) update.billing_line_id = patch.billingLineId;
  if (patch.amount !== undefined) update.amount = patch.amount;
  if (patch.description !== undefined) update.description = patch.description ?? null;
  if (patch.sortOrder !== undefined) update.sort_order = patch.sortOrder ?? null;

  const { error } = await auth.supabase
    .from("procurement_order_billing_allocations")
    .update(update)
    .eq("id", allocationId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/procurement/${procurementOrderId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function deletePoBillingAllocation(
  allocationId: string,
  procurementOrderId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const { error } = await auth.supabase
    .from("procurement_order_billing_allocations")
    .delete()
    .eq("id", allocationId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/procurement/${procurementOrderId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

// ============ BULK IMPORT ============

/**
 * Apply a procurement import that the user has already seen as a diff.
 *
 * The client built the plan from what it read a moment ago, and the client is
 * not the authority on what procurement currently looks like. Everything is
 * re-checked here against the project's own rows: a PO the plan means to
 * change must still exist on this project, a PO the plan means to add must
 * still not, and every milestone must hang off a PO on this project. A stale
 * plan is refused rather than half-applied.
 *
 * Adds go in first so their milestones have an id to hang off, and a PO that
 * inserts but whose milestones fail is reported by name rather than left to be
 * discovered later on the cash projection.
 */
export type ProcurementImportResult =
  | { ok: true; added: number; changed: number; milestonesAdded: number; milestonesChanged: number }
  | { ok: false; error: string };

export async function applyProcurementImport(
  projectId: string,
  plan: ProcurementImportPlan,
): Promise<ProcurementImportResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const empty =
    !plan.adds.length &&
    !plan.changes.length &&
    !plan.milestoneAdds.length &&
    !plan.milestoneChanges.length;
  if (empty) {
    return { ok: true, added: 0, changed: 0, milestonesAdded: 0, milestonesChanged: 0 };
  }

  const { data: current, error: currentErr } = await auth.supabase
    .from("procurement_orders")
    .select("id, po_number")
    .eq("project_id", projectId);
  if (currentErr) return { ok: false, error: currentErr.message };

  const idsHere = new Set((current ?? []).map((o) => o.id));
  const poNumbersHere = new Set(
    (current ?? []).map((o) => o.po_number).filter((n): n is string => !!n),
  );

  for (const c of plan.changes) {
    if (!idsHere.has(c.id)) {
      return {
        ok: false,
        error:
          "Procurement changed while this import was open. Close the dialog and read the rows again.",
      };
    }
  }
  for (const m of plan.milestoneAdds) {
    if (!idsHere.has(m.procurement_order_id)) {
      return {
        ok: false,
        error:
          "A payment in this import points at a purchase order that is no longer on the project. Close the dialog and read the rows again.",
      };
    }
  }
  for (const a of plan.adds) {
    if (!a.po_number.trim()) return { ok: false, error: "An imported row has no PO number." };
    if (!a.vendor_name.trim()) {
      return { ok: false, error: `${a.po_number} is new and has no vendor.` };
    }
    if (poNumbersHere.has(a.po_number)) {
      return {
        ok: false,
        error: `${a.po_number} was created by someone else while this import was open. Close the dialog and read the rows again.`,
      };
    }
  }

  // Every milestone being changed has to belong to this project. Without this
  // an id from another project's PO would update a row nobody here can see.
  if (plan.milestoneChanges.length) {
    const { data: owned, error: ownedErr } = await auth.supabase
      .from("procurement_payments")
      .select("id, procurement_orders!inner(project_id)")
      .eq("procurement_orders.project_id", projectId);
    if (ownedErr) return { ok: false, error: ownedErr.message };
    const ownedIds = new Set((owned ?? []).map((m) => m.id));
    for (const c of plan.milestoneChanges) {
      if (!ownedIds.has(c.id)) {
        return {
          ok: false,
          error:
            "A payment in this import is no longer on this project. Close the dialog and read the rows again.",
        };
      }
    }
  }

  // Delivery task links are re-resolved here rather than trusted from the
  // client, for the same reason setProcurementDeliveryTaskLink resolves them:
  // the link is only worth having if the date on the PO comes from the task.
  const wanted = new Set<string>();
  for (const a of plan.adds) {
    if (a.linked_delivery_task_wbs_code) wanted.add(a.linked_delivery_task_wbs_code);
  }
  for (const c of plan.changes) {
    const w = c.patch.linked_delivery_task_wbs_code;
    if (typeof w === "string" && w) wanted.add(w);
  }
  const taskEnd = new Map<string, string | null>();
  if (wanted.size) {
    const { data: tasks, error: taskErr } = await auth.supabase
      .from("schedule_tasks")
      .select("wbs_code, end_date")
      .eq("project_id", projectId)
      .in("wbs_code", Array.from(wanted));
    if (taskErr) return { ok: false, error: taskErr.message };
    for (const t of tasks ?? []) taskEnd.set(t.wbs_code, t.end_date);
    const missing = Array.from(wanted).filter((w) => !taskEnd.has(w));
    if (missing.length) {
      return {
        ok: false,
        error: `No schedule task on this project for ${missing.join(", ")}. Import the schedule branch first.`,
      };
    }
  }

  let added = 0;
  let milestonesAdded = 0;

  for (const a of plan.adds) {
    const link = a.linked_delivery_task_wbs_code;
    const insert: TablesInsert<"procurement_orders"> = {
      project_id: projectId,
      po_number: a.po_number,
      vendor_name: a.vendor_name,
      description: a.description,
      total_value: a.total_value,
      ordered_date: a.ordered_date,
      expected_delivery_date: link
        ? (taskEnd.get(link) ?? a.expected_delivery_date)
        : a.expected_delivery_date,
      actual_delivery_date: a.actual_delivery_date,
      status: a.status,
      payment_terms_summary: a.payment_terms_summary,
      notes: a.notes,
      linked_delivery_task_wbs_code: link,
    };
    const { data: row, error } = await auth.supabase
      .from("procurement_orders")
      .insert(insert)
      .select("id")
      .single();
    if (error || !row) {
      return {
        ok: false,
        error: `Adding ${a.po_number}: ${error?.message ?? "insert failed"}. ${added} purchase order${added === 1 ? "" : "s"} before it were added.`,
      };
    }
    added += 1;

    if (a.milestones.length) {
      const rows: TablesInsert<"procurement_payments">[] = a.milestones.map((m) => ({
        procurement_order_id: row.id,
        milestone_name: m.milestone_name,
        pct_of_total: m.pct_of_total,
        trigger_event: m.trigger_event,
        expected_date: m.expected_date,
        amount: m.amount,
        paid_at: m.paid_at,
        paid_amount: m.paid_amount,
        sort_order: m.sort_order,
        notes: m.notes,
      }));
      const { error: mErr } = await auth.supabase
        .from("procurement_payments")
        .insert(rows);
      if (mErr) {
        return {
          ok: false,
          error: `${a.po_number} was added but its payments were not: ${mErr.message}`,
        };
      }
      milestonesAdded += rows.length;
    }
  }

  let changed = 0;
  for (const c of plan.changes) {
    const patch = { ...c.patch };
    const link = patch.linked_delivery_task_wbs_code;
    if (typeof link === "string" && link) {
      const end = taskEnd.get(link);
      if (end) patch.expected_delivery_date = end;
    }
    const { error } = await auth.supabase
      .from("procurement_orders")
      .update(patch as TablesUpdate<"procurement_orders">)
      .eq("id", c.id)
      .eq("project_id", projectId);
    if (error) return { ok: false, error: `Updating purchase orders: ${error.message}` };
    changed += 1;
  }

  if (plan.milestoneAdds.length) {
    const rows: TablesInsert<"procurement_payments">[] = plan.milestoneAdds.map((m) => ({
      procurement_order_id: m.procurement_order_id,
      milestone_name: m.values.milestone_name,
      pct_of_total: m.values.pct_of_total,
      trigger_event: m.values.trigger_event,
      expected_date: m.values.expected_date,
      amount: m.values.amount,
      paid_at: m.values.paid_at,
      paid_amount: m.values.paid_amount,
      sort_order: m.values.sort_order,
      notes: m.values.notes,
    }));
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await auth.supabase
        .from("procurement_payments")
        .insert(rows.slice(i, i + CHUNK));
      if (error) return { ok: false, error: `Adding payments: ${error.message}` };
      milestonesAdded += Math.min(CHUNK, rows.length - i);
    }
  }

  let milestonesChanged = 0;
  for (const c of plan.milestoneChanges) {
    const { error } = await auth.supabase
      .from("procurement_payments")
      .update(c.patch as TablesUpdate<"procurement_payments">)
      .eq("id", c.id);
    if (error) return { ok: false, error: `Updating payments: ${error.message}` };
    milestonesChanged += 1;
  }

  // Everything a PO feeds, not just the page it was imported from: the cash
  // projection dates each payment, and the billing panel reads what a
  // procurement line has earned.
  revalidatePath(`/projects/${projectId}/procurement`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/billing`);

  return { ok: true, added, changed, milestonesAdded, milestonesChanged };
}

// ---------------------------------------------------------------------------
// Add to AFP
// ---------------------------------------------------------------------------
//
// What the owner is billed for a PO is a different agreement from what we pay
// the vendor for it, and the person raising the PO knows the number. So rather
// than recording a second milestone schedule and hoping the app derives the
// right figure from it, the PO takes the figure directly and puts it on the
// pay application as an ordinary forecast row.

/** A candidate SOV line for a PO's AFP amount, with what it already carries. */
export type AfpTargetLine = {
  id: string;
  itemNumber: string;
  description: string;
  scheduledValue: number;
  /** Billed on this line across every prior AFP. */
  alreadyBilled: number;
  /** Sitting on this line for the open period, not yet on an AFP. */
  stagedThisPeriod: number;
  /**
   * How much of that is THIS purchase order's. Saving replaces this figure and
   * leaves the rest, so the difference between replacing and adding is on
   * screen before the number is typed rather than discovered afterwards.
   * Null until migration 0059 runs, where the line can only name one PO.
   */
  stagedByThisPo: number | null;
  /** This PO's share of the line, where a billing allocation says so. */
  allocated: number | null;
};

export type AfpContextResult =
  | {
      ok: true;
      periodMonth: string;
      poNumber: string | null;
      poTotalValue: number;
      /** Half the PO, the standing rule, as the box's opening value. */
      suggestedAmount: number;
      defaultBillingLineId: string | null;
      lines: AfpTargetLine[];
    }
  | { ok: false; error: string };

/**
 * Everything the Add to AFP dialog needs to open with the answer already on
 * screen: which period is being billed, which line the money lands on, what
 * that line has had, and what half this PO comes to.
 *
 * The already-billed and already-staged figures are the whole guard against
 * billing the same equipment twice. Nothing in here subtracts them for you -
 * they are shown, at the moment the number is typed, to the person deciding.
 */
export async function getPoAfpContext(
  poId: string,
  projectId: string,
): Promise<AfpContextResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data: po, error: poErr } = await auth.supabase
    .from("procurement_orders")
    .select("id, po_number, total_value")
    .eq("id", poId)
    .maybeSingle();
  if (poErr) return { ok: false, error: poErr.message };
  if (!po) return { ok: false, error: "Purchase order not found" };

  const periodMonth = await resolveBillingPeriod(auth.supabase, projectId);

  const [{ data: lines }, { data: allocations }, { data: totals }] =
    await Promise.all([
      auth.supabase
        .from("billing_lines")
        .select(
          "id, item_number, description, scheduled_value, sort_order, linked_procurement_order_ids",
        )
        .eq("project_id", projectId)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("item_number"),
      auth.supabase
        .from("procurement_order_billing_allocations")
        .select("billing_line_id, amount")
        .eq("procurement_order_id", poId),
      auth.supabase
        .from("v_billing_line_totals")
        .select("billing_line_id, total_billed")
        .eq("project_id", projectId),
    ]);

  // Selected with * rather than by name: amount_is_manual arrives in migration
  // 0056 and a named select on a column the database does not have yet errors
  // the whole request, which would take the dialog down before it opens.
  const { data: staged } = await auth.supabase
    .from("billing_entries")
    .select("*, billing_lines!inner(project_id)")
    .eq("billing_lines.project_id", projectId)
    .eq("period_month", periodMonth);

  const billedByLine = new Map<string, number>();
  for (const t of totals ?? []) {
    if (t.billing_line_id) {
      billedByLine.set(t.billing_line_id, Number(t.total_billed ?? 0));
    }
  }
  const stagedByLine = new Map<string, number>();
  const entryIdByLine = new Map<string, string>();
  for (const e of staged ?? []) {
    if (hasBillingEvidence(e)) continue;
    const id = e.billing_line_id as string | null;
    if (!id) continue;
    entryIdByLine.set(id, e.id as string);
    const amount =
      Number(e.actual_amount ?? 0) > 0
        ? Number(e.actual_amount)
        : Number(e.planned_amount ?? 0);
    stagedByLine.set(id, (stagedByLine.get(id) ?? 0) + amount);
  }

  // What THIS PO already puts on each line this period. Migration 0059; while
  // it is missing every line reports null and the dialog says so rather than
  // claiming a zero it cannot know.
  const { data: myAmounts, error: myAmountsErr } = await auth.supabase
    .from("billing_entry_po_amounts")
    .select("billing_entry_id, amount")
    .eq("procurement_order_id", poId)
    .in("billing_entry_id", Array.from(entryIdByLine.values()));
  const ledgerReadable = !myAmountsErr;
  const myByEntry = new Map<string, number>();
  for (const r of myAmounts ?? []) {
    if (!r.billing_entry_id) continue;
    myByEntry.set(
      r.billing_entry_id,
      (myByEntry.get(r.billing_entry_id) ?? 0) + Number(r.amount ?? 0),
    );
  }
  const allocByLine = new Map<string, number>();
  for (const a of allocations ?? []) {
    allocByLine.set(
      a.billing_line_id,
      (allocByLine.get(a.billing_line_id) ?? 0) + Number(a.amount ?? 0),
    );
  }

  const linkedLineIds = (lines ?? [])
    .filter((l) =>
      (
        (l as unknown as { linked_procurement_order_ids?: string[] | null })
          .linked_procurement_order_ids ?? []
      ).includes(poId),
    )
    .map((l) => l.id);

  return {
    ok: true,
    periodMonth,
    poNumber: po.po_number,
    poTotalValue: Number(po.total_value ?? 0),
    suggestedAmount: defaultAfpAmountForPo(Number(po.total_value ?? 0)),
    defaultBillingLineId: pickAfpTargetLine({
      allocations: Array.from(allocByLine, ([billingLineId, amount]) => ({
        billingLineId,
        amount,
      })),
      linkedLineIds,
    }),
    lines: (lines ?? []).map((l) => ({
      id: l.id,
      itemNumber: l.item_number ?? "",
      description: l.description ?? "",
      scheduledValue: Number(l.scheduled_value ?? 0),
      alreadyBilled: billedByLine.get(l.id) ?? 0,
      stagedThisPeriod: stagedByLine.get(l.id) ?? 0,
      stagedByThisPo: ledgerReadable
        ? myByEntry.get(entryIdByLine.get(l.id) ?? "") ?? 0
        : null,
      allocated: allocByLine.get(l.id) ?? null,
    })),
  };
}

/**
 * amount_is_manual and source_procurement_order_id arrive in migration 0056.
 * Until it runs the write fails on a column the database has never heard of,
 * and "could not find the 'amount_is_manual' column" tells nobody what to do.
 */
function missingManualAmountMessage(
  error: { code?: string; message?: string } | null,
): string | null {
  if (!error) return null;
  const missing = error.code === "42703" || error.code === "PGRST204";
  if (!missing) return null;
  if (!/amount_is_manual|source_procurement_order_id/i.test(error.message ?? "")) {
    return null;
  }
  return "Add to AFP needs database migration 0056 (AFP amount from PO). Everything else on this PO keeps working without it.";
}

export type StageAfpResult =
  | { ok: true; periodMonth: string; amount: number }
  | { ok: false; error: string };

/**
 * Put an amount from this PO on the open pay application.
 *
 * It lands as a normal forecast entry against the SOV line, flagged manual so
 * the Bill this period panel shows the typed figure instead of recomputing the
 * line from PO payment milestones on the next read. From there it is an
 * ordinary row: tick it, edit it, or leave it.
 *
 * One entry per line per month is a database constraint, not a choice, so a
 * second PO landing on the same line this period replaces the figure rather
 * than adding to it. The dialog shows what is already staged so the combined
 * number can be typed deliberately.
 */
/** Migration 0059 has not run, so the per-PO ledger is not there yet. */
function isMissingLedger(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // 42P01 undefined_table, PGRST205 unknown relation in the schema cache.
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /billing_entry_po_amounts/i.test(error.message ?? "");
}

type ContributionRead =
  | { ok: true; contributions: PoContribution[]; ledger: boolean }
  | { ok: false; error: string };

/**
 * What each PO already puts on this entry.
 *
 * Falls back to the single source column when migration 0059 has not run, so
 * a line staged from one PO still reads correctly and the caller can tell the
 * difference - `ledger: false` means a second PO cannot be added yet.
 */
async function readPoContributions(
  supabase: ReturnType<typeof createClient>,
  entry: { id: string; planned_amount?: number | null },
): Promise<ContributionRead> {
  const { data, error } = await supabase
    .from("billing_entry_po_amounts")
    .select("procurement_order_id, amount")
    .eq("billing_entry_id", entry.id);

  if (error) {
    if (!isMissingLedger(error)) return { ok: false, error: error.message };
    const row = entry as { amount_is_manual?: boolean | null; source_procurement_order_id?: string | null };
    const legacy: PoContribution[] =
      row.amount_is_manual === true && row.source_procurement_order_id
        ? [{ poId: row.source_procurement_order_id, amount: Number(entry.planned_amount ?? 0) }]
        : [];
    return { ok: true, contributions: legacy, ledger: false };
  }

  return {
    ok: true,
    ledger: true,
    contributions: (data ?? [])
      .filter((r: { procurement_order_id: string | null; amount: number | null }) =>
        r.procurement_order_id && Number(r.amount ?? 0) > 0)
      .map((r: { procurement_order_id: string | null; amount: number | null }) => ({
        poId: r.procurement_order_id as string,
        amount: Number(r.amount ?? 0),
      })),
  };
}

export async function stagePoAmountForAfp(
  poId: string,
  projectId: string,
  input: { billingLineId: string; amount: number; periodMonth?: string },
): Promise<StageAfpResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!input.billingLineId) return { ok: false, error: "Pick an SOV line" };
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, error: "Amount must be greater than zero" };
  }

  const periodMonth =
    input.periodMonth ?? (await resolveBillingPeriod(auth.supabase, projectId));

  const { data: existing, error: readErr } = await auth.supabase
    .from("billing_entries")
    .select("*")
    .eq("billing_line_id", input.billingLineId)
    .eq("period_month", periodMonth)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };

  // Money that already went out is not a forecast any more. Overwriting it
  // here would rewrite a submitted AFP's own line from the PO page.
  if (existing && hasBillingEvidence(existing)) {
    return {
      ok: false,
      error: `This line is already on AFP ${existing.afp_number ?? "an application"} for ${periodMonth.slice(0, 7)}. Bill the next period instead.`,
    };
  }

  // What each PO already puts on this line this period.
  const prior = existing
    ? await readPoContributions(auth.supabase, existing)
    : { ok: true as const, contributions: [] as PoContribution[], ledger: true };
  if (!prior.ok) return { ok: false, error: prior.error };

  // Without the ledger an entry can only name one source PO, so a second one
  // would silently replace the first - the exact bug this is fixing. Refuse
  // and say why rather than take the money off the line.
  if (!prior.ledger) {
    const otherPoId =
      (existing as { source_procurement_order_id?: string | null } | null)
        ?.source_procurement_order_id ?? null;
    const legacyPoLabel = new Map<string, string>();
    if (otherPoId) {
      const { data: otherPo } = await auth.supabase
        .from("procurement_orders")
        .select("id, po_number, vendor_name")
        .eq("id", otherPoId)
        .maybeSingle();
      if (otherPo) {
        legacyPoLabel.set(
          otherPo.id,
          otherPo.po_number ?? otherPo.vendor_name ?? "another purchase order",
        );
      }
    }
    const blocked = overwriteWarning({
      existingPoId: otherPoId,
      existingAmount:
        (existing as { amount_is_manual?: boolean | null } | null)?.amount_is_manual === true
          ? Number(existing?.planned_amount ?? 0)
          : 0,
      incomingPoId: poId,
      labelOf: (id) => legacyPoLabel.get(id) ?? "another purchase order",
      formatAmount: formatCurrency,
    });
    if (blocked) return { ok: false, error: blocked };
  }

  const next = applyPoContribution(prior.contributions, poId, input.amount);
  const total = contributionTotal(next);

  const manual = {
    amount_is_manual: true,
    // Kept for the rows and readers that predate the ledger. With several POs
    // on one line it names the one most recently entered, which is the best a
    // single column can do and is why the ledger exists.
    source_procurement_order_id: poId,
  };

  let entryId = existing?.id ?? null;
  // What this staging displaces, so undoing it can put the figure back. Only
  // meaningful for the contribution that arrives first; a later one is undone
  // by re-summing the ones still there.
  const createdEntry = !existing;
  const priorPlanned = existing ? Number(existing.planned_amount ?? 0) : null;

  if (!existing) {
    const { data: inserted, error } = await auth.supabase
      .from("billing_entries")
      .insert({
        billing_line_id: input.billingLineId,
        period_month: periodMonth,
        planned_amount: total,
        status: "forecast",
        ...manual,
      } as unknown as TablesInsert<"billing_entries">)
      .select("id")
      .maybeSingle();
    if (error) {
      return { ok: false, error: missingManualAmountMessage(error) ?? error.message };
    }
    entryId = inserted?.id ?? null;
  } else {
    // actual_amount wins over planned_amount wherever an entry is read, so an
    // entry carrying one has to have both rewritten or it bills the old figure.
    const patch: Record<string, unknown> = {
      planned_amount: total,
      ...manual,
    };
    if (Number(existing.actual_amount ?? 0) !== 0) {
      patch.actual_amount = total;
    }
    // The Bill this period panel lists forecast, suggested and reviewed only.
    // An entry carrying anything else - null on a row older than migration
    // 0009, or a status some import wrote - would take the amount and then not
    // appear, which reads exactly like the save having failed. There is no
    // billing evidence on it (checked above), so forecast is the truth.
    if (!["forecast", "suggested", "reviewed"].includes(existing.status ?? "")) {
      patch.status = "forecast";
    }
    const { error } = await auth.supabase
      .from("billing_entries")
      .update(patch as unknown as TablesUpdate<"billing_entries">)
      .eq("id", existing.id);
    if (error) {
      return { ok: false, error: missingManualAmountMessage(error) ?? error.message };
    }
  }

  // The ledger is written after the entry, because it hangs off the entry's
  // id. A failure here leaves the entry carrying this PO's figure alone, which
  // is what the app did before the ledger existed - worse than the sum, never
  // wrong about this PO.
  if (entryId && prior.ledger) {
    // Correcting a figure this PO already has must not rewrite what that
    // contribution originally displaced - the entry's planned_amount now
    // INCLUDES this PO, so storing it would make undo restore the staged
    // figure instead of the forecast underneath it.
    const alreadyMine = prior.contributions.some((c) => c.poId === poId);
    const row = alreadyMine
      ? {
          billing_entry_id: entryId,
          procurement_order_id: poId,
          amount: input.amount,
          updated_at: new Date().toISOString(),
        }
      : {
          billing_entry_id: entryId,
          procurement_order_id: poId,
          amount: input.amount,
          created_entry: createdEntry,
          prior_planned_amount: priorPlanned,
          updated_at: new Date().toISOString(),
        };
    const { error } = await auth.supabase
      .from("billing_entry_po_amounts")
      .upsert(row as never, {
        onConflict: "billing_entry_id,procurement_order_id",
      });
    if (error && !isMissingLedger(error)) {
      return { ok: false, error: error.message };
    }
  }

  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, periodMonth, amount: total };
}

// ---------------------------------------------------------------------------
// Linking from the schedule side
// ---------------------------------------------------------------------------
//
// setProcurementDeliveryTaskLink above is reached from the PO page, which is
// the wrong end of the journey for somebody working through a schedule. They
// are looking at 4.4.5.2 Delivery, they know GroundWorks delivers it, and
// leaving the schedule to go and find that PO is the step that means the link
// never gets made - which is why completing a delivery row moved nothing.
//
// Zarina: "You can put the option to link here. That's the window when you
// click open button in the schedule."

export type DeliveryLinkOption = DeliveryLinkChoice;

export type DeliveryLinkOptions =
  | {
      ok: true;
      linked: DeliveryLinkOption[];
      available: DeliveryLinkOption[];
      /** Every PO on the project, so the picker can be checked against Procurement. */
      total: number;
    }
  | { ok: false; error: string };

/**
 * The POs already delivered by this task, and the ones that could be.
 *
 * Every purchase order on the project comes back. This used to drop anything
 * cancelled, which is how Zarina ended up looking at a short list with nothing
 * on screen to explain it ("I dont see all POs here"). The picker labels state
 * now instead of filtering on it.
 */
export async function getDeliveryLinkOptions(
  projectId: string,
  wbsCode: string,
): Promise<DeliveryLinkOptions> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data, error } = await auth.supabase
    .from("procurement_orders")
    .select("id, po_number, vendor_name, status, linked_delivery_task_wbs_code, actual_delivery_date")
    .eq("project_id", projectId)
    .order("po_number", { ascending: true, nullsFirst: false });
  if (error) return { ok: false, error: error.message };

  const split = splitDeliveryLinkChoices({ pos: data ?? [], wbsCode });
  return { ok: true, ...split };
}

// ---------------------------------------------------------------------------
// Where a PO stands on the pay application, and taking it back off.
//
// Zarina: "I already added this to AFP. should say added and I would not be
// able to add again unless I undo. So once add, there should be an undo
// button. Please make sure that you are not just adding this to just one page
// but should function across all POs."
//
// Both of these read the ledger rather than the entry's single source column,
// so a line carrying two POs reports each one's own standing. There is one PO
// page for every PO, so fixing it here fixes it everywhere.
// ---------------------------------------------------------------------------

export type PoAfpStandingResult =
  | { ok: true; standing: PoAfpStanding }
  | { ok: false; error: string };

export async function getPoAfpStanding(
  poId: string,
  projectId: string,
): Promise<PoAfpStandingResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data: ledger, error } = await auth.supabase
    .from("billing_entry_po_amounts")
    .select("billing_entry_id, amount")
    .eq("procurement_order_id", poId);

  // No ledger yet (migration 0059). Fall back to the single source column,
  // which is all a pre-0059 row can tell us and is still enough to stop the
  // panel offering Add on a PO that is already on the application.
  const entryAmount = new Map<string, number>();
  if (error) {
    if (!isMissingLedger(error)) return { ok: false, error: error.message };
    const { data: legacy } = await auth.supabase
      .from("billing_entries")
      .select("*, billing_lines!inner(project_id)")
      .eq("billing_lines.project_id", projectId);
    for (const e of legacy ?? []) {
      const row = e as { amount_is_manual?: boolean | null; source_procurement_order_id?: string | null };
      if (row.amount_is_manual !== true) continue;
      if (row.source_procurement_order_id !== poId) continue;
      entryAmount.set(e.id as string, Number(e.planned_amount ?? 0));
    }
  } else {
    for (const r of ledger ?? []) {
      if (!r.billing_entry_id || Number(r.amount ?? 0) <= 0) continue;
      entryAmount.set(r.billing_entry_id, Number(r.amount));
    }
  }

  if (entryAmount.size === 0) return { ok: true, standing: { state: "none" } };

  const { data: entries, error: entriesErr } = await auth.supabase
    .from("billing_entries")
    .select("*, billing_lines!inner(project_id, item_number, description)")
    .in("id", Array.from(entryAmount.keys()))
    .order("period_month", { ascending: false });
  if (entriesErr) return { ok: false, error: entriesErr.message };

  const rows = entries ?? [];
  // A staged figure is the one to report: it is the one that can still be
  // changed from here. Only when nothing is staged does a billed one matter,
  // and then only to say the Billing page owns it now.
  const staged = rows.find((e) => !hasBillingEvidence(e));
  const target = staged ?? rows[0];
  if (!target) return { ok: true, standing: { state: "none" } };

  const line = target.billing_lines as unknown as {
    item_number: string | null;
    description: string | null;
  } | null;
  const lineLabel =
    [line?.item_number, line?.description].filter(Boolean).join(" ") || "an SOV line";
  const amount = entryAmount.get(target.id) ?? Number(target.planned_amount ?? 0);
  const periodMonth = String(target.period_month);

  if (staged) {
    return { ok: true, standing: { state: "staged", amount, lineLabel, periodMonth } };
  }
  return {
    ok: true,
    standing: {
      state: "billed",
      amount,
      lineLabel,
      periodMonth,
      afpNumber: (target.afp_number as string | null) ?? null,
    },
  };
}

export type UnstageAfpResult =
  | { ok: true; amount: number; periodMonth: string }
  | { ok: false; error: string };

/**
 * Take this PO back off the application.
 *
 * Other POs on the line are left exactly as they are and the line re-sums
 * around the gap. When this was the only one, the entry goes back to what it
 * carried before the staging displaced it - or is removed, if the staging is
 * what created it. Nothing imported is destroyed by an undo.
 */
export async function unstagePoAmountFromAfp(
  poId: string,
  projectId: string,
): Promise<UnstageAfpResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data: mine, error: mineErr } = await auth.supabase
    .from("billing_entry_po_amounts")
    .select("billing_entry_id, amount, created_entry, prior_planned_amount")
    .eq("procurement_order_id", poId);
  if (mineErr) {
    return {
      ok: false,
      error: isMissingLedger(mineErr)
        ? "Undo needs database migration 0059 and 0060. Until they run, change the amount on the Bill this period panel instead."
        : mineErr.message,
    };
  }

  const entryIds = (mine ?? [])
    .map((r) => r.billing_entry_id)
    .filter((id): id is string => !!id);
  if (entryIds.length === 0) {
    return { ok: false, error: "This PO is not on an application." };
  }

  const { data: entries, error: entriesErr } = await auth.supabase
    .from("billing_entries")
    .select("*, billing_lines!inner(project_id)")
    .in("id", entryIds);
  if (entriesErr) return { ok: false, error: entriesErr.message };

  const target = (entries ?? []).find((e) => !hasBillingEvidence(e));
  if (!target) {
    return {
      ok: false,
      error:
        "This PO is already on a submitted application. Undo the application from the Billing page rather than the PO.",
    };
  }

  const ledgerRow = (mine ?? []).find((r) => r.billing_entry_id === target.id);
  const all = await readPoContributions(auth.supabase, target);
  if (!all.ok) return { ok: false, error: all.error };

  const amount = Number(ledgerRow?.amount ?? 0);
  const plan = planUndo({
    contributions: all.contributions,
    poId,
    createdEntry: ledgerRow?.created_entry === true,
    priorPlannedAmount: ledgerRow?.prior_planned_amount ?? null,
  });

  // The contribution goes first either way. If what follows fails, the line is
  // short by this PO rather than carrying money nobody can account for.
  const { error: delErr } = await auth.supabase
    .from("billing_entry_po_amounts")
    .delete()
    .eq("billing_entry_id", target.id)
    .eq("procurement_order_id", poId);
  if (delErr) return { ok: false, error: delErr.message };

  if (plan.action === "delete_entry") {
    const { error } = await auth.supabase
      .from("billing_entries")
      .delete()
      .eq("id", target.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const patch: Record<string, unknown> = { planned_amount: plan.plannedAmount };
    if (Number(target.actual_amount ?? 0) !== 0) {
      patch.actual_amount = plan.plannedAmount;
    }
    if (plan.action === "restore") {
      // Back to being whatever it was before anybody typed on it, so the panel
      // recomputes it from milestones and the schedule the way it used to.
      patch.amount_is_manual = false;
      patch.source_procurement_order_id = null;
    } else {
      patch.source_procurement_order_id = plan.remaining[plan.remaining.length - 1]?.poId ?? null;
    }
    const { error } = await auth.supabase
      .from("billing_entries")
      .update(patch as unknown as TablesUpdate<"billing_entries">)
      .eq("id", target.id);
    if (error) {
      return { ok: false, error: missingManualAmountMessage(error) ?? error.message };
    }
  }

  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, amount, periodMonth: String(target.period_month) };
}

// ---------------------------------------------------------------------------
// Line items on a purchase order.
//
// Zarina: "I need to have option to add line items for PO forms. See PO form
// we used."
//
// The paper PO carries a table and the app carried one total and a sentence of
// free text, so the detail that makes a PO checkable against an invoice lived
// only in the PDF. Migration 0061.
// ---------------------------------------------------------------------------

/** Migration 0061 has not run yet. */
function isMissingLines(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  if (error.code === "42703" || error.code === "PGRST204") {
    return /sales_tax|freight/i.test(error.message ?? "");
  }
  return /procurement_order_lines/i.test(error.message ?? "");
}

const MISSING_LINES_MESSAGE =
  "Line items need database migration 0061. Everything else on this PO keeps working without it.";

export type PoLineRow = {
  id: string;
  lineNo: number | null;
  quantity: number | null;
  description: string | null;
  units: string | null;
  unitPrice: number | null;
  extendedPrice: number | null;
  /**
   * The schedule row this item lands on, and when it really did. Migration
   * 0062. A PO with more than one delivery links each item separately; a PO
   * that arrives on one truck leaves these null and uses the PO-level link.
   */
  linkedDeliveryTaskWbsCode: string | null;

};

export type PoLinesResult =
  | { ok: true; lines: PoLineRow[]; salesTax: number | null; freight: number | null; available: true }
  | { ok: true; lines: []; salesTax: null; freight: null; available: false }
  | { ok: false; error: string };

export async function getPoLines(poId: string): Promise<PoLinesResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data, error } = await auth.supabase
    .from("procurement_order_lines")
    .select("*")
    .eq("procurement_order_id", poId)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("line_no", { ascending: true, nullsFirst: false });
  if (error) {
    if (isMissingLines(error)) {
      return { ok: true, lines: [], salesTax: null, freight: null, available: false };
    }
    return { ok: false, error: error.message };
  }

  // Selected with * rather than by name: sales_tax and freight arrive in the
  // same migration, and a named select on a column the database does not have
  // errors the whole request.
  const { data: po } = await auth.supabase
    .from("procurement_orders")
    .select("*")
    .eq("id", poId)
    .maybeSingle();

  const row = (po ?? {}) as { sales_tax?: number | null; freight?: number | null };
  return {
    ok: true,
    available: true,
    salesTax: row.sales_tax ?? null,
    freight: row.freight ?? null,
    lines: (data ?? []).map((l) => ({
      id: l.id as string,
      lineNo: l.line_no,
      quantity: l.quantity,
      description: l.description,
      units: l.units,
      unitPrice: l.unit_price,
      extendedPrice: l.extended_price,
      // Selected with * above, so these are simply absent until 0062 runs.
      linkedDeliveryTaskWbsCode:
        (l as { linked_delivery_task_wbs_code?: string | null }).linked_delivery_task_wbs_code ??
        null,
    })),
  };
}

export type PoLineInput = {
  lineNo?: number | null;
  quantity?: number | null;
  description?: string | null;
  units?: string | null;
  unitPrice?: number | null;
  extendedPrice?: number | null;
};

function toRow(input: PoLineInput) {
  return {
    line_no: input.lineNo ?? null,
    quantity: input.quantity ?? null,
    description: input.description?.trim() || null,
    units: input.units?.trim() || null,
    unit_price: input.unitPrice ?? null,
    extended_price: input.extendedPrice ?? null,
  };
}

export async function addPoLine(
  poId: string,
  projectId: string,
  input: PoLineInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("procurement_order_lines")
    .insert({
      procurement_order_id: poId,
      sort_order: input.lineNo ?? null,
      ...toRow(input),
    } as unknown as TablesInsert<"procurement_order_lines">);
  if (error) {
    return { ok: false, error: isMissingLines(error) ? MISSING_LINES_MESSAGE : error.message };
  }
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  return { ok: true };
}

export async function updatePoLine(
  lineId: string,
  poId: string,
  projectId: string,
  input: PoLineInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("procurement_order_lines")
    .update({
      sort_order: input.lineNo ?? null,
      ...toRow(input),
    } as unknown as TablesUpdate<"procurement_order_lines">)
    .eq("id", lineId);
  if (error) {
    return { ok: false, error: isMissingLines(error) ? MISSING_LINES_MESSAGE : error.message };
  }
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  return { ok: true };
}

/** Migration 0062 has not run yet. */
function isMissingLineLink(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") {
    return /linked_delivery_task_wbs_code|actual_delivery_date|procurement_order_line_id/i.test(
      error.message ?? "",
    );
  }
  return false;
}

const MISSING_LINE_LINK_MESSAGE =
  "Per-item delivery links need database migration 0062. The PO keeps working without it, on one delivery date for the whole order.";

/**
 * Point one PO line at the schedule row it is delivered against.
 *
 * Its own action rather than a field on updatePoLine, so a project where 0062
 * has not run can still edit quantities and prices. A named column that does
 * not exist errors the whole request.
 */
export async function setPoLineDelivery(
  lineId: string,
  poId: string,
  projectId: string,
  input: { wbsCode: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  // The schedule row and nothing else. An item carries no arrival date of its
  // own. Zarina: "If the delivery date in the schedule is different on when it
  // actually arrives, I will just adjust schedule and not here."
  const patch: Record<string, unknown> = {
    linked_delivery_task_wbs_code: input.wbsCode?.trim() || null,
  };

  const { error } = await auth.supabase
    .from("procurement_order_lines")
    .update(patch as never)
    .eq("id", lineId);
  if (error) {
    if (isMissingLineLink(error)) return { ok: false, error: MISSING_LINE_LINK_MESSAGE };
    return { ok: false, error: isMissingLines(error) ? MISSING_LINES_MESSAGE : error.message };
  }
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/** Tie a payment milestone to the item it pays for, or untie it. */
export async function setMilestoneLine(
  milestoneId: string,
  poId: string,
  projectId: string,
  lineId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("procurement_payments")
    .update({ procurement_order_line_id: lineId } as never)
    .eq("id", milestoneId);
  if (error) {
    if (isMissingLineLink(error)) return { ok: false, error: MISSING_LINE_LINK_MESSAGE };
    return { ok: false, error: error.message };
  }
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function deletePoLine(
  lineId: string,
  poId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("procurement_order_lines")
    .delete()
    .eq("id", lineId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  return { ok: true };
}

export async function setPoTaxAndFreight(
  poId: string,
  projectId: string,
  input: { salesTax: number | null; freight: number | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("procurement_orders")
    .update({
      sales_tax: input.salesTax,
      freight: input.freight,
    } as unknown as TablesUpdate<"procurement_orders">)
    .eq("id", poId);
  if (error) {
    return { ok: false, error: isMissingLines(error) ? MISSING_LINES_MESSAGE : error.message };
  }
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  return { ok: true };
}

/**
 * Make the PO's value the total the lines build to.
 *
 * Never automatic. The PO value drives milestones, the procurement forecast
 * and what the owner is billed, so replacing it from a half-entered line table
 * would move money with nothing on screen. The editor shows both figures and
 * this is the deliberate act.
 */
export async function applyLineTotalToPo(
  poId: string,
  projectId: string,
  total: number,
): Promise<{ ok: true; total: number } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!Number.isFinite(total) || total < 0) {
    return { ok: false, error: "That is not a total." };
  }

  const { error } = await auth.supabase
    .from("procurement_orders")
    .update({ total_value: total } as unknown as TablesUpdate<"procurement_orders">)
    .eq("id", poId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  revalidatePath(`/projects/${projectId}/procurement`);
  revalidatePath(`/projects/${projectId}/billing`);
  return { ok: true, total };
}
