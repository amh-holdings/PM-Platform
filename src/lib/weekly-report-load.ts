// Server-side assembly of the weekly progress report.
//
// One query set, one derived object, used by three surfaces: the edit form,
// the print sheet and the issue action. They MUST agree - a print sheet that
// re-derives differently from the form is a report that changes between the
// screen you approved and the PDF you sent.
//
// Everything that decides anything lives in `weekly-report.ts` and is pure.
// This module only fetches and hands over.

import { createClient } from "@/lib/supabase/server";
import { computeCpm } from "@/lib/schedule-cpm";
import { makeCalendar, type CalendarException } from "@/lib/schedule-calendar";
import { buildLookahead, type LookaheadWeek } from "@/lib/schedule-lookahead";
import {
  addDays,
  defaultPeriod,
  deriveContractors,
  deriveEnvironment,
  deriveEquipment,
  deriveMilestones,
  deriveRisks,
  deriveSecurity,
  deriveSwppp,
  deriveWeather,
  deriveWorkThisWeek,
  isSwppp,
  type ContractorRow,
  type Derived,
  type EquipmentRow,
  type MilestoneKey,
  type WeeklyOverrides,
} from "@/lib/weekly-report";

export type WeeklyReportRow = {
  id: string;
  week_ending: string;
  period_start: string;
  period_end: string;
  status: "draft" | "issued";
  issued_at: string | null;
} & WeeklyOverrides;

export type WeeklyReportView = {
  projectId: string;
  projectName: string;
  client: string | null;
  weekEnding: string;
  period: { start: string; end: string };
  status: "draft" | "issued";
  issuedAt: string | null;
  saved: WeeklyReportRow | null;
  /** True when migration 0041 has not been applied yet. */
  storageMissing: boolean;

  header: {
    dimensionCm: string;
    epcReportingManager: string;
    epcTeam: string;
    /** Where the header values came from, so a carried-forward name is visible. */
    carriedFrom: string | null;
  };

  contractors: ContractorRow[];
  equipment: EquipmentRow[];

  environment: Derived<string>;
  security: Derived<string>;
  weather: Derived<string>;
  swppp: Derived<string | null>;
  workThisWeek: Derived<string>;
  risks: Derived<string>;
  milestones: Record<MilestoneKey, Derived<string | null>>;
  lookahead: LookaheadWeek[];
  lookaheadNote: string | null;

  /** Raw evidence, kept beside the edit boxes so a rewrite never has to hunt. */
  evidence: {
    day: string;
    who: string;
    narrative: string | null;
    crew: number | null;
    weather: string | null;
    status: string | null;
  }[];

  /** Days in the period with no field report and no CM log at all. */
  gaps: string[];
};

const EMPTY_OVERRIDES: WeeklyOverrides = {
  dimension_cm: null,
  epc_reporting_manager: null,
  epc_team: null,
  environment_concerns: null,
  security_concerns: null,
  weather_summary: null,
  work_this_week: null,
  lookahead_note: null,
  schedule_risks: null,
  swppp_inspection_date: null,
  milestones: {},
  contractor_overrides: {},
  extra_contractors: [],
  equipment_overrides: {},
  extra_equipment: [],
};

/** Postgres `undefined_table`, and the PostgREST schema-cache miss it surfaces as. */
function isMissingTable(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || error?.code === "PGRST106";
}

const REPORT_COLS =
  "id, week_ending, period_start, period_end, status, issued_at, dimension_cm, epc_reporting_manager, epc_team, environment_concerns, security_concerns, weather_summary, work_this_week, lookahead_note, schedule_risks, swppp_inspection_date, milestones, contractor_overrides, extra_contractors, equipment_overrides, extra_equipment";

