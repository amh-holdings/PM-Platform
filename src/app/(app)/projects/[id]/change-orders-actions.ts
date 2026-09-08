"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/lib/database.types";
import { coClient } from "@/lib/database.types.co";
import {
  CO_STATUS_LABELS,
  COST_CATEGORIES,
  canTransition,
  countsTowardContract,
  nextCoNumber,
  parsePastedCostLines,
  priceBuildup,
  type CoStatus,
  type CostCategory,
} from "@/lib/change-order-pricing";
import { ATTACHMENT_KINDS } from "./change-orders-constants";
import { DOCUMENT_BUCKET } from "./documents-constants";

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

export type CreateChangeOrderInput = {
  projectId: string;
  coNumber: string;
  description: string | null;
  coValue: number;
  costAmount: number | null;
  profitPct: number | null;
  scheduleImpactDays: number | null;
  status: string;
  submittedAt: string | null;
  approvedAt: string | null;
  notes: string | null;
  dateOfChangeOrder?: string | null;
};

export type CreateChangeOrderResult =
  | { ok: true; coId: string }
  | { ok: false; error: string };

export async function createChangeOrder(
  input: CreateChangeOrderInput,
): Promise<CreateChangeOrderResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!input.coNumber?.trim()) return { ok: false, error: "CO number is required" };
  if (!(input.coValue >= 0)) return { ok: false, error: "CO value must be >= 0" };
  if (!canTransition("draft", input.status) && input.status !== "draft") {
    return { ok: false, error: `A new change order cannot start as ${input.status}` };
  }

  const { data, error } = await coClient(auth.supabase)
    .from("change_orders")
    .insert({
      project_id: input.projectId,
      date_of_change_order: input.dateOfChangeOrder ?? null,
      co_number: input.coNumber.trim(),
      description: input.description,
      co_value: input.coValue,
      cost_amount: input.costAmount,
      profit_pct: input.profitPct,
      schedule_impact_days: input.scheduleImpactDays,
      status: input.status || "draft",
      submitted_at: input.submittedAt,
      approved_at: input.approvedAt,
      notes: input.notes,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" };

  revalidatePath(`/projects/${input.projectId}/change-orders`);
  revalidatePath(`/projects/${input.projectId}`, "layout");
  return { ok: true, coId: data.id };
}

export type UpdateChangeOrderInput = Partial<Omit<CreateChangeOrderInput, "projectId">>;

export async function updateChangeOrder(
  coId: string,
  projectId: string,
  patch: UpdateChangeOrderInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const update: TablesUpdate<"change_orders"> = {};
  if (patch.coNumber !== undefined) update.co_number = patch.coNumber.trim();
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.coValue !== undefined) update.co_value = patch.coValue;
  if (patch.costAmount !== undefined) update.cost_amount = patch.costAmount;
  if (patch.profitPct !== undefined) update.profit_pct = patch.profitPct;
  if (patch.scheduleImpactDays !== undefined) update.schedule_impact_days = patch.scheduleImpactDays;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.submittedAt !== undefined) update.submitted_at = patch.submittedAt;
  if (patch.approvedAt !== undefined) update.approved_at = patch.approvedAt;
  if (patch.notes !== undefined) update.notes = patch.notes;

  const { error } = await auth.supabase
    .from("change_orders")
    .update(update)
    .eq("id", coId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/change-orders`);
  revalidatePath(`/projects/${projectId}/change-orders/${coId}`);
  revalidatePath(`/projects/${projectId}`, "layout");
  return { ok: true };
}

export async function deleteChangeOrder(
  coId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  // Detach billing_lines (FK is on delete set null already, but be explicit)
  await auth.supabase
    .from("billing_lines")
    .update({ change_order_id: null })
    .eq("change_order_id", coId);

  const { error } = await auth.supabase
    .from("change_orders")
    .delete()
    .eq("id", coId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/change-orders`);
  revalidatePath(`/projects/${projectId}`, "layout");
  return { ok: true };
}

export type AddCoBillingLineInput = {
  projectId: string;
  changeOrderId: string;
  itemNumber: string;
  description: string;
  scheduledValue: number;
};

