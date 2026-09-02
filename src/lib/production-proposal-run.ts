// The database half of the tracker's auto-fill: read one approved Field Report,
// propose the day's commodity production, write it unconfirmed.
//
// WHY THIS RUNS ON THE SERVICE-ROLE CLIENT
// daily_production is phil-only for writes (migration 0036) and the person who
// approves a Field Report is the CM. Gating the proposal on the approver's
// grants would mean it only ever fired when Phil himself did the review, which
// is the case that needs it least. So it writes through the admin client after
// the approval has already been authorised upstream - the same pattern as
// resubmitFieldReportPin. Nothing here is reachable without an approval that
// passed its own role check first.
//
// WHAT A PROPOSED ROW IS
// It is filed production, not a question. An approved Field Report is the
// project's record of the day, and the tracker's job is to report that record -
// so the row lands confirmed and flows straight to the owner's sheet and to
// bill verification. `source = 'field_report'` and `proposal_basis` preserve
// how the figure was reached; Phil corrects it on the tracker like any other
// number. The one thing that still distinguishes machine from human is rate
// calibration, in loadConfirmedHistory below.
//
// WHY IT NEVER THROWS
// A proposal is a convenience laid on top of a decision that already stands.
// If it fails, the CM's approval must not roll back and the review board must
// not show an error - the tracker simply stays blank for that day, exactly as
// it behaved before this existed. Every path returns a result object.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  activityScore,
  proposeForDay,
  type ConfirmedHistory,
  type DayEvidence,
  type ProposalCommodity,
} from "@/lib/production-proposal";

type Admin = SupabaseClient<Database>;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export type ProposalRunResult = {
  /** Rows written. Zero is a normal outcome, not a failure. */
  written: number;
  /** Commodities the evidence flagged or could not value, for the log. */
  notes: string[];
  error: string | null;
};

/**
 * Assemble the evidence for every date on a project that already has a
 * HUMAN-AUTHORED percent on record, so a daily rate can be calibrated from it.
 *
 * Deliberately reads `manual` and `backfill` rows only - the figures Phil typed
 * on the tracker and the reviewed historical reconstruction. `field_report`
 * rows are the proposer's own past output, and calibrating off those would let
 * one machine estimate justify the next: the rate is a fixed point under its
 * own output, so the series would coast on whatever it last guessed and drift
 * away from the last number a human actually stood behind.
 *
 * This is the ONLY thing that still cares who produced a number. Nothing about
 * billing or the owner push does - see loadEvidence in sub-billing-run.ts.
 */
async function loadConfirmedHistory(
  admin: Admin,
  projectId: string,
  commodities: ProposalCommodity[],
): Promise<ConfirmedHistory> {
  const pctIds = commodities.filter((c) => c.uom === "%").map((c) => c.id);
  const empty: ConfirmedHistory = {
    totalByCommodity: {},
    scoreByCommodity: {},
    typicalDailyByCommodity: {},
  };
  if (pctIds.length === 0) return empty;

  const { data: rows } = await admin
    .from("daily_production")
    .select("commodity_id, production_date, quantity")
    .eq("project_id", projectId)
    .in("commodity_id", pctIds)
    .in("source", ["manual", "backfill"])
    .gt("quantity", 0);
  if (!rows?.length) return empty;

  const keyById = new Map(commodities.map((c) => [c.id, c.key]));
  const dates = Array.from(new Set(rows.map((r) => r.production_date)));

  // The activity that earned those confirmed percents, from the same two
  // sources the live proposal reads.
  const [{ data: dprs }, { data: logs }] = await Promise.all([
    admin
      .from("dprs")
      .select("report_date, work_narrative, crew_count")
      .eq("project_id", projectId)
      .in("report_date", dates),
    admin
      .from("cm_daily_logs")
      .select("log_date, progress_summary, site_conditions")
      .eq("project_id", projectId)
      .in("log_date", dates),
  ]);

  const dprByDate = new Map((dprs ?? []).map((d) => [d.report_date, d]));
  const cmByDate = new Map(
    (logs ?? []).map((l) => [
      l.log_date,
      [l.progress_summary ?? "", l.site_conditions ?? ""].join("\n").trim(),
    ]),
  );

  const scoreByDate = new Map<string, number>();
  for (const date of dates) {
    const d = dprByDate.get(date);
    scoreByDate.set(
      date,
      activityScore({
        date,
        narrative: d?.work_narrative ?? "",
        cmLog: cmByDate.get(date) ?? "",
        pinTitles: [],
        crewCount: d?.crew_count ?? null,
      }),
    );
  }

  const history: ConfirmedHistory = {
    totalByCommodity: {},
    scoreByCommodity: {},
    typicalDailyByCommodity: {},
  };
  const dailiesByCommodity = new Map<string, number[]>();
  for (const row of rows) {
    const key = keyById.get(row.commodity_id);
    if (!key) continue;
    const qty = Number(row.quantity);
    history.totalByCommodity[key] = (history.totalByCommodity[key] ?? 0) + qty;
    history.scoreByCommodity[key] =
      (history.scoreByCommodity[key] ?? 0) + (scoreByDate.get(row.production_date) ?? 0);
    dailiesByCommodity.set(key, [...(dailiesByCommodity.get(key) ?? []), qty]);
  }
  for (const [key, dailies] of Array.from(dailiesByCommodity.entries())) {
    history.typicalDailyByCommodity[key] = median(dailies);
  }
  return history;
}

