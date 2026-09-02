"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { loadMonthlyManpower } from "@/lib/monthly-manpower-load";
import { diffIncidents, monthPeriod } from "@/lib/monthly-manpower";
import type { ExtraIncident, IncidentOverride } from "@/lib/monthly-manpower";
import type { Json } from "@/lib/database.types";

// Writing the Monthly Manpower and Incident Report.
//
// Same rule as the weekly report: a box the human did not touch stays null in
// the database, and null means "keep deriving it". The form sends back the
// whole report every save and this action strips anything the platform would
// have said anyway - otherwise pressing Save once would freeze the month's
// hours at their current value and the report would stop tracking a field
// report approved the following week.
//
// The one place that rule is deliberately NOT applied is incident
// classification. `types` has no derivation to fall back to - the suggested
// types are a keyword hint, not an answer - so a classification that happens to
// match the suggestion is still a decision a human took, and dropping it as
// "same as derived" would silently unclassify the incident on the next save.

export type MonthlyResult = { ok: true } | { ok: false; error: string };

export type MonthlyFormInput = {
  projectId: string;
  periodMonth: string;
  periodStart: string;
  periodEnd: string;
  /** Empty string means "no override" - go back to the derived total. */
  manhoursOverride: string;
  manhoursNote: string;
  incidents: Record<string, IncidentOverride>;
  extras: ExtraIncident[];
  note: string;
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
      error:
        "The monthly manpower report is an AHC document - your role cannot edit it.",
    };
  }
  return { ok: true as const, supabase, userId: user.id };
}

const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

const MIGRATION_MISSING =
  "Migration 0045_monthly_manpower_report.sql has not been applied to Supabase yet, so there is nowhere to save this.";

/** Keep only extras that actually say something, and give each a stable key. */
function cleanExtras(extras: ExtraIncident[]): ExtraIncident[] {
  return extras
    .filter((e) => isIso(e.occurredOn ?? "") && (e.description?.trim() || e.types?.length))
    .map((e, i) => ({
      key: e.key?.startsWith("manual:") ? e.key : `manual:${e.occurredOn}:${i}`,
      occurredOn: e.occurredOn,
      types: Array.isArray(e.types) ? e.types : [],
      description: (e.description ?? "").trim(),
      ...(e.reportedBy?.trim() ? { reportedBy: e.reportedBy.trim() } : {}),
    }));
}

export async function saveMonthlyManpower(
  input: MonthlyFormInput,
): Promise<MonthlyResult> {
  const auth = await requireAhc();
  if (!auth.ok) return auth;
  const { supabase, userId } = auth;

  if (!isIso(input.periodMonth) || !input.periodMonth.endsWith("-01")) {
    return { ok: false, error: "The report month is not a valid YYYY-MM-01 date." };
  }
  const period =
    isIso(input.periodStart) && isIso(input.periodEnd) && input.periodStart <= input.periodEnd
      ? { start: input.periodStart, end: input.periodEnd }
      : monthPeriod(input.periodMonth);

  // Re-derive server-side rather than trusting what the browser sent. The form
  // could be minutes old and the diff is only meaningful against the current
  // derivation.
  const view = await loadMonthlyManpower(input.projectId, input.periodMonth);
  if (view.storageMissing) return { ok: false, error: MIGRATION_MISSING };
  if (view.status === "submitted") {
    return {
      ok: false,
      error: "This report has been filed with the owner. Reopen it before editing.",
    };
  }

  // An override that equals the derived total is not an override. Storing it
  // would freeze the month at today's figure and stop it tracking a field
  // report approved next week.
  const typed = input.manhoursOverride.trim();
  let manhoursOverride: number | null = null;
  if (typed) {
    const n = Number(typed);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: "Manhours must be a number of zero or more." };
    }
    manhoursOverride = n === view.hours.derived.total ? null : n;
  }

  const { error } = await supabase.from("monthly_manpower_reports").upsert(
    {
      project_id: input.projectId,
      period_month: input.periodMonth,
      period_start: period.start,
      period_end: period.end,
      status: "draft",
      manhours_override: manhoursOverride,
      // The note explains the override, so it goes with it. Kept when there is
      // no override only if it was typed anyway - it prints on the backup sheet.
      manhours_note: input.manhoursNote.trim() || null,
      incidents: diffIncidents(input.incidents, view.candidates) as unknown as Json,
      extra_incidents: cleanExtras(input.extras) as unknown as Json,
      note: input.note.trim() || null,
      // Only on the first write. Setting it on every upsert turns "who created
      // this report" into "who saved it last".
      ...(view.saved ? {} : { created_by: userId }),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id,period_month" },
  );
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/reports/monthly-manpower`);
  return { ok: true };
}

/**
 * Mark the report filed with the owner. This is the one moment a snapshot is
 * correct: what was submitted has to be reproducible exactly, even after the
 * field reports behind it are corrected.
 *
 * It refuses while anything is unresolved. The blockers are not advisory - an
 * unclassified incident cannot be keyed into the form at all, and a month with
 * a missing day reports fewer hours than were worked.
 */
export async function submitMonthlyManpower(input: {
  projectId: string;
  periodMonth: string;
  /** Set when the human has read the blockers and is filing anyway. */
  force?: boolean;
}): Promise<MonthlyResult> {
  const auth = await requireAhc();
  if (!auth.ok) return auth;
  const { supabase, userId } = auth;

  const view = await loadMonthlyManpower(input.projectId, input.periodMonth);
  if (view.storageMissing) return { ok: false, error: MIGRATION_MISSING };
  if (!view.saved) return { ok: false, error: "Save the report before marking it filed." };
  if (view.status === "submitted") return { ok: true };
  if (!view.ready && !input.force) {
    return { ok: false, error: view.blockers.join(" ") };
  }

  const payload = {
    period: view.period,
    projectName: view.projectName,
    hours: {
      reported: view.hours.reported,
      derived: view.hours.derived,
      overridden: view.hours.overridden,
      note: view.hours.note,
      gaps: view.hours.gaps,
    },
    incidents: view.incidents.filter((i) => !i.hidden),
    submissions: view.submissions,
    // Recorded because a report filed over its own blockers is a decision, and
    // the reason it was filed short has to survive with it.
    filedWithBlockers: view.ready ? [] : view.blockers,
  };

  const { error } = await supabase
    .from("monthly_manpower_reports")
    .update({
      status: "submitted",
      submitted_at: new Date().toISOString(),
      submitted_by: userId,
      submitted_payload: payload as unknown as Json,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", input.projectId)
    .eq("period_month", input.periodMonth);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/reports/monthly-manpower`);
  return { ok: true };
}

/** Reopen a filed report. The frozen payload goes with it - the point of
 *  reopening is that what was filed was wrong. */
export async function reopenMonthlyManpower(input: {
  projectId: string;
  periodMonth: string;
}): Promise<MonthlyResult> {
  const auth = await requireAhc();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("monthly_manpower_reports")
    .update({
      status: "draft",
      submitted_at: null,
      submitted_by: null,
      submitted_payload: null,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", input.projectId)
    .eq("period_month", input.periodMonth);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/reports/monthly-manpower`);
  return { ok: true };
}
