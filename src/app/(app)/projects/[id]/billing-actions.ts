"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  aggregateConfidence,
  estimateProcurementProgress,
  estimateTaskProgress,
  isProcurementLine,
  durationWeightedPct,
  type LinkedPo,
  type ProcurementMilestone,
  type Confidence,
  type ProgressEstimate,
} from "@/lib/progress";
import { progressAsOf } from "@/lib/billing-period";
import { resolveBillingPeriod } from "@/lib/billing-period-resolve";

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
  /**
   * Set when the line cannot produce a defensible number and needs a human.
   * suggestedAmount is 0 whenever this is present.
   */
  blockedReason?: string;
  /** True when targetPct was weighted by task duration rather than averaged. */
  weightedByDuration: boolean;
  /** The plain mean, so the UI can show what the weighting changed. */
  unweightedPct: number;
  /**
   * The per-task working behind suggestedAmount, so the PM can see WHY the
   * number is what it is before putting it on an owner-facing G702 rather than
   * taking it on faith.
   */
  evidence: BillingEvidenceItem[];
};

export type BillingEvidenceItem = {
  wbsCode: string;
  taskName: string;
  pct: number;
  durationDays: number | null;
  /** Share of the SOV line this task carries, 0-1. */
  weight: number;
  /** 'dpr' when an approved field report set it, else how it was inferred. */
  source: string;
};

/**
 * WBS codes that are summary/parent rows rather than real work.
 *
 * A parent's percent is a rollup, and on this project it is worse than that:
 * applyPinProgressToSchedule writes an approved pin's task_new_pct straight
 * onto whatever schedule_task the pin is linked to, so Sweet Springs' "5.1
 * Civil Construction" summary carries 75% while nearly every child under it is
 * Not Started. 75% x $413,045.92 on SOV 6.02 would recommend billing ~$230k for
 * a month of clearing and grubbing. Summary rows never drive money; a SOV line
 * linked only to summaries is reported as needing a re-link instead.
 */
function summaryWbsCodes(
  tasks: Array<{ wbs_code: string; parent_wbs_code?: string | null }>,
): Set<string> {
  const parents = new Set<string>();
  for (const t of tasks) {
    if (t.parent_wbs_code) parents.add(t.parent_wbs_code);
  }
  return parents;
}

