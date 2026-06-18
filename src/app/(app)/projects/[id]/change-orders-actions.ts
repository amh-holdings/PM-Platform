"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/lib/database.types";

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

  const { data, error } = await auth.supabase
    .from("change_orders")
    .insert({
      project_id: input.projectId,
      co_number: input.coNumber.trim(),
      description: input.description,
      co_value: input.coValue,
      cost_amount: input.costAmount,
      profit_pct: input.profitPct,
      schedule_impact_days: input.scheduleImpactDays,
      status: input.status || "approved",
      submitted_at: input.submittedAt,
      approved_at: input.approvedAt,
      notes: input.notes,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" };

  revalidatePath(`/projects/${input.projectId}/change-orders`);
  revalidatePath(`/projects/${input.projectId}`);
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
  revalidatePath(`/projects/${projectId}`);
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
  revalidatePath(`/projects/${projectId}`);
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
  revalidatePath(`/projects/${input.projectId}`);
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
