"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { loadWeeklyReport, resolveWeekly } from "@/lib/weekly-report-load";
import {
  defaultPeriod,
  diffContractors,
  diffEquipment,
  diffMilestones,
} from "@/lib/weekly-report";
import type { ContractorRow, EquipmentRow } from "@/lib/weekly-report";
import type { Json } from "@/lib/database.types";

// Writing the weekly report.
//
// The rule that shapes every action here: a box the human did not touch stays
// null in the database, and null means "keep deriving it". So the form sends
// back the WHOLE report every save, and this action strips out anything that
// still matches what the platform would have said anyway. Without that step,
// pressing Save once would freeze all sixteen boxes at their current derived
// values and the report would stop tracking the field record - which is the
// one behaviour this feature exists to avoid.
//
// The corollary took a bug to learn: the thing each box is compared against has
// to be the derivation with NO overrides applied (`view.base`), not the
// resolved view. Compared against the resolved view, an override the human left
// alone equals its own baseline, so it is dropped as "same as derived", so the
// second Save deletes the first Save's corrections. The narrative boxes were
// always safe because their derivation never saw the overrides; the tables,
// the milestone dates and the SWPPP date were not.

export type WeeklyResult = { ok: true } | { ok: false; error: string };

export type WeeklyFormInput = {
  projectId: string;
  weekEnding: string;
  periodStart: string;
  periodEnd: string;
  dimensionCm: string;
  epcReportingManager: string;
  epcTeam: string;
  environmentConcerns: string;
  securityConcerns: string;
  safetySummary: string;
  positionNote: string;
  photoNote: string;
  photoKeys: string[];
  weatherSummary: string;
  workThisWeek: string;
  lookaheadNote: string;
  scheduleRisks: string;
  swpppInspectionDate: string;
  milestones: Record<string, string>;
  contractors: ContractorRow[];
  equipment: EquipmentRow[];
};

async function requireAhc() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || !["phil", "zarina", "ahc_super"].includes(profile.role ?? "")) {
    return {
      ok: false as const,
      error: "The weekly progress report is an AHC document - your role cannot edit it.",
    };
  }
  return { ok: true as const, supabase, userId: user.id };
}