export async function computeBillingSuggestions(
  projectId: string,
  periodMonth?: string,
): Promise<{ ok: true; suggestions: BillingSuggestion[]; nextMonthIso: string } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  // Progress is evaluated as of the end of the period being billed, or today if
  // the period has not closed yet. See progressAsOf - a period end in the future
  // would let date interpolation bill work that has not happened.
  const period = periodMonth ?? (await resolveBillingPeriod(auth.supabase, projectId));
  const nextMonthIso = period;
  const todayIso = progressAsOf(period);

  const [{ data: lines }, { data: tasks }, { data: totals }, { data: pos }] = await Promise.all([
    auth.supabase
      .from("billing_lines")
      .select("id, item_number, description, type, scheduled_value, linked_task_wbs_codes, linked_procurement_order_ids")
      .eq("project_id", projectId),
    auth.supabase
      .from("schedule_tasks")
      .select("wbs_code, task_name, status, start_date, end_date, pct_complete, parent_wbs_code, duration_days")
      .eq("project_id", projectId),
    auth.supabase
      .from("v_billing_line_totals")
      .select("billing_line_id, total_billed, remaining_to_bill")
      .eq("project_id", projectId),
    auth.supabase
      .from("procurement_orders")
      .select("id, po_number, vendor_name, total_value, status, signed_at, actual_delivery_date")
      .eq("project_id", projectId),
  ]);

  // Payment milestones decide what a procurement line has actually earned.
  // See estimateProcurementProgress: a signed PO is a commitment, not value.
  const { data: milestones } = await auth.supabase
    .from("procurement_payments")
    .select("procurement_order_id, milestone_name, amount, pct_of_total, trigger_event, paid_at")
    .in("procurement_order_id", (pos ?? []).map((p) => p.id));
  const msByPo = new Map<string, Array<Record<string, unknown>>>();
  for (const m of milestones ?? []) {
    const list = msByPo.get(m.procurement_order_id) ?? [];
    list.push(m);
    msByPo.set(m.procurement_order_id, list);
  }

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
  const summaryCodes = summaryWbsCodes(tasks ?? []);
  const taskNameByCode = new Map<string, string>();
  for (const t of tasks ?? []) {
    taskNameByCode.set(t.wbs_code, (t as { task_name?: string }).task_name ?? "");
  }
  const durationByCode = new Map<string, number | null>();
  for (const t of tasks ?? []) {
    durationByCode.set(
      t.wbs_code,
      (t as { duration_days?: number | null }).duration_days ?? null,
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
  // Index POs by id so we can resolve linked_procurement_order_ids quickly.
  const poById = new Map<string, LinkedPo>();
  for (const p of pos ?? []) {
    poById.set(p.id, {
      po_number: p.po_number,
      vendor_name: p.vendor_name,
      total_value: p.total_value,
      status: p.status,
      signed_at: p.signed_at,
      actual_delivery_date: (p as { actual_delivery_date?: string | null }).actual_delivery_date ?? null,
      milestones: (msByPo.get(p.id) ?? []) as ProcurementMilestone[],
    });
  }

  const suggestions: BillingSuggestion[] = [];
  for (const line of lines ?? []) {
    const scheduledValue = Number(line.scheduled_value ?? 0);
    const t = totalsById.get(line.id) ?? { billed: 0, remaining: scheduledValue };

    let estimateRecords: ProgressEstimate[] = [];
    // Parallel to estimateRecords: the scheduled duration backing each
    // estimate, used to weight the roll-up. See durationWeightedPct().
    let estimateWeights: Array<number | null> = [];
    let evidenceCodes: string[] = [];
    let procurementDetail: string[] = [];
    let linkedCount = 0;

    // Procurement-scope lines: progress comes from PO state, NOT schedule date math.
    if (isProcurementLine(line)) {
      const poIds = (line as unknown as { linked_procurement_order_ids: string[] | null })
        .linked_procurement_order_ids ?? [];
      const linkedPos = poIds
        .map((id) => poById.get(id))
        .filter((p): p is LinkedPo => !!p);
      const procEst = estimateProcurementProgress(
        { scheduled_value: scheduledValue },
        linkedPos,
      );
      estimateRecords = [procEst];
      estimateWeights = [null]; // single estimate - weighting is a no-op
      evidenceCodes = [line.item_number];
      procurementDetail = (procEst as { detail?: string[] }).detail ?? [];
      linkedCount = linkedPos.length;
    } else {
      // Non-procurement lines: schedule-task-driven, leaf tasks only.
      const links = line.linked_task_wbs_codes ?? [];
      if (links.length === 0) continue;

      const leafLinks = links.filter((c) => !summaryCodes.has(c));
      const summaryLinks = links.filter((c) => summaryCodes.has(c));

      if (leafLinks.length === 0) {
        // Every link is a summary row, so there is no defensible percent.
        // Surface it rather than dropping the line silently - a $0 with a
        // reason is actionable, an absent row is not.
        suggestions.push({
          billingLineId: line.id,
          itemNumber: line.item_number,
          description: line.description,
          scheduledValue,
          alreadyBilled: t.billed,
          remaining: t.remaining,
          linkedTaskCount: 0,
          targetPct: 0,
          suggestedAmount: 0,
          confidence: "none",
          reasons: summaryLinks.map(
            (c) => `${c} is a summary/parent task - its percent is a rollup, not measured work`,
          ),
          sourcesSummary: "blocked",
          weightedByDuration: false,
          unweightedPct: 0,
          evidence: [],
          blockedReason: `Linked only to summary task${summaryLinks.length > 1 ? "s" : ""} ${summaryLinks.join(", ")}. Re-link this SOV line to the leaf tasks that represent the actual work.`,
        });
        continue;
      }

      const matched = leafLinks
        .map((c) => ({ code: c, est: estimateByCode.get(c) }))
        .filter((m): m is { code: string; est: ProgressEstimate } => !!m.est);
      if (matched.length === 0) continue;
      estimateRecords = matched.map((m) => m.est);
      estimateWeights = matched.map((m) => durationByCode.get(m.code) ?? null);
      evidenceCodes = matched.map((m) => m.code);
      linkedCount = matched.length;
    }

    const rollup = durationWeightedPct(
      estimateRecords.map((e, i) => ({
        pct: e.pct,
        durationDays: estimateWeights[i] ?? null,
      })),
    );
    const avgPct = rollup.pct;

    const knownDur = estimateWeights.filter(
      (d): d is number => d != null && d > 0,
    );
    const fallbackDur =
      knownDur.length > 0
        ? knownDur.reduce((a, b) => a + b, 0) / knownDur.length
        : 1;
    const totalWeight = estimateWeights.reduce(
      (s2: number, d) => s2 + (d != null && d > 0 ? d : fallbackDur),
      0,
    );
    const evidence: BillingEvidenceItem[] = procurementDetail.length
      ? procurementDetail.map((d) => {
          const [who, rest] = d.split(": ");
          return {
            wbsCode: who,
            taskName: rest ?? d,
            pct: /EARNED/.test(d) ? 100 : 0,
            durationDays: null,
            weight: 0,
            source: "payment milestone",
          };
        })
      : estimateRecords.map((e, i) => {
      const d = estimateWeights[i];
      const w = d != null && d > 0 ? d : fallbackDur;
      const code = evidenceCodes[i] ?? "";
      return {
        wbsCode: code,
        taskName: taskNameByCode.get(code) ?? "",
        pct: Math.round(e.pct * 1000) / 10,
        durationDays: d ?? null,
        weight: totalWeight > 0 ? w / totalWeight : 0,
        source: e.source,
      };
    });
    const confidence: Confidence = aggregateConfidence(
      estimateRecords.map((e) => e.confidence),
    );
    const sourceCounts = new Map<string, number>();
    for (const e of estimateRecords) {
      sourceCounts.set(e.source, (sourceCounts.get(e.source) ?? 0) + 1);
    }
    const sourcesSummary = Array.from(sourceCounts.entries())
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    const target = avgPct * scheduledValue;
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
      linkedTaskCount: linkedCount,
      targetPct: avgPct,
      suggestedAmount: Math.round(suggested * 100) / 100,
      confidence,
      reasons: estimateRecords.map((e) => e.reason),
      sourcesSummary,
      weightedByDuration: rollup.weightedByDuration,
      unweightedPct: rollup.unweightedPct,
      evidence,
    });
  }

  suggestions.sort((a, b) => b.suggestedAmount - a.suggestedAmount);

  return { ok: true, suggestions, nextMonthIso };
}

