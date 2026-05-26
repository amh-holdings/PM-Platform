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
  return { ok: true as const, supabase };
}

export type CostCodeResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

function getStr(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function parseCurrency(value: FormDataEntryValue | null): number | null | "invalid" {
  if (typeof value !== "string" || !value.trim()) return null;
  const cleaned = value.replace(/[$,\s]/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return "invalid";
  return num;
}

export async function createCostCode(
  projectId: string,
  formData: FormData,
): Promise<CostCodeResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const code = getStr(formData.get("code"));
  const name = getStr(formData.get("name"));
  if (!code) return { ok: false, error: "Code is required", fieldErrors: { code: "Required" } };
  if (!name) return { ok: false, error: "Name is required", fieldErrors: { name: "Required" } };

  const estimated = parseCurrency(formData.get("estimated_cost"));
  if (estimated === "invalid") {
    return { ok: false, error: "Estimated cost must be a valid amount", fieldErrors: { estimated_cost: "Invalid" } };
  }
  const actual = parseCurrency(formData.get("actual_cost"));
  if (actual === "invalid") {
    return { ok: false, error: "Actual cost must be a valid amount", fieldErrors: { actual_cost: "Invalid" } };
  }

  const insert: TablesInsert<"cost_codes"> = {
    project_id: projectId,
    code,
    name,
    description: getStr(formData.get("description")),
    estimated_cost: estimated,
    actual_cost: actual ?? 0,
    is_change_order: formData.get("is_change_order") === "on",
  };

  const { data, error } = await auth.supabase
    .from("cost_codes")
    .insert(insert)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: data.id };
}

export async function updateCostCode(
  codeId: string,
  projectId: string,
  formData: FormData,
): Promise<CostCodeResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const code = getStr(formData.get("code"));
  const name = getStr(formData.get("name"));
  if (!code) return { ok: false, error: "Code is required", fieldErrors: { code: "Required" } };
  if (!name) return { ok: false, error: "Name is required", fieldErrors: { name: "Required" } };

  const estimated = parseCurrency(formData.get("estimated_cost"));
  if (estimated === "invalid") {
    return { ok: false, error: "Estimated cost must be a valid amount", fieldErrors: { estimated_cost: "Invalid" } };
  }
  const actual = parseCurrency(formData.get("actual_cost"));
  if (actual === "invalid") {
    return { ok: false, error: "Actual cost must be a valid amount", fieldErrors: { actual_cost: "Invalid" } };
  }

  const update: TablesUpdate<"cost_codes"> = {
    code,
    name,
    description: getStr(formData.get("description")),
    estimated_cost: estimated,
    actual_cost: actual,
    is_change_order: formData.get("is_change_order") === "on",
  };

  const { error } = await auth.supabase
    .from("cost_codes")
    .update(update)
    .eq("id", codeId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: codeId };
}

export async function deleteCostCode(
  codeId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase.from("cost_codes").delete().eq("id", codeId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
