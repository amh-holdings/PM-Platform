"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  aggregateConfidence,
  estimateTaskProgress,
  type Confidence,
  type ProgressEstimate,
} from "@/lib/progress";

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

function parseWbsCodes(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

export type LinkResult =
  | { ok: true; unknownCodes: string[] }
  | { ok: false; error: string };

export async function updateLinkedTasks(
  billingLineId: string,
  projectId: string,
  rawCodes: string,
): Promise<LinkResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const codes = parseWbsCodes(rawCodes);

  // Validate codes against existing schedule_tasks for this project
  const { data: known, error: lookupErr } = await auth.supabase
    .from("schedule_tasks")
    .select("wbs_code")
    .eq("project_id", projectId);
  if (lookupErr) return { ok: false, error: lookupErr.message };
  const knownSet = new Set((known ?? []).map((r) => r.wbs_code));
  const unknownCodes = codes.filter((c) => !knownSet.has(c));

  const { error } = await auth.supabase
    .from("billing_lines")
    .update({ linked_task_wbs_codes: codes.length ? codes : null })
    .eq("id", billingLineId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/billing`);
  return { ok: true, unknownCodes };
}

// ============ AUTO-SUGGEST ============
//
// Heuristic mapping from schedule_task -> billing recommendation:
//
//   status = Complete          -> 100% of the line
//   status = In Progress       -> 50% of the line
//   end_date < today and not Complete -> 75% (work should be done)
//   anything else              -> 0%
//
// When multiple linked tasks point at one billing line, average their %.
// The "target billed to date by next month" is target_pct * scheduled_value;
// the suggested next-month dollar amount is target - already_billed,
// capped at remaining_to_bill and never negative.


// Replaced by src/lib/progress.ts which adds date interpolation +
// confidence tracking. Kept STATUS_PCT for back-compat in case other code
// still imports it.
//
// Legacy behavior is a subset of estimateTaskProgress() so old callers
// still work the same way.

export type BillingSuggestion = {
  billingLineId: string;
  itemNumber: string;
  description: string;
  scheduledValue: number;
  alreadyBilled: number;
  remaining: number;
  linkedTaskCount: number;
  targetPct: number;
  suggestedAmount: number;
  confidence: "high" | "medium" | "low" | "none";
  reasons: string[];          // one per linked task, in order
  sourcesSummary: string;     // e.g. "2 status, 1 date_interpolation"
};

export async function computeBillingSuggestions(
  projectId: string,
): Promise<{ ok: true; suggestions: BillingSuggestion[]; nextMonthIso: string } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextMonthIso = `${nextMonthStart.getFullYear()}-${String(nextMonthStart.getMonth() + 1).padStart(2, "0")}-01`;

  const [{ data: lines }, { data: tasks }, { data: totals }] = await Promise.all([
    auth.supabase
      .from("billing_lines")
      .select("id, item_number, description, scheduled_value, linked_task_wbs_codes")
      .eq("project_id", projectId),
    auth.supabase
      .from("schedule_tasks")
      .select("wbs_code, status, start_date, end_date, pct_complete")
      .eq("project_id", projectId),
    auth.supabase
      .from("v_billing_line_totals")
      .select("billing_line_id, total_billed, remaining_to_bill")
      .eq("project_id", projectId),
  ]);

  // Estimate progress for every task up-front so we have a confidence + reason
  // alongside the pct.
  const estimateByCode = new Map<string, ProgressEstimate>();
  for (const t of tasks ?? []) {
    estimateByCode.set(
      t.wbs_code,
      estimateTaskProgress(
        {
          status: t.status,
          start_date: t.start_date,
          end_date: t.end_date,
          pct_complete: t.pct_complete,
        },
        todayIso,
      ),
    );
  }
  const totalsById = new Map<string, { billed: number; remaining: number }>();
  for (const t of totals ?? []) {
    if (!t.billing_line_id) continue;
    totalsById.set(t.billing_line_id, {
      billed: Number(t.total_billed ?? 0),
      remaining: Number(t.remaining_to_bill ?? 0),
    });
  }

  const suggestions: BillingSuggestion[] = [];
  for (const line of lines ?? []) {
    const links = line.linked_task_wbs_codes ?? [];
    if (links.length === 0) continue;
    const matched = links
      .map((c) => estimateByCode.get(c))
      .filter((e): e is ProgressEstimate => !!e);
    if (matched.length === 0) continue;
    const avgPct = matched.reduce((s, e) => s + e.pct, 0) / matched.length;
    const confidence: Confidence = aggregateConfidence(matched.map((e) => e.confidence));
    const sourceCounts = new Map<string, number>();
    for (const e of matched) {
      sourceCounts.set(e.source, (sourceCounts.get(e.source) ?? 0) + 1);
    }
    const sourcesSummary = Array.from(sourceCounts.entries())
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    const scheduledValue = Number(line.scheduled_value ?? 0);
    const target = avgPct * scheduledValue;
    const t = totalsById.get(line.id) ?? { billed: 0, remaining: scheduledValue };
    const raw = target - t.billed;
    const suggested = Math.max(0, Math.min(t.remaining, raw));
    if (suggested <= 0) continue;
    suggestions.push({
      billingLineId: line.id,
      itemNumber: line.item_number,
      description: line.description,
      scheduledValue,
      alreadyBilled: t.billed,
      remaining: t.remaining,
      linkedTaskCount: matched.length,
      targetPct: avgPct,
      suggestedAmount: Math.round(suggested * 100) / 100,
      confidence,
      reasons: matched.map((e) => e.reason),
      sourcesSummary,
    });
  }

  suggestions.sort((a, b) => b.suggestedAmount - a.suggestedAmount);

  return { ok: true, suggestions, nextMonthIso };
}

export type PromoteResult =
  | { ok: true; written: number; period_month: string }
  | { ok: false; error: string };

// ============ UNIFIED "BILL THIS PERIOD" ============
// Combines forecast billing_entries (existing rows) with schedule-driven
// suggestions (computed live) into a single billable-rows list. Dedup: if
// a billing_line already has a forecast entry for the suggestion's target
// period, the forecast wins (we don't show both).
//
// The Bill This Period panel renders this list with checkboxes - user
// picks what to bill, optionally tweaks amounts, then a single Create AFP
// action wraps everything into a pay application (creating any missing
// billing_entries on the fly).

export type BillableRow =
  | {
      kind: "forecast";
      key: string;                    // entry id
      entryId: string;
      billingLineId: string;
      itemNumber: string;
      description: string;
      periodMonth: string;
      afpNumber: string | null;
      status: string;
      amount: number;
      retainage: number;
      // When a schedule-driven suggestion would have fired for the same
      // (billing_line, period), expose the disagreement so the UI can warn.
      scheduleSuggestedAmount?: number;
      scheduleConfidence?: Confidence;
      scheduleSourcesSummary?: string;
    }
  | {
      kind: "suggestion";
      key: string;                    // billing_line_id + period
      billingLineId: string;
      itemNumber: string;
      description: string;
      periodMonth: string;
      amount: number;
      confidence: Confidence;
      sourcesSummary: string;
      reasons: string[];
      alreadyBilled: number;
      targetPct: number;
    };

export async function getBillThisPeriodRows(
  projectId: string,
): Promise<{ ok: true; rows: BillableRow[] } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const today = new Date();
  const thisMonthIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  // Tight billing window: current month + immediate next month only. Far-future
  // forecasts (esp. from bulk cash-flow imports) belong on the timeline chart,
  // not on the "Bill this period" action panel.
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextMonthIsoLocal = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;

  // Pull forecast entries within the billing window only.
  // billing_line_id is included explicitly so dedup against suggestions works.
  const { data: entries, error: entriesErr } = await auth.supabase
    .from("billing_entries")
    .select(
      "id, billing_line_id, period_month, planned_amount, retainage_amount, afp_number, status, billing_lines!inner(project_id, item_number, description)",
    )
    .eq("billing_lines.project_id", projectId)
    .in("status", ["forecast", "suggested", "reviewed"])
    .gte("period_month", thisMonthIso)
    .lte("period_month", nextMonthIsoLocal)
    .order("period_month");
  if (entriesErr) return { ok: false, error: entriesErr.message };

  // Fix #1: drop zero-value placeholder rows. Can't bill $0, just clutters
  // the list. They came in from the cash-flow xlsx import as placeholders.
  const forecastRows: BillableRow[] = (entries ?? [])
    .filter((e) => Number(e.planned_amount ?? 0) > 0)
    .map((e) => {
      const line = e.billing_lines as unknown as {
        item_number: string | null;
        description: string | null;
      } | null;
      return {
        kind: "forecast" as const,
        key: `f:${e.id}`,
        entryId: e.id,
        billingLineId: e.billing_line_id ?? "",
        itemNumber: line?.item_number ?? "",
        description: line?.description ?? "",
        periodMonth: e.period_month,
        afpNumber: e.afp_number ?? null,
        status: e.status ?? "forecast",
        amount: Number(e.planned_amount ?? 0),
        retainage: Number(e.retainage_amount ?? 0),
      };
    });

  // Now pull schedule-based suggestions for the upcoming period.
  const suggResult = await computeBillingSuggestions(projectId);
  if (!suggResult.ok) {
    // Don't fail the whole call - just return what we have.
    return { ok: true, rows: forecastRows };
  }
  const { suggestions, nextMonthIso } = suggResult;

  // Fix #2: dedup. Build a map (billingLineId -> suggestion) so we can either
  // attach the suggestion to the matching forecast (for the mismatch warning)
  // or surface it standalone if no forecast exists.
  const suggestionByLineId = new Map(
    suggestions.map((s) => [s.billingLineId, s]),
  );
  // Track which suggestions get consumed by a forecast match so we don't
  // double-render.
  const consumedLineIds = new Set<string>();

  // Fix #3: when a forecast row matches a schedule suggestion (same line, and
  // forecast's period == nextMonthIso), enrich the forecast with the schedule
  // numbers so the UI can show a mismatch warning if the values disagree.
  const enrichedForecasts: BillableRow[] = forecastRows.map((r) => {
    if (r.kind !== "forecast") return r;
    if (r.periodMonth !== nextMonthIso) return r;
    const match = suggestionByLineId.get(r.billingLineId);
    if (!match) return r;
    consumedLineIds.add(r.billingLineId);
    return {
      ...r,
      scheduleSuggestedAmount: match.suggestedAmount,
      scheduleConfidence: match.confidence,
      scheduleSourcesSummary: match.sourcesSummary,
    };
  });

  const suggestionRows: BillableRow[] = suggestions
    .filter((s) => !consumedLineIds.has(s.billingLineId))
    .map((s) => ({
      kind: "suggestion" as const,
      key: `s:${s.billingLineId}:${nextMonthIso}`,
      billingLineId: s.billingLineId,
      itemNumber: s.itemNumber,
      description: s.description,
      periodMonth: nextMonthIso,
      amount: s.suggestedAmount,
      confidence: s.confidence,
      sourcesSummary: s.sourcesSummary,
      reasons: s.reasons,
      alreadyBilled: s.alreadyBilled,
      targetPct: s.targetPct,
    }));

  // Sort: by period, then forecast before suggestion within a period
  const all = [...enrichedForecasts, ...suggestionRows].sort((a, b) => {
    if (a.periodMonth !== b.periodMonth) return a.periodMonth.localeCompare(b.periodMonth);
    if (a.kind !== b.kind) return a.kind === "forecast" ? -1 : 1;
    return (a.itemNumber || "").localeCompare(b.itemNumber || "");
  });

  return { ok: true, rows: all };
}

export async function promoteSuggestionsToPlanned(
  projectId: string,
): Promise<PromoteResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const result = await computeBillingSuggestions(projectId);
  if (!result.ok) return result;
  const { suggestions, nextMonthIso } = result;

  if (suggestions.length === 0) {
    return { ok: true, written: 0, period_month: nextMonthIso };
  }

  // For each suggestion, upsert a billing_entry at next month with the suggested
  // planned_amount, but only if no entry exists at that month yet.
  let written = 0;
  for (const s of suggestions) {
    const { data: existing } = await auth.supabase
      .from("billing_entries")
      .select("id, planned_amount, actual_amount")
      .eq("billing_line_id", s.billingLineId)
      .eq("period_month", nextMonthIso)
      .maybeSingle();
    if (existing && (Number(existing.planned_amount ?? 0) > 0 || Number(existing.actual_amount ?? 0) > 0)) {
      // Don't overwrite a row that already has a real value
      continue;
    }
    const { error } = await auth.supabase
      .from("billing_entries")
      .upsert(
        {
          billing_line_id: s.billingLineId,
          period_month: nextMonthIso,
          planned_amount: s.suggestedAmount,
          actual_amount: 0,
          notes: "Auto-suggested from schedule",
        },
        { onConflict: "billing_line_id,period_month" },
      );
    if (error) return { ok: false, error: error.message };
    written += 1;
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/billing`);
  return { ok: true, written, period_month: nextMonthIso };
}