const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function saveWeeklyReport(input: WeeklyFormInput): Promise<WeeklyResult> {
  const auth = await requireAhc();
  if (!auth.ok) return auth;
  const { supabase, userId } = auth;

  if (!isIso(input.weekEnding)) return { ok: false, error: "Week ending is not a valid date." };
  const period =
    isIso(input.periodStart) && isIso(input.periodEnd) && input.periodStart <= input.periodEnd
      ? { start: input.periodStart, end: input.periodEnd }
      : defaultPeriod(input.weekEnding);

  // Re-derive server-side rather than trusting what the browser sent. The form
  // could be minutes old, and the diff is only meaningful against the current
  // derivation.
  const view = await loadWeeklyReport(input.projectId, input.weekEnding);
  if (view.storageMissing) {
    return {
      ok: false,
      error:
        "Migration 0041_weekly_progress_reports.sql has not been applied to Supabase yet, so there is nowhere to save this.",
    };
  }
  if (view.status === "issued") {
    return { ok: false, error: "This report has been issued. Reopen it before editing." };
  }

  // Empty string and "same as derived" both mean "no override". The narrative
  // derivations never see the saved overrides, so `view.<box>.value` is already
  // the right baseline for these.
  const over = (submitted: string, derivedValue: string) => {
    const t = submitted.trim();
    if (!t) return null;
    return t === derivedValue.trim() ? null : t;
  };

  const milestones = diffMilestones(input.milestones, view.base.milestones);
  const contractors = diffContractors(input.contractors, view.base.contractors);
  const equipment = diffEquipment(input.equipment, view.base.equipment);

  const { error } = await supabase.from("weekly_progress_reports").upsert(
    {
      project_id: input.projectId,
      week_ending: input.weekEnding,
      period_start: period.start,
      period_end: period.end,
      status: "draft",
      // Header names are always stored. They are typed, not derived, and
      // carrying them forward from last week is a default, not an answer.
      dimension_cm: input.dimensionCm.trim() || null,
      epc_reporting_manager: input.epcReportingManager.trim() || null,
      epc_team: input.epcTeam.trim() || null,
      environment_concerns: over(input.environmentConcerns, view.environment.value),
      security_concerns: over(input.securityConcerns, view.security.value),
      // 0042's three columns. Written only when the migration is applied, so a
      // save on an un-migrated database still stores everything else instead of
      // failing whole.
      ...(view.extraOverridesAvailable
        ? {
            safety_summary: over(input.safetySummary, view.safety.value),
            position_note: over(input.positionNote, view.positionText),
            photo_note: input.photoNote.trim() || null,
            // An empty array means "no choice made", which is what puts the
            // report back on the automatic spread. A selection that happens to
            // match the automatic one is still stored - the human confirmed it.
            photo_keys: input.photoKeys as unknown as Json,
          }
        : {}),
      weather_summary: over(input.weatherSummary, view.weather.value),
      work_this_week: over(input.workThisWeek, view.workThisWeek.value),
      lookahead_note: input.lookaheadNote.trim() || null,
      schedule_risks: over(input.scheduleRisks, view.risks.value),
      // Compared against the DERIVED inspection date, not the resolved one -
      // resolved already contains the human's own answer, so re-saving an
      // untouched override deleted it.
      swppp_inspection_date:
        isIso(input.swpppInspectionDate) && input.swpppInspectionDate !== view.swppp.value
          ? input.swpppInspectionDate
          : null,
      milestones: milestones as Json,
      contractor_overrides: contractors.overrides as unknown as Json,
      extra_contractors: contractors.extras as unknown as Json,
      equipment_overrides: equipment.overrides as unknown as Json,
      extra_equipment: equipment.extras as unknown as Json,
      // Only on the first write. Setting it on every upsert turned "who
      // created this report" into "who saved it last".
      ...(view.saved ? {} : { created_by: userId }),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id,week_ending" },
  );
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/reports/weekly-progress`);
  return { ok: true };
}

/**
 * Issue the report. This is the one moment a snapshot is correct: what was
 * sent to the owner has to be reproducible exactly, even after the underlying
 * field reports are corrected.
 */
export async function issueWeeklyReport(input: {
  projectId: string;
  weekEnding: string;
}): Promise<WeeklyResult> {
  const auth = await requireAhc();
  if (!auth.ok) return auth;
  const { supabase, userId } = auth;

  const view = await loadWeeklyReport(input.projectId, input.weekEnding);
  if (view.storageMissing) {
    return { ok: false, error: "Migration 0041 has not been applied to Supabase yet." };
  }
  if (!view.saved) {
    return { ok: false, error: "Save the report before issuing it." };
  }
  if (view.status === "issued") return { ok: true };

  const resolved = resolveWeekly(view);
  const payload = {
    header: view.header,
    contractors: view.contractors,
    equipment: view.equipment,
    manHours: view.manHours.value,
    photos: view.photos,
    milestones: Object.fromEntries(
      Object.entries(view.milestones).map(([k, v]) => [k, v.value]),
    ),
    lookahead: view.lookahead,
    ...resolved,
  };

  const { error } = await supabase
    .from("weekly_progress_reports")
    .update({
      status: "issued",
      issued_at: new Date().toISOString(),
      issued_by: userId,
      issued_payload: payload as unknown as Json,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", input.projectId)
    .eq("week_ending", input.weekEnding);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/reports/weekly-progress`);
  return { ok: true };
}

/** Reopen an issued report. The frozen payload is dropped with it - the point
 *  of reopening is that the sent version was wrong. */
export async function reopenWeeklyReport(input: {
  projectId: string;
  weekEnding: string;
}): Promise<WeeklyResult> {
  const auth = await requireAhc();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("weekly_progress_reports")
    .update({
      status: "draft",
      issued_at: null,
      issued_by: null,
      issued_payload: null,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", input.projectId)
    .eq("week_ending", input.weekEnding);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/reports/weekly-progress`);
  return { ok: true };
}
