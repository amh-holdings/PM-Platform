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

// ============ SCHEDULE LINKING ============

function parseWbsCodes(input: string): string[] {
  return Array.from(
    new Set(input.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)),
  );
}

export type CostLinkResult =
  | { ok: true; unknownCodes: string[] }
  | { ok: false; error: string };

export async function updateCostCodeLinks(
  costCodeId: string,
  projectId: string,
  rawCodes: string,
): Promise<CostLinkResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const codes = parseWbsCodes(rawCodes);
  const { data: known, error: lookupErr } = await auth.supabase
    .from("schedule_tasks")
    .select("wbs_code")
    .eq("project_id", projectId);
  if (lookupErr) return { ok: false, error: lookupErr.message };
  const knownSet = new Set((known ?? []).map((r) => r.wbs_code));
  const unknownCodes = codes.filter((c) => !knownSet.has(c));

  const { error } = await auth.supabase
    .from("cost_codes")
    .update({ linked_task_wbs_codes: codes.length ? codes : null })
    .eq("id", costCodeId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/costs`);
  return { ok: true, unknownCodes };
}

// ============ SPEND AUTO-SUGGEST ============

const STATUS_PCT: Record<string, number> = {
  Complete: 1.0,
  Approved: 1.0,
  "In Progress": 0.5,
};

function pctForTask(
  t: {
    status: string | null;
    end_date: string | null;
    pct_complete: number | null;
  },
  todayIso: string,
): number {
  if (t.pct_complete != null && Number.isFinite(Number(t.pct_complete))) {
    return Math.max(0, Math.min(1, Number(t.pct_complete) / 100));
  }
  if (t.status && STATUS_PCT[t.status] != null) return STATUS_PCT[t.status];
  if (t.end_date && t.end_date < todayIso && t.status !== "Complete") {
    return 0.75;
  }
  return 0;
}

export type SpendSuggestion = {
  costCodeId: string;
  code: string;
  name: string;
  estimatedCost: number;
  alreadySpent: number;
  remaining: number;
  linkedTaskCount: number;
  targetPct: number;
  suggestedAmount: number;
};

export async function computeSpendSuggestions(
  projectId: string,
): Promise<
  | { ok: true; suggestions: SpendSuggestion[]; nextMonthIso: string }
  | { ok: false; error: string }
> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextMonthIso = `${nextMonthStart.getFullYear()}-${String(nextMonthStart.getMonth() + 1).padStart(2, "0")}-01`;

  const [{ data: codes }, { data: tasks }, { data: forecasts }] = await Promise.all([
    auth.supabase
      .from("cost_codes")
      .select("id, code, name, estimated_cost, linked_task_wbs_codes")
      .eq("project_id", projectId),
    auth.supabase
      .from("schedule_tasks")
      .select("wbs_code, status, end_date, pct_complete")
      .eq("project_id", projectId),
    auth.supabase
      .from("cost_forecasts")
      .select("cost_code_id, actual_amount, cost_codes!inner(project_id)")
      .eq("cost_codes.project_id", projectId),
  ]);

  const taskByCode = new Map<
    string,
    { status: string | null; end_date: string | null; pct_complete: number | null }
  >();
  for (const t of tasks ?? []) {
    taskByCode.set(t.wbs_code, {
      status: t.status,
      end_date: t.end_date,
      pct_complete: t.pct_complete == null ? null : Number(t.pct_complete),
    });
  }

  const spentById = new Map<string, number>();
  for (const f of forecasts ?? []) {
    spentById.set(
      f.cost_code_id,
      (spentById.get(f.cost_code_id) ?? 0) + Number(f.actual_amount ?? 0),
    );
  }

  const suggestions: SpendSuggestion[] = [];
  for (const c of codes ?? []) {
    const links = c.linked_task_wbs_codes ?? [];
    if (links.length === 0) continue;
    const matched = links
      .map((code) => taskByCode.get(code))
      .filter(
        (t): t is { status: string | null; end_date: string | null; pct_complete: number | null } =>
          !!t,
      );
    if (matched.length === 0) continue;
    const avgPct =
      matched.reduce((s, t) => s + pctForTask(t, todayIso), 0) / matched.length;
    const est = Number(c.estimated_cost ?? 0);
    const target = avgPct * est;
    const spent = spentById.get(c.id) ?? 0;
    const remaining = est - spent;
    const raw = target - spent;
    const suggested = Math.max(0, Math.min(remaining, raw));
    if (suggested <= 0) continue;
    suggestions.push({
      costCodeId: c.id,
      code: c.code,
      name: c.name,
      estimatedCost: est,
      alreadySpent: spent,
      remaining,
      linkedTaskCount: matched.length,
      targetPct: avgPct,
      suggestedAmount: Math.round(suggested * 100) / 100,
    });
  }

  suggestions.sort((a, b) => b.suggestedAmount - a.suggestedAmount);
  return { ok: true, suggestions, nextMonthIso };
}

export type PromoteSpendResult =
  | { ok: true; written: number; period_month: string }
  | { ok: false; error: string };

export async function promoteSpendSuggestionsToPlanned(
  projectId: string,
): Promise<PromoteSpendResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const result = await computeSpendSuggestions(projectId);
  if (!result.ok) return result;
  const { suggestions, nextMonthIso } = result;
  if (suggestions.length === 0) {
    return { ok: true, written: 0, period_month: nextMonthIso };
  }

  let written = 0;
  for (const s of suggestions) {
    const { data: existing } = await auth.supabase
      .from("cost_forecasts")
      .select("id, planned_amount, actual_amount")
      .eq("cost_code_id", s.costCodeId)
      .eq("period_month", nextMonthIso)
      .maybeSingle();
    if (
      existing &&
      (Number(existing.planned_amount ?? 0) > 0 ||
        Number(existing.actual_amount ?? 0) > 0)
    ) {
      continue;
    }
    const { error } = await auth.supabase
      .from("cost_forecasts")
      .upsert(
        {
          cost_code_id: s.costCodeId,
          period_month: nextMonthIso,
          planned_amount: s.suggestedAmount,
          actual_amount: 0,
          notes: "Auto-suggested from schedule",
        },
        { onConflict: "cost_code_id,period_month" },
      );
    if (error) return { ok: false, error: error.message };
    written += 1;
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/costs`);
  return { ok: true, written, period_month: nextMonthIso };
}