export async function addCoBillingLine(
  input: AddCoBillingLineInput,
): Promise<{ ok: true; lineId: string } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!input.itemNumber?.trim()) return { ok: false, error: "Item number required" };
  if (!input.description?.trim()) return { ok: false, error: "Description required" };

  // Place after the highest existing sort_order
  const { data: maxRow } = await auth.supabase
    .from("billing_lines")
    .select("sort_order")
    .eq("project_id", input.projectId)
    .order("sort_order", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const sortOrder = (maxRow?.sort_order ?? 0) + 10;

  const { data, error } = await auth.supabase
    .from("billing_lines")
    .insert({
      project_id: input.projectId,
      item_number: input.itemNumber.trim(),
      description: input.description.trim(),
      scheduled_value: input.scheduledValue,
      change_order_id: input.changeOrderId,
      sort_order: sortOrder,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" };

  revalidatePath(`/projects/${input.projectId}/change-orders/${input.changeOrderId}`);
  revalidatePath(`/projects/${input.projectId}/change-orders`);
  revalidatePath(`/projects/${input.projectId}`, "layout");
  return { ok: true, lineId: data.id };
}

export async function removeCoBillingLine(
  lineId: string,
  changeOrderId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  // Don't delete the billing_line, just detach it from the CO so historical
  // data is preserved.
  const { error } = await auth.supabase
    .from("billing_lines")
    .update({ change_order_id: null })
    .eq("id", lineId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/change-orders/${changeOrderId}`);
  revalidatePath(`/projects/${projectId}/change-orders`);
  return { ok: true };
}

/* ==================================================================== */
/* Cost buildup, backup documents, and workflow (migration 0046)         */
/* ==================================================================== */

/**
 * Recomputes the CO's stored cost_amount / co_value from its cost lines and,
 * when the CO is approved, pushes the new total onto its SOV line so the next
 * AFP bills the right number.
 *
 * Every mutation below funnels through here rather than each doing its own
 * arithmetic. The stored columns are a cache of the buildup; the lines are the
 * source of truth.
 */
async function resyncCoTotals(
  supabase: unknown,
  coId: string,
): Promise<{ billable: number; totalCost: number } | null> {
  const db = coClient(supabase);

  const [{ data: coRow }, { data: lineRows }] = await Promise.all([
    db
      .from("change_orders")
      .select("id, project_id, co_number, description, status, profit_pct, bond_pct, tax_pct, billing_line_id")
      .eq("id", coId)
      .maybeSingle(),
    db.from("change_order_cost_lines").select("*").eq("change_order_id", coId),
  ]);
  if (!coRow) return null;

  const lines = lineRows ?? [];
  // A CO with no buildup yet is still a valid lump-sum CO from before this
  // feature existed. Leave its hand-entered co_value alone.
  if (lines.length === 0) return null;

  const buildup = priceBuildup({
    lines: lines.map((l) => ({
      id: l.id,
      sortOrder: l.sort_order,
      category: (l.category ?? "other") as CostCategory,
      description: l.description,
      vendorName: l.vendor_name,
      quantity: Number(l.quantity ?? 0),
      unit: l.unit,
      unitCost: Number(l.unit_cost ?? 0),
      markupPct: l.markup_pct == null ? null : Number(l.markup_pct),
      costCodeId: l.cost_code_id,
      notes: l.notes,
    })),
    defaultMarkupPct: coRow.profit_pct == null ? null : Number(coRow.profit_pct),
    bondPct: coRow.bond_pct == null ? null : Number(coRow.bond_pct),
    taxPct: coRow.tax_pct == null ? null : Number(coRow.tax_pct),
  });

  await db
    .from("change_orders")
    .update({ co_value: buildup.billable, cost_amount: buildup.totalCost })
    .eq("id", coId);

  // Only an approved CO has an SOV line to keep in step.
  if (coRow.billing_line_id && countsTowardContract(coRow.status ?? "")) {
    await db
      .from("billing_lines")
      .update({
        scheduled_value: buildup.billable,
        description: coRow.description ?? coRow.co_number,
      })
      .eq("id", coRow.billing_line_id);
  }

  return { billable: buildup.billable, totalCost: buildup.totalCost };
}

export type SaveCostLineInput = {
  id?: string;
  projectId: string;
  changeOrderId: string;
  category: CostCategory;
  description: string;
  vendorName: string | null;
  quantity: number;
  unit: string | null;
  unitCost: number;
  markupPct: number | null;
  costCodeId: string | null;
  notes: string | null;
};

export async function saveCostLine(
  input: SaveCostLineInput,
): Promise<{ ok: true; lineId: string } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!input.description?.trim()) return { ok: false, error: "Description is required" };
  if (!Number.isFinite(input.quantity)) return { ok: false, error: "Quantity must be a number" };
  if (!Number.isFinite(input.unitCost)) return { ok: false, error: "Unit cost must be a number" };
  if (!COST_CATEGORIES.includes(input.category)) {
    return { ok: false, error: `Unknown category: ${input.category}` };
  }

  const db = coClient(auth.supabase);
  const values = {
    change_order_id: input.changeOrderId,
    project_id: input.projectId,
    category: input.category,
    description: input.description.trim(),
    vendor_name: input.vendorName?.trim() || null,
    quantity: input.quantity,
    unit: input.unit?.trim() || null,
    unit_cost: input.unitCost,
    markup_pct: input.markupPct,
    cost_code_id: input.costCodeId,
    notes: input.notes?.trim() || null,
  };

  let lineId = input.id;
  if (lineId) {
    const { error } = await db.from("change_order_cost_lines").update(values).eq("id", lineId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data: maxRow } = await db
      .from("change_order_cost_lines")
      .select("sort_order")
      .eq("change_order_id", input.changeOrderId)
      .order("sort_order", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const { data, error } = await db
      .from("change_order_cost_lines")
      .insert({ ...values, sort_order: (maxRow?.sort_order ?? 0) + 10 })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" };
    lineId = data.id;
  }

  await resyncCoTotals(auth.supabase, input.changeOrderId);
  revalidateCo(input.projectId, input.changeOrderId);
  return { ok: true, lineId: lineId! };
}

export async function deleteCostLine(
  lineId: string,
  changeOrderId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const db = coClient(auth.supabase);

  // Attachments cascade in the database, but the storage objects do not, so
  // clear the files first or they are orphaned in the bucket forever.
  const { data: files } = await db
    .from("change_order_attachments")
    .select("storage_path")
    .eq("cost_line_id", lineId);
  const paths = (files ?? []).map((f) => f.storage_path);
  if (paths.length > 0) {
    await auth.supabase.storage.from(DOCUMENT_BUCKET).remove(paths);
  }

  const { error } = await db.from("change_order_cost_lines").delete().eq("id", lineId);
  if (error) return { ok: false, error: error.message };

  await resyncCoTotals(auth.supabase, changeOrderId);
  revalidateCo(projectId, changeOrderId);
  return { ok: true };
}

export type RecordCoAttachmentInput = {
  projectId: string;
  changeOrderId: string;
  /** null attaches the file to the CO as a whole rather than to one line. */
  costLineId: string | null;
  kind: string;
  fileName: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  description: string | null;
};

export async function recordCoAttachment(
  input: RecordCoAttachmentInput,
): Promise<{ ok: true; attachmentId: string } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!ATTACHMENT_KINDS.includes(input.kind as (typeof ATTACHMENT_KINDS)[number])) {
    return { ok: false, error: `Unknown attachment kind: ${input.kind}` };
  }

  const db = coClient(auth.supabase);
  const { data, error } = await db
    .from("change_order_attachments")
    .insert({
      change_order_id: input.changeOrderId,
      cost_line_id: input.costLineId,
      project_id: input.projectId,
      kind: input.kind,
      file_name: input.fileName,
      storage_path: input.storagePath,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      description: input.description,
      uploaded_by_id: auth.userId,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" };

  revalidateCo(input.projectId, input.changeOrderId);
  return { ok: true, attachmentId: data.id };
}

export async function deleteCoAttachment(
  attachmentId: string,
  changeOrderId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const db = coClient(auth.supabase);

  const { data: row } = await db
    .from("change_order_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();

  const { error } = await db.from("change_order_attachments").delete().eq("id", attachmentId);
  if (error) return { ok: false, error: error.message };
  if (row?.storage_path) {
    await auth.supabase.storage.from(DOCUMENT_BUCKET).remove([row.storage_path]);
  }

  revalidateCo(projectId, changeOrderId);
  return { ok: true };
}

/**
 * Moves a CO through the workflow and does the side effects each step owns.
 *
 * The one that matters: approving a CO creates its SOV line, which is what
 * puts it on the next AFP. AHC bills one line per CO, so this is a single
 * billing_lines row carrying the whole CO value.
 *
 * projects.contract_value is deliberately NOT touched. The SOV is the
 * contract - see the note at the top of ceo-report-financials.ts. Adding the
 * CO to both would double-count it.
 */
export async function transitionCoStatus(
  coId: string,
  projectId: string,
  toStatus: string,
  note: string | null,
): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const db = coClient(auth.supabase);

  const { data: co } = await db
    .from("change_orders")
    .select("id, co_number, description, status, co_value, billing_line_id")
    .eq("id", coId)
    .maybeSingle();
  if (!co) return { ok: false, error: "Change order not found" };

  const fromStatus = co.status ?? "draft";
  if (fromStatus === toStatus) return { ok: false, error: "Already in that status" };
  if (!canTransition(fromStatus, toStatus)) {
    return {
      ok: false,
      error: `Cannot move a ${CO_STATUS_LABELS[fromStatus as CoStatus] ?? fromStatus} change order to ${CO_STATUS_LABELS[toStatus as CoStatus] ?? toStatus}`,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const patch: TablesUpdate<"change_orders"> & {
    internal_review_at?: string | null;
    rejected_at?: string | null;
    voided_at?: string | null;
    billing_line_id?: string | null;
  } = { status: toStatus };
  if (toStatus === "internal_review") patch.internal_review_at = today;
  if (toStatus === "submitted") patch.submitted_at = today;
  if (toStatus === "approved") patch.approved_at = today;
  if (toStatus === "rejected") patch.rejected_at = today;
  if (toStatus === "void") patch.voided_at = today;

  let warning: string | undefined;
  let billingLineId = co.billing_line_id;

  if (toStatus === "approved" && !billingLineId) {
    // A CO created before this feature may already own an SOV line through
    // billing_lines.change_order_id. Adopt it rather than adding a second one
    // and double-billing the owner.
    const { data: existing } = await db
      .from("billing_lines")
      .select("id")
      .eq("change_order_id", coId)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      billingLineId = existing.id;
      patch.billing_line_id = billingLineId;
    }
  }

  if (toStatus === "approved" && !billingLineId) {
    const { data: maxRow } = await db
      .from("billing_lines")
      .select("sort_order")
      .eq("project_id", projectId)
      .order("sort_order", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const { data: line, error: lineError } = await db
      .from("billing_lines")
      .insert({
        project_id: projectId,
        item_number: co.co_number,
        type: "change_order",
        description: co.description ?? co.co_number,
        scheduled_value: Number(co.co_value ?? 0),
        change_order_id: coId,
        sort_order: (maxRow?.sort_order ?? 0) + 10,
      })
      .select("id")
      .single();

    if (lineError || !line) {
      return {
        ok: false,
        error: `Approved status not saved - could not create the SOV line: ${lineError?.message ?? "unknown error"}`,
      };
    }
    billingLineId = line.id;
    patch.billing_line_id = billingLineId;
  }

  if (fromStatus === "approved" && toStatus !== "approved" && billingLineId) {
    // Pulling a CO back out of approved has to take it off the AFP too. If it
    // has already been billed, deleting the line would destroy pay app
    // history, so leave it and say so out loud.
    const { count } = await db
      .from("billing_entries")
      .select("id", { count: "exact", head: true })
      .eq("billing_line_id", billingLineId);

    if ((count ?? 0) > 0) {
      warning =
        `SOV line ${co.co_number} has already been billed, so it was left in place. ` +
        `Adjust it on the billing page if this CO is not going forward.`;
    } else {
      await db.from("billing_lines").delete().eq("id", billingLineId);
      patch.billing_line_id = null;
    }
  }

  const { error } = await db.from("change_orders").update(patch).eq("id", coId);
  if (error) return { ok: false, error: error.message };

  await db.from("change_order_events").insert({
    change_order_id: coId,
    from_status: fromStatus,
    to_status: toStatus,
    note: note?.trim() || null,
    actor_id: auth.userId,
  });

  if (toStatus === "approved") await resyncCoTotals(auth.supabase, coId);

  revalidateCo(projectId, coId);
  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}/pay-apps`);
  return { ok: true, warning };
}

export type CoFormFieldsInput = {
  description: string | null;
  reason: string | null;
  dateOfChangeOrder: string | null;
  profitPct: number | null;
  bondPct: number | null;
  taxPct: number | null;
  mechCompletionDeltaDays: number | null;
  substCompletionDeltaDays: number | null;
  exhibitEImpact: string | null;
  capacityRatioImpact: string | null;
  designBasisImpact: string | null;
  otherImpacts: string | null;
};

/** The narrative and rate fields that feed Exhibit H. */
export async function updateCoFormFields(
  coId: string,
  projectId: string,
  input: CoFormFieldsInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const db = coClient(auth.supabase);

  const { error } = await db
    .from("change_orders")
    .update({
      description: input.description,
      reason: input.reason,
      date_of_change_order: input.dateOfChangeOrder,
      profit_pct: input.profitPct,
      bond_pct: input.bondPct,
      tax_pct: input.taxPct,
      mech_completion_delta_days: input.mechCompletionDeltaDays,
      subst_completion_delta_days: input.substCompletionDeltaDays,
      // schedule_impact_days predates the two-date split; mirror the larger of
      // the two so older dashboards keep reporting something sane. Only when a
      // delta was actually given - deriving from two blanks used to silently
      // zero a value entered elsewhere.
      ...(input.mechCompletionDeltaDays != null || input.substCompletionDeltaDays != null
        ? {
            schedule_impact_days: Math.max(
              input.mechCompletionDeltaDays ?? 0,
              input.substCompletionDeltaDays ?? 0,
            ),
          }
        : {}),
      exhibit_e_impact: input.exhibitEImpact,
      capacity_ratio_impact: input.capacityRatioImpact,
      design_basis_impact: input.designBasisImpact,
      other_impacts: input.otherImpacts,
    })
    .eq("id", coId);
  if (error) return { ok: false, error: error.message };

  // Markup lives on the CO, so changing it re-prices every inheriting line.
  await resyncCoTotals(auth.supabase, coId);
  revalidateCo(projectId, coId);
  return { ok: true };
}

export type ProjectContractFactsInput = {
  originalContractValue: number | null;
  agreementDate: string | null;
  guaranteedMechanicalCompletionDate: string | null;
  guaranteedSubstantialCompletionDate: string | null;
  contractorLegalName: string | null;
  contractorSignatoryName: string | null;
  contractorSignatoryTitle: string | null;
};

/**
 * The Exhibit H header facts, which belong to the project rather than any one
 * CO: original contract price, agreement date, the two guaranteed completion
 * dates, and who signs for AHC.
 */
export async function updateProjectContractFacts(
  projectId: string,
  input: ProjectContractFactsInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const db = coClient(auth.supabase);

  const { error } = await db
    .from("projects")
    .update({
      original_contract_value: input.originalContractValue,
      agreement_date: input.agreementDate,
      guaranteed_mechanical_completion_date: input.guaranteedMechanicalCompletionDate,
      guaranteed_substantial_completion_date: input.guaranteedSubstantialCompletionDate,
      contractor_legal_name: input.contractorLegalName,
      contractor_signatory_name: input.contractorSignatoryName,
      contractor_signatory_title: input.contractorSignatoryTitle,
    })
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`, "layout");
  return { ok: true };
}

/** Rebuilds cost_amount / co_value from the lines after an out-of-band edit. */
export async function resyncChangeOrderTotals(
  coId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const result = await resyncCoTotals(auth.supabase, coId);
  if (!result) return { ok: false, error: "This change order has no cost lines to total" };
  revalidateCo(projectId, coId);
  return { ok: true };
}

function revalidateCo(projectId: string, coId: string) {
  revalidatePath(`/projects/${projectId}/change-orders/${coId}`);
  revalidatePath(`/projects/${projectId}/change-orders`);
  revalidatePath(`/projects/${projectId}`, "layout");
}

export type AddCostLinesInput = {
  projectId: string;
  changeOrderId: string;
  /** Raw spreadsheet paste. Parsed server side so the rules live in one place. */
  pasted: string;
  defaultCategory: CostCategory;
};

/**
 * Adds many cost lines in one go from a spreadsheet paste.
 *
 * A CO buildup is assembled in Excel before it ever reaches this app, so
 * retyping it a row at a time is the slow path. Rows that could not be read
 * come back named rather than dropped - a buildup that silently loses a line
 * gets submitted short.
 */
export async function addCostLinesFromPaste(
  input: AddCostLinesInput,
): Promise<
  | { ok: true; added: number; skipped: Array<{ row: number; text: string; reason: string }> }
  | { ok: false; error: string }
> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const parsed = parsePastedCostLines(input.pasted, input.defaultCategory);
  if (parsed.lines.length === 0) {
    return {
      ok: false,
      error:
        parsed.skipped.length > 0
          ? `No usable rows. First problem: row ${parsed.skipped[0].row} - ${parsed.skipped[0].reason}`
          : "Nothing to add",
    };
  }

  const db = coClient(auth.supabase);
  const { data: maxRow } = await db
    .from("change_order_cost_lines")
    .select("sort_order")
    .eq("change_order_id", input.changeOrderId)
    .order("sort_order", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  let sort = (maxRow?.sort_order ?? 0) + 10;

  const { error } = await db.from("change_order_cost_lines").insert(
    parsed.lines.map((l) => ({
      change_order_id: input.changeOrderId,
      project_id: input.projectId,
      category: l.category,
      description: l.description,
      vendor_name: l.vendorName,
      quantity: l.quantity,
      unit: l.unit,
      unit_cost: l.unitCost,
      markup_pct: l.markupPct,
      sort_order: (sort += 10) - 10,
    })),
  );
  if (error) return { ok: false, error: error.message };

  await resyncCoTotals(auth.supabase, input.changeOrderId);
  revalidateCo(input.projectId, input.changeOrderId);
  return { ok: true, added: parsed.lines.length, skipped: parsed.skipped };
}

/**
 * Creates an empty draft CO and hands back its id so the caller can go
 * straight to the detail page.
 *
 * There is no create form. Everything a change order needs - the cost
 * buildup, the backup, the dates, the narrative - lives on the detail page,
 * and a separate screen in front of it only collected values that page
 * immediately replaced. The number is assigned from the project's existing
 * sequence and stays editable there.
 */
export async function createDraftChangeOrder(
  projectId: string,
): Promise<{ ok: true; coId: string; coNumber: string } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const db = coClient(auth.supabase);

  const { data: existing } = await db
    .from("change_orders")
    .select("co_number")
    .eq("project_id", projectId);

  const taken = new Set((existing ?? []).map((r) => r.co_number));
  let coNumber = nextCoNumber((existing ?? []).map((r) => r.co_number));
  // nextCoNumber is max + 1 so a collision means a number outside the pattern
  // already holds the slot. Walk forward rather than failing in the user's face.
  for (let guard = 0; taken.has(coNumber) && guard < 50; guard++) {
    coNumber = nextCoNumber([...Array.from(taken), coNumber]);
  }

  const { data, error } = await db
    .from("change_orders")
    .insert({ project_id: projectId, co_number: coNumber, status: "draft", co_value: 0 })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not create" };

  revalidatePath(`/projects/${projectId}/change-orders`);
  revalidatePath(`/projects/${projectId}`, "layout");
  return { ok: true, coId: data.id, coNumber };
}

/** Renames a CO. Kept separate because the number is the owner-facing key. */
export async function updateCoNumber(
  coId: string,
  projectId: string,
  coNumber: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const trimmed = coNumber.trim();
  if (!trimmed) return { ok: false, error: "CO number is required" };

  const db = coClient(auth.supabase);
  const { data: co } = await db
    .from("change_orders")
    .select("billing_line_id")
    .eq("id", coId)
    .maybeSingle();

  const { error } = await db
    .from("change_orders")
    .update({ co_number: trimmed })
    .eq("id", coId);
  if (error) {
    return {
      ok: false,
      error: error.message.includes("duplicate")
        ? `${trimmed} is already used by another change order on this project`
        : error.message,
    };
  }

  // The SOV line is titled by CO number, so it has to follow the rename or the
  // G703 and the change order stop agreeing.
  if (co?.billing_line_id) {
    await db
      .from("billing_lines")
      .update({ item_number: trimmed })
      .eq("id", co.billing_line_id);
  }

  revalidateCo(projectId, coId);
  revalidatePath(`/projects/${projectId}/billing`);
  return { ok: true };
}
