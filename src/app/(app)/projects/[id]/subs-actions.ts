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

export type SubResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

function parseCurrency(value: FormDataEntryValue | null): number | null | "invalid" {
  if (typeof value !== "string" || !value.trim()) return null;
  const cleaned = value.replace(/[$,\s]/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return "invalid";
  return num;
}

function parsePct(value: FormDataEntryValue | null): number | null | "invalid" {
  if (typeof value !== "string" || !value.trim()) return null;
  const cleaned = value.replace(/[%\s]/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0 || num > 100) return "invalid";
  return num;
}

function getStr(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

export async function createSubcontractor(
  projectId: string,
  formData: FormData,
): Promise<SubResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const companyName = getStr(formData.get("company_name"));
  if (!companyName) {
    return { ok: false, error: "Company name is required", fieldErrors: { company_name: "Required" } };
  }
  const contractValue = parseCurrency(formData.get("contract_value"));
  if (contractValue === "invalid") {
    return { ok: false, error: "Contract value must be a valid dollar amount", fieldErrors: { contract_value: "Invalid" } };
  }
  const retainagePct = parsePct(formData.get("retainage_pct"));
  if (retainagePct === "invalid") {
    return { ok: false, error: "Retainage must be a number 0-100", fieldErrors: { retainage_pct: "Invalid" } };
  }

  const insert: TablesInsert<"subcontractors"> = {
    project_id: projectId,
    company_name: companyName,
    trade: getStr(formData.get("trade")),
    contact_name: getStr(formData.get("contact_name")),
    contact_email: getStr(formData.get("contact_email")),
    contact_phone: getStr(formData.get("contact_phone")),
    contract_value: contractValue,
    retainage_pct: retainagePct ?? undefined,
    coi_status: getStr(formData.get("coi_status")) ?? "pending",
    w9_status: getStr(formData.get("w9_status")) ?? "pending",
    payment_terms: getStr(formData.get("payment_terms")) ?? "Net 30",
    active: true,
  };

  const { data, error } = await auth.supabase
    .from("subcontractors")
    .insert(insert)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: data.id };
}

export async function updateSubcontractor(
  subId: string,
  projectId: string,
  formData: FormData,
): Promise<SubResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const companyName = getStr(formData.get("company_name"));
  if (!companyName) {
    return { ok: false, error: "Company name is required", fieldErrors: { company_name: "Required" } };
  }
  const contractValue = parseCurrency(formData.get("contract_value"));
  if (contractValue === "invalid") {
    return { ok: false, error: "Contract value must be a valid dollar amount", fieldErrors: { contract_value: "Invalid" } };
  }
  const retainagePct = parsePct(formData.get("retainage_pct"));
  if (retainagePct === "invalid") {
    return { ok: false, error: "Retainage must be a number 0-100", fieldErrors: { retainage_pct: "Invalid" } };
  }

  const update: TablesUpdate<"subcontractors"> = {
    company_name: companyName,
    trade: getStr(formData.get("trade")),
    contact_name: getStr(formData.get("contact_name")),
    contact_email: getStr(formData.get("contact_email")),
    contact_phone: getStr(formData.get("contact_phone")),
    contract_value: contractValue,
    retainage_pct: retainagePct,
    coi_status: getStr(formData.get("coi_status")),
    w9_status: getStr(formData.get("w9_status")),
    payment_terms: getStr(formData.get("payment_terms")),
  };

  const { error } = await auth.supabase
    .from("subcontractors")
    .update(update)
    .eq("id", subId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: subId };
}

export async function deleteSubcontractor(
  subId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase.from("subcontractors").delete().eq("id", subId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function toggleSubcontractorActive(
  subId: string,
  projectId: string,
  active: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("subcontractors")
    .update({ active })
    .eq("id", subId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
