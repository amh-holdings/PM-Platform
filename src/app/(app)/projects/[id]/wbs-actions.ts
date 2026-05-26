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

export type WbsResult =
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

function parsePct(value: FormDataEntryValue | null): number | null | "invalid" {
  if (typeof value !== "string" || !value.trim()) return null;
  const cleaned = value.replace(/[%\s]/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0 || num > 100) return "invalid";
  return num;
}

function parseUuid(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  return v === "" ? null : v;
}

export async function createWbsItem(
  projectId: string,
  formData: FormData,
): Promise<WbsResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const wbsCode = getStr(formData.get("wbs_code"));
  const description = getStr(formData.get("description"));
  if (!wbsCode) {
    return { ok: false, error: "WBS code is required", fieldErrors: { wbs_code: "Required" } };
  }
  if (!description) {
    return { ok: false, error: "Description is required", fieldErrors: { description: "Required" } };
  }

  const contractValue = parseCurrency(formData.get("contract_value"));
  if (contractValue === "invalid") {
    return { ok: false, error: "Contract value must be a valid dollar amount", fieldErrors: { contract_value: "Invalid" } };
  }
  const pctSub = parsePct(formData.get("pct_complete_sub"));
  if (pctSub === "invalid") {
    return { ok: false, error: "Sub % must be 0-100", fieldErrors: { pct_complete_sub: "Invalid" } };
  }
  const pctAhc = parsePct(formData.get("pct_complete_ahc"));
  if (pctAhc === "invalid") {
    return { ok: false, error: "AHC % must be 0-100", fieldErrors: { pct_complete_ahc: "Invalid" } };
  }
  const retainagePct = parsePct(formData.get("retainage_pct"));
  if (retainagePct === "invalid") {
    return { ok: false, error: "Retainage must be 0-100", fieldErrors: { retainage_pct: "Invalid" } };
  }
  const billed = parseCurrency(formData.get("billed_to_date"));
  if (billed === "invalid") {
    return { ok: false, error: "Billed-to-date must be a valid dollar amount", fieldErrors: { billed_to_date: "Invalid" } };
  }

  const insert: TablesInsert<"wbs_sov"> = {
    project_id: projectId,
    wbs_code: wbsCode,
    description,
    trade: getStr(formData.get("trade")),
    subcontractor_id: parseUuid(formData.get("subcontractor_id")),
    contract_value: contractValue,
    pct_complete_sub: pctSub ?? 0,
    pct_complete_ahc: pctAhc ?? 0,
    retainage_pct: retainagePct ?? undefined,
    billed_to_date: billed ?? 0,
  };

  const { data, error } = await auth.supabase
    .from("wbs_sov")
    .insert(insert)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: data.id };
}

export async function updateWbsItem(
  itemId: string,
  projectId: string,
  formData: FormData,
): Promise<WbsResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const wbsCode = getStr(formData.get("wbs_code"));
  const description = getStr(formData.get("description"));
  if (!wbsCode) {
    return { ok: false, error: "WBS code is required", fieldErrors: { wbs_code: "Required" } };
  }
  if (!description) {
    return { ok: false, error: "Description is required", fieldErrors: { description: "Required" } };
  }

  const contractValue = parseCurrency(formData.get("contract_value"));
  if (contractValue === "invalid") {
    return { ok: false, error: "Contract value must be a valid dollar amount", fieldErrors: { contract_value: "Invalid" } };
  }
  const pctSub = parsePct(formData.get("pct_complete_sub"));
  if (pctSub === "invalid") {
    return { ok: false, error: "Sub % must be 0-100", fieldErrors: { pct_complete_sub: "Invalid" } };
  }
  const pctAhc = parsePct(formData.get("pct_complete_ahc"));
  if (pctAhc === "invalid") {
    return { ok: false, error: "AHC % must be 0-100", fieldErrors: { pct_complete_ahc: "Invalid" } };
  }
  const retainagePct = parsePct(formData.get("retainage_pct"));
  if (retainagePct === "invalid") {
    return { ok: false, error: "Retainage must be 0-100", fieldErrors: { retainage_pct: "Invalid" } };
  }
  const billed = parseCurrency(formData.get("billed_to_date"));
  if (billed === "invalid") {
    return { ok: false, error: "Billed-to-date must be a valid dollar amount", fieldErrors: { billed_to_date: "Invalid" } };
  }

  const update: TablesUpdate<"wbs_sov"> = {
    wbs_code: wbsCode,
    description,
    trade: getStr(formData.get("trade")),
    subcontractor_id: parseUuid(formData.get("subcontractor_id")),
    contract_value: contractValue,
    pct_complete_sub: pctSub ?? 0,
    pct_complete_ahc: pctAhc ?? 0,
    retainage_pct: retainagePct,
    billed_to_date: billed ?? 0,
  };

  const { error } = await auth.supabase.from("wbs_sov").update(update).eq("id", itemId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: itemId };
}

export async function deleteWbsItem(
  itemId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase.from("wbs_sov").delete().eq("id", itemId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export type ExtractedSovItem = {
  wbs_code: string;
  description: string;
  contract_value: number | null;
};

export type ExtractSovResult =
  | {
      ok: true;
      items: ExtractedSovItem[];
      total_contract_value: number | null;
      notes: string;
      source_documents: string[];
      elapsed_ms: number;
    }
  | { ok: false; error: string };

export async function extractSov(projectId: string): Promise<ExtractSovResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const relayUrl = process.env.RELAY_URL;
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (!relayUrl || !relaySecret) {
    return {
      ok: false,
      error: "Extraction not configured. RELAY_URL and RELAY_SHARED_SECRET must be set.",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${relayUrl}/extract-sov`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${relaySecret}`,
      },
      body: JSON.stringify({ project_id: projectId }),
      signal: AbortSignal.timeout(180_000),
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
    } catch {}
    return { ok: false, error: errText };
  }

  const data = await response.json();
  return {
    ok: true,
    items: data.items ?? [],
    total_contract_value: data.total_contract_value ?? null,
    notes: data.notes ?? "",
    source_documents: data.source_documents ?? [],
    elapsed_ms: data.elapsed_ms ?? 0,
  };
}

export type BulkWbsInsert = {
  wbs_code: string;
  description: string;
  contract_value: number | null;
};

export async function bulkInsertWbs(
  projectId: string,
  items: BulkWbsInsert[],
): Promise<{ ok: true; inserted: number } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (items.length === 0) return { ok: false, error: "No items selected" };

  // Dedupe against existing WBS rows by wbs_code so re-runs don't duplicate.
  const { data: existing, error: fetchErr } = await auth.supabase
    .from("wbs_sov")
    .select("wbs_code")
    .eq("project_id", projectId);
  if (fetchErr) return { ok: false, error: fetchErr.message };
  const existingCodes = new Set((existing ?? []).map((r) => r.wbs_code));

  const rows: TablesInsert<"wbs_sov">[] = items
    .filter((it) => !existingCodes.has(it.wbs_code))
    .map((it) => ({
      project_id: projectId,
      wbs_code: it.wbs_code,
      description: it.description,
      contract_value: it.contract_value,
      pct_complete_sub: 0,
      pct_complete_ahc: 0,
      billed_to_date: 0,
    }));

  if (rows.length === 0) {
    return { ok: true, inserted: 0 };
  }

  const { error } = await auth.supabase.from("wbs_sov").insert(rows);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, inserted: rows.length };
}
