"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/lib/database.types";

export type ExtractedProjectFields = {
  client: string | null;
  contract_value: number | null;
  ntp_date: string | null;
  cod_date: string | null;
  zip_code: string | null;
  ld_rate_per_mwdc_per_day: number | null;
  retainage_pct: number | null;
  ld_cap_pct: number | null;
  notes: string;
};

export type ExtractProjectDetailsResult =
  | {
      ok: true;
      fields: ExtractedProjectFields;
      source_documents: string[];
      elapsed_ms: number;
    }
  | { ok: false; error: string };

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

export async function extractProjectDetails(
  projectId: string,
): Promise<ExtractProjectDetailsResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const relayUrl = process.env.RELAY_URL;
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (!relayUrl || !relaySecret) {
    return {
      ok: false,
      error:
        "Extraction is not configured. RELAY_URL and RELAY_SHARED_SECRET must be set.",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${relayUrl}/extract-project-details`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${relaySecret}`,
      },
      body: JSON.stringify({ project_id: projectId }),
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

  type RelayResponse = {
    fields: ExtractedProjectFields;
    source_documents: string[];
    elapsed_ms: number;
  };
  const data = (await response.json()) as RelayResponse;
  return {
    ok: true,
    fields: data.fields,
    source_documents: data.source_documents,
    elapsed_ms: data.elapsed_ms,
  };
}

export type ApplyProjectFieldsInput = {
  client?: string | null;
  contract_value?: number | null;
  ntp_date?: string | null;
  cod_date?: string | null;
  zip_code?: string | null;
};

export type ApplyProjectFieldsResult =
  | { ok: true }
  | { ok: false; error: string };

export async function applyProjectFields(
  projectId: string,
  fields: ApplyProjectFieldsInput,
): Promise<ApplyProjectFieldsResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  // Build the update payload from only the fields actually provided (so we
  // never clobber a value the user chose to skip).
  const update: TablesUpdate<"projects"> = {};
  if ("client" in fields) update.client = fields.client ?? null;
  if ("contract_value" in fields) update.contract_value = fields.contract_value ?? null;
  if ("ntp_date" in fields) update.ntp_date = fields.ntp_date ?? null;
  if ("cod_date" in fields) update.cod_date = fields.cod_date ?? null;
  if ("zip_code" in fields) update.zip_code = fields.zip_code ?? null;

  if (Object.keys(update).length === 0) {
    return { ok: false, error: "No fields to apply" };
  }

  const { error } = await auth.supabase
    .from("projects")
    .update(update)
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  return { ok: true };
}