export async function loadWeeklyReport(
  projectId: string,
  weekEnding: string,
): Promise<WeeklyReportView> {
  const supabase = createClient();

  // The saved row for this week, and the one before it. The previous week is
  // not decoration: it carries the header names and the agreed milestone dates
  // forward, which is what makes week two onward a five-minute job.
  const savedRes = await supabase
    .from("weekly_progress_reports")
    .select(REPORT_COLS)
    .eq("project_id", projectId)
    .eq("week_ending", weekEnding)
    .maybeSingle();

  // 0041 not applied yet: the page still renders the derived report, it just
  // cannot save. Better than a 500 on a page whose whole value is the derivation.
  //
  // Matched on the error CODE, not on "any error". A transient failure reported
  // as "run the migration" sends Phil to the SQL editor to re-apply something
  // that is already there, and hides the real fault.
  const storageMissing = isMissingTable(savedRes.error);
  if (savedRes.error && !storageMissing) throw new Error(savedRes.error.message);

  const prevRes = storageMissing
    ? { data: null }
    : await supabase
        .from("weekly_progress_reports")
        .select(REPORT_COLS)
        .eq("project_id", projectId)
        .lt("week_ending", weekEnding)
        .order("week_ending", { ascending: false })
        .limit(1);

  const saved = (savedRes.data ?? null) as WeeklyReportRow | null;
  const prev = (prevRes.data?.[0] ?? null) as WeeklyReportRow | null;

  const o: WeeklyOverrides = { ...EMPTY_OVERRIDES, ...(saved ?? {}) };
  // jsonb columns come back null on rows written before a default landed.
  o.milestones ??= {};
  o.contractor_overrides ??= {};
  o.extra_contractors ??= [];
  o.equipment_overrides ??= {};
  o.extra_equipment ??= [];

  const period =
    saved?.period_start && saved?.period_end
      ? { start: saved.period_start, end: saved.period_end }
      : defaultPeriod(weekEnding);

  const [
    projectRes,
    dprRes,
    logRes,
    subRes,
    onsiteRes,
    constraintRes,
    inspectionRes,
    productionRes,
    commodityRes,
    calendarRes,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("name, client, work_week, schedule_data_date")
      .eq("id", projectId)
      .maybeSingle(),
    supabase
      .from("dprs")
      .select(
        "id, report_date, status, subcontractor_id, work_narrative, crew_count, total_man_hours, weather_conditions, temp_high, temp_low, safety_incident, near_miss, safety_narrative",
      )
      .eq("project_id", projectId)
      .gte("report_date", period.start)
      .lte("report_date", period.end)
      .order("report_date"),
    supabase
      .from("cm_daily_logs")
      .select(
        "log_date, progress_summary, site_conditions, safety_notes, weather_conditions, temp_high, temp_low",
      )
      .eq("project_id", projectId)
      .gte("log_date", period.start)
      .lte("log_date", period.end)
      .order("log_date"),
    supabase
      .from("subcontractors")
      .select("id, company_name, trade, active")
      .eq("project_id", projectId)
      .eq("active", true),
    // Last date onsite is an all-time fact, so this query is deliberately not
    // bounded by the period. Only the columns needed for a max().
    supabase
      .from("dprs")
      .select("subcontractor_id, report_date")
      .eq("project_id", projectId)
      .lte("report_date", period.end)
      .not("subcontractor_id", "is", null),
    supabase
      .from("schedule_constraints")
      .select("id, title, category, owner, need_by, status, wbs_code")
      .eq("project_id", projectId)
      .in("status", ["open", "in_progress"]),
    supabase
      .from("inspections")
      .select("inspection_type, title, inspector_name, status, submitted_at, decided_at, created_at")
      .eq("project_id", projectId),
    supabase
      .from("daily_production")
      .select("production_date, commodity_id, quantity, confirmed_at")
      .eq("project_id", projectId)
      .gte("production_date", period.start)
      .lte("production_date", period.end),
    supabase
      .from("commodities")
      .select("id, label, uom")
      .eq("project_id", projectId)
      .eq("active", true),
    supabase
      .from("project_calendar_exceptions")
      .select("exception_date, kind")
      .eq("project_id", projectId),
  ]);

  const dprs = dprRes.data ?? [];
  const logs = logRes.data ?? [];
  const subs = subRes.data ?? [];
  const dprIds = dprs.map((d) => d.id);

  // Child rows of the period's field reports. Skipped entirely when the period
  // has no reports, so an empty week costs three fewer round trips.
  const [manpowerRes, equipmentRes, delayRes] = dprIds.length
    ? await Promise.all([
        supabase
          .from("dpr_manpower")
          .select("dpr_id, subcontractor_id, trade, headcount, regular_hours, ot_hours")
          .in("dpr_id", dprIds),
        supabase
          .from("dpr_equipment")
          .select("dpr_id, equipment_name, quantity, active, rental_company")
          .in("dpr_id", dprIds),
        supabase
          .from("dpr_delays")
          .select("dpr_id, cause_code, hours_lost, narrative")
          .in("dpr_id", dprIds),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  // The schedule feeds three boxes (milestones, look-ahead, at-risk tasks) and
  // its Phase 1 columns are hand-applied, so a missing column degrades those
  // three rather than taking the page down. Same probe the schedule page uses.
  const BASE = "wbs_code, task_name, assigned_to, status, pct_complete, start_date, end_date, duration_days, predecessors, level_code, sort_order";
  let tasks: Record<string, unknown>[] = [];
  let scheduleFlagsAvailable = true;
  const withFlags = await supabase
    .from("schedule_tasks")
    .select(`${BASE}, is_milestone, is_at_risk, date_constraint_type, date_constraint_date`)
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true, nullsFirst: false });
  if (!withFlags.error) {
    tasks = (withFlags.data ?? []) as never;
  } else {
    scheduleFlagsAvailable = false;
    const base = await supabase
      .from("schedule_tasks")
      .select(BASE)
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true, nullsFirst: false });
    tasks = (base.data ?? []) as never;
  }
  void scheduleFlagsAvailable;

  const project = projectRes.data;
  const workWeek = (project?.work_week ?? 5) === 6 ? 6 : 5;
  const calendar = makeCalendar(
    workWeek,
    (calendarRes.data ?? []) as CalendarException[],
  );

  // The look-ahead starts the Monday AFTER the reported week, because the box
  // is asking what is coming next, not what just happened.
  const lookaheadFrom = addDays(period.end, 1);
  const cpm = computeCpm(tasks as never, {
    calendar,
    dataDate: project?.schedule_data_date ?? lookaheadFrom,
  });
  const lookahead = buildLookahead(tasks as never, cpm, {
    weeks: 3,
    calendar,
    dataDate: lookaheadFrom,
  });

  const typedTasks = tasks as never as Parameters<typeof deriveMilestones>[0];

  const swpppInspections = (inspectionRes.data ?? []).filter(isSwppp);

  const evidence = [
    ...dprs.map((d) => ({
      day: d.report_date,
      who:
        subs.find((s) => s.id === d.subcontractor_id)?.company_name ?? "Field report",
      narrative: d.work_narrative,
      crew: d.crew_count,
      weather: d.weather_conditions,
      status: d.status,
    })),
    ...logs.map((l) => ({
      day: l.log_date,
      who: "CM log",
      narrative: l.progress_summary,
      crew: null,
      weather: l.weather_conditions,
      status: null,
    })),
  ].sort((a, b) => (a.day === b.day ? a.who.localeCompare(b.who) : a.day < b.day ? -1 : 1));

  const covered = new Set(evidence.map((e) => e.day));
  const gaps: string[] = [];
  for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
    if (!covered.has(d)) gaps.push(d);
  }

  const carriedFrom = prev
    ? prev.week_ending
    : null;

  return {
    projectId,
    projectName: project?.name ?? "Project",
    client: project?.client ?? null,
    weekEnding,
    period,
    status: saved?.status ?? "draft",
    issuedAt: saved?.issued_at ?? null,
    saved,
    storageMissing,

    header: {
      dimensionCm: o.dimension_cm ?? prev?.dimension_cm ?? "",
      epcReportingManager: o.epc_reporting_manager ?? prev?.epc_reporting_manager ?? "",
      epcTeam: o.epc_team ?? prev?.epc_team ?? "",
      carriedFrom: !saved && prev ? carriedFrom : null,
    },

    contractors: deriveContractors(
      subs as never,
      dprs as never,
      (manpowerRes.data ?? []) as never,
      (onsiteRes.data ?? []) as never,
      typedTasks,
      o.contractor_overrides,
      o.extra_contractors,
    ),
    equipment: deriveEquipment(
      dprs as never,
      (equipmentRes.data ?? []) as never,
      o.equipment_overrides,
      o.extra_equipment,
    ),

    environment: deriveEnvironment(logs as never, dprs as never, (delayRes.data ?? []) as never),
    security: deriveSecurity(dprs as never, logs as never),
    weather: deriveWeather(dprs as never, logs as never),
    swppp: deriveSwppp(swpppInspections as never, period.end),
    workThisWeek: deriveWorkThisWeek(
      dprs as never,
      logs as never,
      subs as never,
      (productionRes.data ?? []) as never,
      (commodityRes.data ?? []) as never,
    ),
    risks: deriveRisks(
      (constraintRes.data ?? []) as never,
      typedTasks,
      (delayRes.data ?? []) as never,
      dprs as never,
      period.end,
    ),
    milestones: deriveMilestones(typedTasks, prev?.milestones ?? {}, o.milestones),
    lookahead,
    lookaheadNote: o.lookahead_note,

    evidence,
    gaps,
  };
}

/** Apply the human's overrides on top of the derived values, for output. */
export function resolveWeekly(view: WeeklyReportView) {
  const o = view.saved;
  const pick = (override: string | null | undefined, derived: string) =>
    override != null && override.trim() !== "" ? override : derived;
  return {
    environment: pick(o?.environment_concerns, view.environment.value),
    security: pick(o?.security_concerns, view.security.value),
    weather: pick(o?.weather_summary, view.weather.value),
    workThisWeek: pick(o?.work_this_week, view.workThisWeek.value),
    risks: pick(o?.schedule_risks, view.risks.value),
    lookaheadNote: o?.lookahead_note ?? null,
    swppp: o?.swppp_inspection_date ?? view.swppp.value,
  };
}