// Save the procurement_order links for a billing_line. Used by the inline
// PO linker on the /billing page. Pass an array of procurement_order ids
// (or empty array to clear).
export async function updateBillingLineProcurementLinks(
  billingLineId: string,
  projectId: string,
  poIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("billing_lines")
    .update({
      linked_procurement_order_ids: poIds.length > 0 ? poIds : null,
    } as never)
    .eq("id", billingLineId)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
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
      /**
       * What the field evidence supports, and the working behind it. This -
       * NOT the imported forecast - is what the panel proposes billing.
       *
       * The forecast came out of the owner cash-flow spreadsheet months ago and
       * says what someone PLANNED to bill; the recommendation says what the
       * approved field reports and the schedule actually support. Defaulting to
       * the forecast meant the Create AFP button was pre-loaded with $123,108
       * for an August the evidence valued at $95,064.
       */
      recommendedAmount?: number;
      evidence?: BillingEvidenceItem[];
      // Set when the signals do not support billing this line. The row is
      // still rendered (unchecked, with the reason shown) rather than hidden.
      blockedReason?: string;
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
      evidence?: BillingEvidenceItem[];
    };

export type HiddenForecast = {
  itemNumber: string;
  description: string;
  periodMonth: string;
  amount: number;
  reason: string;
};

export async function getBillThisPeriodRows(
  projectId: string,
  periodMonth?: string,
): Promise<
  | { ok: true; rows: BillableRow[]; hidden: HiddenForecast[]; periodMonth: string }
  | { ok: false; error: string }
> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  // One period at a time. This used to be "current month + next month", which
  // both mixed two months into one application and made a closed month
  // unbillable once the calendar rolled over.
  const period = periodMonth ?? (await resolveBillingPeriod(auth.supabase, projectId));
  const thisMonthIso = period;
  const nextMonthIsoLocal = period;
  const todayIso = progressAsOf(period);

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
  const allForecastRows = (entries ?? [])
    .filter((e) => Number(e.planned_amount ?? 0) > 0)
    .map((e) => {
      const line = e.billing_lines as unknown as {
        item_number: string | null;
        description: string | null;
      } | null;
      return {
        e,
        row: {
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
        } as BillableRow,
      };
    });

  // Schedule-based suggestions for the same period.
  const suggResult = await computeBillingSuggestions(projectId, period);
  if (!suggResult.ok) {
    return {
      ok: true,
      rows: allForecastRows.map((x) => x.row),
      hidden: [],
      periodMonth: period,
    };
  }
  const { suggestions, nextMonthIso } = suggResult;

  // Pull line + task info so we can decide per forecast row whether the
  // schedule (or for procurement lines, the PO state) supports billing.
  const { data: lineInfo } = await auth.supabase
    .from("billing_lines")
    .select("id, type, description, scheduled_value, linked_task_wbs_codes, linked_procurement_order_ids")
    .eq("project_id", projectId);
  const { data: taskInfo } = await auth.supabase
    .from("schedule_tasks")
    .select("wbs_code, status, start_date, end_date, pct_complete, parent_wbs_code")
    .eq("project_id", projectId);
  const { data: posInfo } = await auth.supabase
    .from("procurement_orders")
    .select("id, po_number, vendor_name, total_value, status, signed_at, actual_delivery_date")
    .eq("project_id", projectId);
  const { data: msInfo } = await auth.supabase
    .from("procurement_payments")
    .select("procurement_order_id, milestone_name, amount, pct_of_total, trigger_event, paid_at")
    .in("procurement_order_id", (posInfo ?? []).map((p) => p.id));
  const msByPoId = new Map<string, ProcurementMilestone[]>();
  for (const m of msInfo ?? []) {
    const list = msByPoId.get(m.procurement_order_id) ?? [];
    list.push(m as ProcurementMilestone);
    msByPoId.set(m.procurement_order_id, list);
  }
  const { data: lineTotals } = await auth.supabase
    .from("v_billing_line_totals")
    .select("billing_line_id, total_billed")
    .eq("project_id", projectId);
  const billedByLine = new Map<string, number>();
  for (const t of lineTotals ?? []) {
    if (t.billing_line_id) {
      billedByLine.set(t.billing_line_id, Number(t.total_billed ?? 0));
    }
  }

  const lineById = new Map<string, {
    type: string | null;
    description: string | null;
    scheduled_value: number | null;
    linked_task_wbs_codes: string[] | null;
    linked_procurement_order_ids: string[] | null;
  }>();
  for (const l of lineInfo ?? []) {
    lineById.set(l.id, {
      type: l.type,
      description: l.description,
      scheduled_value: l.scheduled_value,
      linked_task_wbs_codes: l.linked_task_wbs_codes,
      linked_procurement_order_ids: (l as unknown as { linked_procurement_order_ids: string[] | null })
        .linked_procurement_order_ids,
    });
  }
  const taskEstimates = new Map<string, number>();
  for (const t of taskInfo ?? []) {
    taskEstimates.set(
      t.wbs_code,
      estimateTaskProgress(
        {
          status: t.status,
          start_date: t.start_date,
          end_date: t.end_date,
          pct_complete: t.pct_complete,
        },
        todayIso,
      ).pct,
    );
  }
  // Summary rows are excluded from the billing signal here for the same reason
  // they are in computeBillingSuggestions - a rollup percent is not measured
  // work. See summaryWbsCodes().
  const summaryCodes = summaryWbsCodes(taskInfo ?? []);
  const poStateById = new Map<string, LinkedPo>();
  for (const p of posInfo ?? []) {
    poStateById.set(p.id, {
      po_number: p.po_number,
      vendor_name: p.vendor_name,
      total_value: p.total_value,
      status: p.status,
      signed_at: p.signed_at,
      actual_delivery_date: (p as { actual_delivery_date?: string | null }).actual_delivery_date ?? null,
      milestones: msByPoId.get(p.id) ?? [],
    });
  }

  // Every forecast row in the window is rendered. Where the schedule (or PO
  // state, for procurement lines) does not support billing, the row carries a
  // blockedReason and arrives unchecked instead of being dropped.
  //
  // It used to be dropped. On Sweet Springs that silently removed SOV 6.03
  // (Fencing/SWPPP) from the August panel because its only link, 5.1.1.6, sat
  // at 0% - while the approved 8/12 field report said the silt fence was
  // finished. A line the PM may legitimately need to bill must never vanish
  // without saying why. `hidden` is still populated so existing callers keep
  // working, but it is now a duplicate view of the blocked rows, not a set of
  // rows that disappeared.
  const forecastRows: BillableRow[] = [];
  const hidden: HiddenForecast[] = [];

  const blockRow = (row: BillableRow, reason: string) => {
    forecastRows.push({ ...row, blockedReason: reason } as BillableRow);
    if (row.kind === "forecast") {
      hidden.push({
        itemNumber: row.itemNumber,
        description: row.description,
        periodMonth: row.periodMonth,
        amount: row.amount,
        reason,
      });
    }
  };
  for (const x of allForecastRows) {
    const lineMeta = lineById.get(x.row.billingLineId);

    // PROCUREMENT LINES: signal is SIGNED PO link (drafts don't count).
    // Billable amount = signed PO total (capped at scheduled_value).
    //
    // We DON'T subtract billedByLine[total_billed] here because historical
    // billings (from cash-flow import or older AFPs) were for OTHER scope
    // unrelated to the currently-linked POs. Subtracting them would block
    // billing for newly-signed POs which is wrong - signing a new PO
    // commits new cost that the owner needs to pay for.
    //
    // KNOWN LIMITATION: this means re-signing the same PO month after
    // month would show the same billable amount, and the PM could create
    // duplicate AFPs for the same PO. Tracking per-PO billed_at on
    // procurement_orders is the next step to prevent this.
    if (lineMeta && isProcurementLine(lineMeta)) {
      // Earned value comes from PO payment milestones that have actually been
      // triggered, not from the fact a PO was signed. Counting signed POs at
      // full value made SOV 5.05 offer ~$65,700 in August for POI equipment not
      // due on site until November. See estimateProcurementProgress.
      //
      // Prior billings ARE subtracted here now. The old code deliberately did
      // not, on the reasoning that historical billings covered unrelated scope,
      // and carried a KNOWN LIMITATION note that the same PO could therefore be
      // billed month after month. Milestones make the subtraction safe: a
      // milestone is a specific piece of value, so netting off what has already
      // been billed against the line cannot double-count it.
      const poIds = lineMeta.linked_procurement_order_ids ?? [];
      const linked = poIds
        .map((id) => poStateById.get(id))
        .filter((p): p is LinkedPo => !!p);
      const scheduledValue = Number(lineMeta.scheduled_value ?? 0);
      const est = estimateProcurementProgress(
        { scheduled_value: scheduledValue },
        linked,
      );
      const alreadyBilled = billedByLine.get(x.row.billingLineId) ?? 0;
      const billable = Math.max(0, est.earnedValue - alreadyBilled);

      if (billable > 0) {
        forecastRows.push({ ...x.row, amount: billable });
      } else if (est.earnedValue > 0) {
        blockRow(
          x.row,
          `$${Math.round(est.earnedValue).toLocaleString("en-US")} of milestones triggered, but $${Math.round(alreadyBilled).toLocaleString("en-US")} already billed on this line - nothing further earned`,
        );
      } else {
        blockRow(x.row, est.reason);
      }
      continue;
    }

    // NON-PROCUREMENT: schedule task signal, leaf tasks only.
    const links = lineMeta?.linked_task_wbs_codes ?? [];
    if (links.length === 0) {
      forecastRows.push(x.row);
      continue;
    }

    const summaryLinks = links.filter((c) => summaryCodes.has(c));
    const leafLinks = links.filter((c) => !summaryCodes.has(c));
    if (leafLinks.length === 0) {
      blockRow(
        x.row,
        `Linked only to summary task${summaryLinks.length > 1 ? "s" : ""} ${summaryLinks.join(", ")}. A rollup percent is not measured work - re-link to the leaf tasks.`,
      );
      continue;
    }

    const linked = leafLinks
      .map((c) => taskEstimates.get(c))
      .filter((v): v is number => v != null);
    const avgPct =
      linked.length === 0
        ? 0
        : linked.reduce((s, v) => s + v, 0) / linked.length;
    if (avgPct > 0) {
      forecastRows.push(x.row);
    } else {
      blockRow(
        x.row,
        linked.length < leafLinks.length
          ? `${leafLinks.length} WBS code(s) linked but ${leafLinks.length - linked.length} not found in schedule`
          : "Linked schedule tasks show 0% progress. If work happened, check the field reports are approved and pinned to the right task.",
      );
    }
  }

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
      recommendedAmount: match.suggestedAmount,
      evidence: match.evidence,
    };
  });

  const suggestionRows: BillableRow[] = suggestions
    .filter((s) => !consumedLineIds.has(s.billingLineId))
    .map((s) => ({
      kind: "suggestion" as const,
      key: `s:${s.billingLineId}:${nextMonthIso}`,
      billingLineId: s.billingLineId,
      itemNumber: s.itemNumber,
      evidence: s.evidence,
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

  return { ok: true, rows: all, hidden, periodMonth: period };
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
