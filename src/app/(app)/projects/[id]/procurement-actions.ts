"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
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

  const insert: TablesInsert<"procurement_orders"> = {
    project_id: projectId,
    vendor_name: vendor,
    po_number: getStr(formData.get("po_number")),
    description: getStr(formData.get("description")),
    total_value: getNum(formData.get("total_value")),
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

  const insert: TablesInsert<"procurement_payments"> = {
    procurement_order_id: poId,
    milestone_name: name,
    pct_of_total: pct,
    trigger_event: getStr(formData.get("trigger_event")),
    expected_date: getDate(formData.get("expected_date")),
    amount: computedAmount,
    sort_order: getNum(formData.get("sort_order")),
    notes: getStr(formData.get("notes")),
  };

  const { data, error } = await auth.supabase
    .from("procurement_payments")
    .insert(insert)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
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
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  return { ok: true, id: milestoneId };
}

export async function markMilestonePaid(
  milestoneId: string,
  poId: string,
  projectId: string,
  paidAt: string,
  paidAmount?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  const patch: TablesUpdate<"procurement_payments"> = {
    paid_at: paidAt,
  };
  if (paidAmount != null) patch.paid_amount = paidAmount;
  const { error } = await auth.supabase
    .from("procurement_payments")
    .update(patch)
    .eq("id", milestoneId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
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
  revalidatePath(`/projects/${projectId}/procurement/${poId}`);
  return { ok: true };
}