/**
 * Propose production for one Field Report. Idempotent: a day that already has
 * rows is left alone, so re-approving a corrected report never doubles a
 * number and never overwrites what Phil filed.
 */
export async function proposeProductionForReport(
  admin: Admin,
  input: { projectId: string; dprId: string },
): Promise<ProposalRunResult> {
  const notes: string[] = [];
  try {
    const { data: dpr, error: dprErr } = await admin
      .from("dprs")
      .select("id, project_id, report_date, status, work_narrative, crew_count")
      .eq("id", input.dprId)
      .maybeSingle();
    if (dprErr) return { written: 0, notes, error: dprErr.message };
    if (!dpr) return { written: 0, notes, error: "Field Report not found" };
    if (dpr.project_id !== input.projectId) {
      return { written: 0, notes, error: "Field Report belongs to another project" };
    }
    // Only an approved report may propose. A submitted or returned one is still
    // an open question, and the tracker is the owner's record.
    if (dpr.status !== "approved") {
      return { written: 0, notes, error: null };
    }

    const { data: commodityRows, error: commErr } = await admin
      .from("commodities")
      .select("id, key, label, uom")
      .eq("project_id", input.projectId)
      .eq("active", true);
    if (commErr) return { written: 0, notes, error: commErr.message };
    const commodities: ProposalCommodity[] = commodityRows ?? [];
    if (commodities.length === 0) return { written: 0, notes, error: null };

    // Never touch a day that is already on the tracker. Whether Phil typed those
    // rows or an earlier run proposed them, they are the current answer for that
    // date and a second approval must not restate it.
    const { data: existing } = await admin
      .from("daily_production")
      .select("commodity_id")
      .eq("project_id", input.projectId)
      .eq("production_date", dpr.report_date);
    const alreadyFiled = new Set((existing ?? []).map((r) => r.commodity_id));

    const [{ data: pins }, { data: cmLog }] = await Promise.all([
      admin
        .from("inspections")
        .select("title, quantity, unit_of_measure, schedule_task_id, status")
        .eq("dpr_id", input.dprId)
        .eq("origin", "sub"),
      admin
        .from("cm_daily_logs")
        .select("progress_summary, site_conditions")
        .eq("project_id", input.projectId)
        .eq("log_date", dpr.report_date)
        .maybeSingle(),
    ]);

    // Only approved pins describe work anyone has verified. A rejected pin on an
    // otherwise-approved report is precisely the thing that must not be counted.
    const approvedPins = (pins ?? []).filter((p) => p.status === "approved");

    const day: DayEvidence = {
      date: dpr.report_date,
      narrative: dpr.work_narrative ?? "",
      cmLog: [cmLog?.progress_summary ?? "", cmLog?.site_conditions ?? ""].join("\n").trim(),
      pinTitles: approvedPins.map((p) => p.title),
      crewCount: dpr.crew_count ?? null,
    };

    const pinQuantities = await loadPinQuantities(admin, commodities, approvedPins);
    const history = await loadConfirmedHistory(admin, input.projectId, commodities);
    const committedPercent = await loadCommittedPercent(admin, input.projectId, commodities);

    const result = proposeForDay({
      day,
      commodities,
      history,
      committedPercent,
      pinQuantities,
    });

    const byKey = new Map(commodities.map((c) => [c.key, c]));
    const rows = result.values
      .filter((v) => {
        const spec = byKey.get(v.commodityKey);
        return spec != null && !alreadyFiled.has(spec.id);
      })
      .map((v) => ({
        project_id: input.projectId,
        commodity_id: byKey.get(v.commodityKey)!.id,
        production_date: dpr.report_date,
        quantity: v.quantity,
        source: "field_report" as const,
        dpr_id: input.dprId,
        proposal_basis: v.basis,
        // FILED, NOT PENDING. The CM's approval of the report IS the approval
        // of the day's production - the tracker reports what the approved
        // record says, it does not hold a second opinion about it. So the row
        // lands live: it counts toward the owner's sheet and toward bill
        // verification from the moment the report is approved.
        //
        // `source` and `proposal_basis` still say exactly where the number came
        // from and how it was reached, so nothing about the audit trail is lost
        // by not making Phil click. He overrides on the tracker like any other
        // figure, and that override is what becomes 'manual'.
        confirmed_at: new Date().toISOString(),
      }));

    for (const f of result.flags) notes.push(`${f.commodityKey}: ${f.note}`);
    for (const s of result.skipped) notes.push(`${s.commodityKey}: ${s.reason}`);

    if (rows.length === 0) return { written: 0, notes, error: null };

    const { error: insErr } = await admin
      .from("daily_production")
      .upsert(rows, { onConflict: "project_id,production_date,commodity_id" });
    if (insErr) return { written: 0, notes, error: insErr.message };

    return { written: rows.length, notes, error: null };
  } catch (e) {
    return {
      written: 0,
      notes,
      error: e instanceof Error ? e.message : "Proposal failed",
    };
  }
}

