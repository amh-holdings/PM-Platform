// Loading the Monthly Manpower and Incident Report.
//
// The split is the same as the weekly report's: this file talks to Supabase and
// knows nothing about how a figure is arrived at; `monthly-manpower.ts` is pure
// and knows nothing about the database. Everything derived here is recomputed
// from the rows on every load, so a field report approved late, or corrected in
// October for a day in September, silently fixes September's report.
//
// Two things are allowed to be absent and neither takes the page down:
//   - `monthly_manpower_reports` (0045). The report still derives and prints,
//     it just cannot be saved.
//   - `cm_daily_logs.ahc_man_hours` (also 0045). The hours total falls back to
//     subs only, and says so rather than printing a short number clean.
// Both are matched on the error CODE. "Any error means run the migration"
// sends Phil to the SQL editor to re-apply something already applied, and hides
// whatever actually broke.

import { createClient } from "@/lib/supabase/server";

import {
  buildSubmissions,
  deriveIncidentCandidates,
  deriveManHours,
  monthPeriod,
  readiness,
  resolveIncidents,
  type ExtraIncident,
  type FormSubmission,
  type HoursGap,
  type IncidentCandidate,
  type IncidentOverride,
  type ManHoursBreakdown,
  type MonthlyCmLog,
  type MonthlyDpr,
  type MonthlySub,
  type Period,
  type ResolvedIncident,
} from "./monthly-manpower";

type PgError = { code?: string } | null;

function isMissingTable(error: PgError): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || error?.code === "PGRST106";
}

function isMissingColumn(error: PgError): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}

export type MonthlyReportRow = {
  period_month: string;
  period_start: string | null;
  period_end: string | null;
  status: string | null;
  manhours_override: number | null;
  manhours_note: string | null;
  incidents: Record<string, IncidentOverride> | null;
  extra_incidents: ExtraIncident[] | null;
  note: string | null;
  submitted_at: string | null;
};

const REPORT_COLS =
  "period_month, period_start, period_end, status, manhours_override, manhours_note, incidents, extra_incidents, note, submitted_at";

/** A field report in the window that nobody approved, and so contributes nothing. */
export type ExcludedReport = { day: string; status: string; subcontractorId: string | null };

export type MonthlyView = {
  projectId: string;
  projectName: string;
  periodMonth: string;
  period: Period;
  status: "draft" | "submitted";
  saved: boolean;
  submittedAt: string | null;
  /** 0045's table is absent - derive and print, but do not offer Save. */
  storageMissing: boolean;
  /** 0045's cm_daily_logs columns are absent - AHC hours cannot be counted. */
  ahcColumnsAvailable: boolean;

  hours: {
    derived: ManHoursBreakdown;
    basis: string;
    gaps: HoursGap[];
    /** What goes on the form: the override when there is one, else derived total. */
    reported: number;
    overridden: boolean;
    note: string;
  };

  candidates: IncidentCandidate[];
  candidateBasis: string;
  incidents: ResolvedIncident[];
  /** The raw stored overrides, so the form can round-trip them unchanged. */
  overrides: Record<string, IncidentOverride>;
  extras: ExtraIncident[];
  note: string;

  submissions: FormSubmission[];
  ready: boolean;
  blockers: string[];

  /** Approved-only is the rule; this is what that rule excluded. */
  excluded: ExcludedReport[];
  /** Days in the period with a field report but no CM log, and the reverse. */
  cmLogDays: string[];
};