/**
 * Quantities read straight off the report's pins.
 *
 * A pin carries a schedule_task_id; commodity_task_links maps that WBS task to
 * the commodity it produces. Where the link exists AND the pin's unit matches
 * the commodity's, the pin quantity IS the day's production and no estimation
 * is involved. Where the units disagree the pin is ignored: Sweet Springs' pins
 * currently count truck loads tagged "EA", which is not the same "ea" as
 * inverters or piles, and silently equating them would put fiction on the
 * owner's sheet.
 */
async function loadPinQuantities(
  admin: Admin,
  commodities: ProposalCommodity[],
  pins: { title: string; quantity: number | null; unit_of_measure: string | null; schedule_task_id: string | null }[],
): Promise<Record<string, { quantity: number; source: string }>> {
  const taskIds = pins
    .map((p) => p.schedule_task_id)
    .filter((id): id is string => Boolean(id));
  if (taskIds.length === 0) return {};

  const { data: links } = await admin
    .from("commodity_task_links")
    .select("commodity_id, schedule_task_id")
    .in("schedule_task_id", taskIds);
  if (!links?.length) return {};

  const commodityByTask = new Map<string, ProposalCommodity>();
  const byId = new Map(commodities.map((c) => [c.id, c]));
  for (const l of links) {
    const c = byId.get(l.commodity_id);
    if (c) commodityByTask.set(l.schedule_task_id, c);
  }

  const out: Record<string, { quantity: number; source: string }> = {};
  for (const pin of pins) {
    if (!pin.schedule_task_id || pin.quantity == null || pin.quantity <= 0) continue;
    const commodity = commodityByTask.get(pin.schedule_task_id);
    if (!commodity) continue;
    // A percent scope can never be read off a pin count.
    if (commodity.uom === "%") continue;
    const pinUom = (pin.unit_of_measure ?? "").trim().toLowerCase();
    if (pinUom !== commodity.uom.toLowerCase()) continue;
    const prior = out[commodity.key];
    out[commodity.key] = {
      quantity: (prior?.quantity ?? 0) + Number(pin.quantity),
      source: prior ? `${prior.source}; ${pin.title}` : pin.title,
    };
  }
  return out;
}

/** Percent already on the tracker per commodity, confirmed or proposed. */
async function loadCommittedPercent(
  admin: Admin,
  projectId: string,
  commodities: ProposalCommodity[],
): Promise<Record<string, number>> {
  const pct = commodities.filter((c) => c.uom === "%");
  if (pct.length === 0) return {};
  const { data } = await admin
    .from("daily_production")
    .select("commodity_id, quantity")
    .eq("project_id", projectId)
    .in("commodity_id", pct.map((c) => c.id));
  const keyById = new Map(pct.map((c) => [c.id, c.key]));
  const out: Record<string, number> = {};
  for (const row of data ?? []) {
    const key = keyById.get(row.commodity_id);
    if (!key) continue;
    out[key] = (out[key] ?? 0) + Number(row.quantity);
  }
  return out;
}