export async function loadMonthlyManpower(
  projectId: string,
  periodMonth: string,
): Promise<MonthlyView> {
  const supabase = createClient();

  const savedRes = await supabase
    .from("monthly_manpower_reports")
    .select(REPORT_COLS)
    .eq("project_id", projectId)
    .eq("period_month", periodMonth)
    .maybeSingle();

  const storageMissing = isMissingTable(savedRes.error);
  if (savedRes.error && !storageMissing) throw new Error(savedRes.error.message);
  const saved = (savedRes.data ?? null) as MonthlyReportRow | null;

  // The form asks for explicit start and finish dates, so a saved report keeps
  // whatever window it was actually filed for rather than being silently
  // re-scoped to the calendar month on the next load.
  const period: Period =
    saved?.period_start && saved?.period_end
      ? { start: saved.period_start, end: saved.period_end }
      : monthPeriod(periodMonth);

  // The CM log is read with 0045's columns first and without them on a missing
  // -column error, so the page works either side of the migration.
  const CM_BASE = "log_date, status, safety_notes, progress_summary";
  // `cols` is a plain string rather than a literal on purpose: the same query
  // is issued with and without 0045's columns, and a literal would make the two
  // results different types that cannot share a variable.
  const readLogs = (cols: string) =>
    supabase
      .from("cm_daily_logs")
      .select(cols)
      .eq("project_id", projectId)
      .gte("log_date", period.start)
      .lte("log_date", period.end)
      .order("log_date");

  let ahcColumnsAvailable = true;
  let logRes = await readLogs(`${CM_BASE}, ahc_headcount, ahc_man_hours`);
  if (isMissingColumn(logRes.error)) {
    ahcColumnsAvailable = false;
    logRes = await readLogs(CM_BASE);
  }
  if (logRes.error) throw new Error(logRes.error.message);

  const [projectRes, dprRes, subRes] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    // Every field report in the window, INCLUDING unapproved ones. They are
    // filtered below rather than in the query so the page can say "three
    // reports are excluded because nobody approved them" - a silently dropped
    // report is indistinguishable from a day nobody worked.
    supabase
      .from("dprs")
      .select(
        "id, report_date, status, subcontractor_id, crew_count, total_man_hours, safety_incident, near_miss, safety_narrative, work_narrative",
      )
      .eq("project_id", projectId)
      .gte("report_date", period.start)
      .lte("report_date", period.end)
      .order("report_date"),
    supabase
      .from("subcontractors")
      .select("id, company_name, trade")
      .eq("project_id", projectId),
  ]);
  if (dprRes.error) throw new Error(dprRes.error.message);

  const allDprs = (dprRes.data ?? []) as MonthlyDpr[];
  // Only approved field reports feed an owner's report - the same rule billing
  // and the weekly report already run on. A draft is unfinished and a returned
  // report was rejected on review; neither belongs in a document going out over
  // AHC's name.
  const dprs = allDprs.filter((d) => d.status === "approved");
  const excluded: ExcludedReport[] = allDprs
    .filter((d) => d.status !== "approved")
    .map((d) => ({
      day: d.report_date,
      status: d.status ?? "draft",
      subcontractorId: d.subcontractor_id,
    }));

  const logs = (logRes.data ?? []) as unknown as MonthlyCmLog[];
  const subs = (subRes.data ?? []) as MonthlySub[];

  const dprIds = dprs.map((d) => d.id);
  const manpowerRes = dprIds.length
    ? await supabase
        .from("dpr_manpower")
        .select("dpr_id, subcontractor_id, trade, headcount, regular_hours, ot_hours")
        .in("dpr_id", dprIds)
    : { data: [], error: null };
  if (manpowerRes.error) throw new Error(manpowerRes.error.message);

  const hoursDerived = deriveManHours(
    dprs,
    manpowerRes.data ?? [],
    logs,
    subs,
    ahcColumnsAvailable,
  );
  const candidateRes = deriveIncidentCandidates(dprs, logs, subs);

  const overrides = (saved?.incidents ?? {}) as Record<string, IncidentOverride>;
  const extras = (saved?.extra_incidents ?? []) as ExtraIncident[];
  const incidents = resolveIncidents(candidateRes.value, overrides, extras);

  const overridden = saved?.manhours_override != null;
  const reported = overridden ? Number(saved!.manhours_override) : hoursDerived.value.total;

  const submissions = buildSubmissions({
    projectName: projectRes.data?.name ?? "",
    period,
    hours: reported,
    hoursDerived: hoursDerived.value.total,
    hoursOverridden: overridden,
    hoursNote: saved?.manhours_note ?? "",
    gaps: hoursDerived.gaps,
    incidents,
  });
  const { ready, blockers } = readiness(submissions);

  return {
    projectId,
    projectName: projectRes.data?.name ?? "",
    periodMonth,
    period,
    status: saved?.status === "submitted" ? "submitted" : "draft",
    saved: Boolean(saved),
    submittedAt: saved?.submitted_at ?? null,
    storageMissing,
    ahcColumnsAvailable,
    hours: {
      derived: hoursDerived.value,
      basis: hoursDerived.basis,
      gaps: hoursDerived.gaps,
      reported,
      overridden,
      note: saved?.manhours_note ?? "",
    },
    candidates: candidateRes.value,
    candidateBasis: candidateRes.basis,
    incidents,
    overrides,
    extras,
    note: saved?.note ?? "",
    submissions,
    ready,
    blockers,
    excluded,
    cmLogDays: logs.map((l) => l.log_date),
  };
}
