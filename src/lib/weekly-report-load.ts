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
  MILESTONE_FIELDS,
  addDays,
  coverageGaps,
  defaultPeriod,
  deriveContractors,
  deriveEnvironment,
  deriveEquipment,
  deriveManHours,
  deriveMilestones,
  deriveProjectPosition,
  deriveRisks,
  deriveSafety,
  deriveSecurity,
  deriveSwppp,
  deriveWeather,
  deriveWorkThisWeek,
  isSwppp,
  positionSentence,
  selectPhotoKeys,
  type ContractorRow,
  type Derived,
  type EquipmentRow,
  type ManHours,
  type MilestoneKey,
  type PhotoCandidate,
  type ProjectPosition,
  type WeeklyOverrides,
} from "@/lib/weekly-report";

export type WeeklyReportRow = {
  id: string;
  week_ending: string;
  period_start: string;
  period_end: string;
  status: "draft" | "issued";
  issued_at: string | null;
  issued_payload: WeeklyIssuedPayload | null;
} & WeeklyOverrides;

/** The frozen copy written at issue. See `weeklySheet`. */
export type WeeklyIssuedPayload = {
  header?: WeeklyReportView["header"];
  contractors?: ContractorRow[];
  equipment?: EquipmentRow[];
  milestones?: Record<string, string | null>;
  lookahead?: LookaheadWeek[];
  environment?: string;
  security?: string;
  safety?: string;
  weather?: string;
  workThisWeek?: string;
  risks?: string;
  position?: string;
  manHours?: ManHours;
  lookaheadNote?: string | null;
  photoNote?: string | null;
  swppp?: string | null;
};

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

  /**
   * The same derivation with NO overrides applied. This is the baseline the
   * save action diffs against - diffing against the resolved values above
   * makes every unchanged override equal itself and get dropped, which erased
   * the human's corrections on the second Save.
   */
  base: {
    contractors: ContractorRow[];
    equipment: EquipmentRow[];
    milestones: Record<MilestoneKey, Derived<string | null>>;
  };

  environment: Derived<string>;
  security: Derived<string>;
  safety: Derived<string>;
  manHours: Derived<ManHours>;
  position: Derived<ProjectPosition>;
  /** The derived Project Position box as the prose that prints. */
  positionText: string;
  /** The photos that will print, in date order. */
  photos: WeeklyPhoto[];
  /** Every photo available for the period, for the picker. */
  photoCandidates: WeeklyPhoto[];
  /** Keys currently chosen. Empty means the automatic spread is in use. */
  photoSelection: string[];
  /** True when nobody has chosen, so the automatic spread is being used. */
  photoAuto: boolean;
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

  /** Worked days in the period with no field report and no CM log at all. */
  gaps: string[];
  /**
   * Field reports in the period that are not approved, and so feed nothing.
   * Surfaced because a silently-excluded report reads as a missing day.
   */
  unapproved: { day: string; who: string; status: string }[];
  /** False when the schedule's Phase 1 flag columns are not applied yet. */
  scheduleFlagsAvailable: boolean;
  /** False when migration 0042 is not applied, so the new boxes cannot save. */
  extraOverridesAvailable: boolean;
  /** False when migration 0043 is not applied, so a photo choice cannot save. */
  photoSelectionAvailable: boolean;
};

export type WeeklyPhoto = PhotoCandidate & {
  /** Signed URL. Short-lived, so it is generated per render, never stored. */
  url: string | null;
};

const EMPTY_OVERRIDES: WeeklyOverrides = {
  dimension_cm: null,
  epc_reporting_manager: null,
  epc_team: null,
  environment_concerns: null,
  security_concerns: null,
  safety_summary: null,
  photo_note: null,
  position_note: null,
  photo_keys: [],
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

const BASE_REPORT_COLS =
  "id, week_ending, period_start, period_end, status, issued_at, issued_payload, dimension_cm, epc_reporting_manager, epc_team, environment_concerns, security_concerns, weather_summary, work_this_week, lookahead_note, schedule_risks, swppp_inspection_date, milestones, contractor_overrides, extra_contractors, equipment_overrides, extra_equipment";

/** The columns 0042 adds. Selected separately so a missing 0042 degrades the
 *  three new boxes to read-only instead of taking the whole page down. */
const EXTRA_REPORT_COLS = "safety_summary, photo_note, position_note";
/** The column 0043 adds. Its own tier, because 0042 and 0043 were applied
 *  separately in the real database and lumping them together meant a missing
 *  0043 took 0042's three boxes down with it - Safety, Project position and the
 *  photo note silently stopped saving, under a banner blaming a migration that
 *  had in fact been applied. Each migration degrades only its own feature. */
const PHOTO_SELECTION_COLS = "photo_keys";
const REPORT_COLS = `${BASE_REPORT_COLS}, ${EXTRA_REPORT_COLS}, ${PHOTO_SELECTION_COLS}`;
const REPORT_COLS_NO_PHOTO_KEYS = `${BASE_REPORT_COLS}, ${EXTRA_REPORT_COLS}`;

/** Postgres `undefined_column`, and the PostgREST parse error it surfaces as. */
function isMissingColumn(error: { code?: string } | null): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}

export async function loadWeeklyReport(
  projectId: string,
  weekEnding: string,
): Promise<WeeklyReportView> {
  const supabase = createClient();

  // The saved row for this week, and the one before it. The previous week is
  // not decoration: it carries the header names and the agreed milestone dates
  // forward, which is what makes week two onward a five-minute job.
  // Three tiers, narrowest last: everything, then without 0043's photo_keys,
  // then the 0041 base. Each step down disables one feature rather than the
  // page.
  let extraOverridesAvailable = true;
  let photoSelectionAvailable = true;
  const readSaved = (cols: string) =>
    supabase
      .from("weekly_progress_reports")
      .select(cols)
      .eq("project_id", projectId)
      .eq("week_ending", weekEnding)
      .maybeSingle();

  let savedRes = await readSaved(REPORT_COLS);
  if (isMissingColumn(savedRes.error)) {
    photoSelectionAvailable = false;
    savedRes = await readSaved(REPORT_COLS_NO_PHOTO_KEYS);
  }
  if (isMissingColumn(savedRes.error)) {
    extraOverridesAvailable = false;
    savedRes = await readSaved(BASE_REPORT_COLS);
  }

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
        .select(extraOverridesAvailable ? REPORT_COLS : BASE_REPORT_COLS)
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
    allHoursRes,
    allProductionRes,
    calendarRes,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("name, client, work_week, schedule_data_date")
      .eq("id", projectId)
      .maybeSingle(),
    // Every field report in the window, INCLUDING the unapproved ones - they
    // are filtered below rather than in the query, because the page has to be
    // able to say "three reports are excluded because nobody approved them".
    // A silently dropped report is indistinguishable from a day nobody worked.
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
    // Deliberately NOT filtered to active. `deriveContractors` drops any sub
    // with no site history, so the inactive ones cost nothing - and filtering
    // here dropped a sub the week they demobbed, which is exactly the week
    // their last-date-onsite is the answer Dimension is asking for.
    supabase
      .from("subcontractors")
      .select("id, company_name, trade, active")
      .eq("project_id", projectId),
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
      .select("id, label, uom, total_quantity, total_verified")
      .eq("project_id", projectId)
      .eq("active", true),
    // All-time, for cumulative man-hours and quantities-to-date. Both are
    // recomputed from the rows every load rather than kept in a running total,
    // so a field report corrected three weeks ago fixes the cumulative figure.
    supabase
      .from("dprs")
      .select("report_date, total_man_hours, crew_count")
      .eq("project_id", projectId)
      .eq("status", "approved")
      .lte("report_date", period.end),
    supabase
      .from("daily_production")
      .select("production_date, commodity_id, quantity, confirmed_at")
      .eq("project_id", projectId)
      .lte("production_date", period.end),
    supabase
      .from("project_calendar_exceptions")
      .select("exception_date, kind")
      .eq("project_id", projectId),
  ]);

  const allDprs = dprRes.data ?? [];
  // Only approved field reports feed the owner's report. The same table is
  // already read this way for commodity production and for billing: a draft is
  // unfinished and a `returned` report was rejected on review, and neither has
  // any business appearing in a document going to Dimension over AHC's name.
  const dprs = allDprs.filter((d) => d.status === "approved");
  const unapproved = allDprs
    .filter((d) => d.status !== "approved")
    .map((d) => ({ day: d.report_date, status: d.status ?? "draft", subcontractor_id: d.subcontractor_id }));
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
    // The flag columns are hand-applied, so their absence degrades milestones
    // and at-risk tasks rather than taking the page down. It is surfaced on the
    // view so the form can SAY the milestone box is degraded - it used to be
    // computed and thrown away, so those boxes just quietly went empty.
    scheduleFlagsAvailable = false;
    const base = await supabase
      .from("schedule_tasks")
      .select(BASE)
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true, nullsFirst: false });
    tasks = (base.data ?? []) as never;
  }
  // Dimension's form asks for photos in its own footer, and the platform has
  // been holding them the whole time - just not where this first looked.
  //
  // The original version read `public.photos`, the table 0014 created for an
  // in-DPR uploader. It has never held a row on ANY project, so the report said
  // "no photos" every week while the site was being photographed daily. The
  // photos that exist belong to the two features people actually use:
  // inspection photos (bucket `inspection-photos`) and CM daily log photos
  // (bucket `dpr-photos`). One Sweet Springs week holds 64 of them. `photos` is
  // still read, so an in-DPR upload would show up if that uploader is ever used.
  //
  // The buckets are private, so a row is useless without a signed URL -
  // generated per render and never stored, because they expire.
  const periodInspections = (inspectionRes.data ?? []).filter((i) => {
    const r = i as { decided_at: string | null; submitted_at: string | null; created_at: string | null };
    const when = (r.decided_at ?? r.submitted_at ?? r.created_at ?? "").slice(0, 10);
    return when >= period.start && when <= period.end;
  }) as { id?: string; title?: string | null; decided_at: string | null; submitted_at: string | null; created_at: string | null }[];

  const inspectionIds = periodInspections.map((i) => i.id).filter(Boolean) as string[];
  // The activity a photo evidences is the WBS code its inspection is titled
  // with - "5.1.1.6 Construct Basin 1 ESC" is activity 5.1.1.6. That is what
  // groups the same activity inspected twice in a week into one photo. An
  // inspection with no code in its title falls back to the title itself, which
  // still groups repeats of the same inspection.
  const wbsOf = (title: string): string => {
    const m = /^\s*(\d+(?:\.\d+)*)/.exec(title);
    return m ? m[1] : title.trim().toLowerCase();
  };
  const inspectionMeta = new Map(
    periodInspections
      .filter((i) => i.id)
      .map((i) => [
        i.id!,
        {
          title: i.title ?? "Inspection",
          taskKey: wbsOf(i.title ?? "Inspection"),
          day: (i.decided_at ?? i.submitted_at ?? i.created_at ?? "").slice(0, 10),
        },
      ]),
  );
  const logMeta = new Map(
    (logRes.data ?? []).map((l) => [
      (l as { id?: string }).id ?? "",
      (l as { log_date: string }).log_date,
    ]),
  );
  const logIds = Array.from(logMeta.keys()).filter(Boolean);

  const [inspPhotoRes, cmPhotoRes, dprPhotoRes] = await Promise.all([
    inspectionIds.length
      ? supabase
          .from("inspection_photos")
          .select("id, inspection_id, side, caption, storage_path, taken_at, created_at")
          .in("inspection_id", inspectionIds)
      : Promise.resolve({ data: [] }),
    logIds.length
      ? supabase
          .from("cm_daily_log_photos")
          .select("id, cm_daily_log_id, caption, storage_path, created_at")
          .in("cm_daily_log_id", logIds)
      : Promise.resolve({ data: [] }),
    dprIds.length
      ? supabase
          .from("photos")
          .select("id, dpr_id, caption, storage_path, taken_at, created_at")
          .in("dpr_id", dprIds)
      : Promise.resolve({ data: [] }),
  ]);

  type Pending = PhotoCandidate & { bucket: string; path: string };
  const pending: Pending[] = [];

  for (const ph of (inspPhotoRes.data ?? []) as {
    id: string; inspection_id: string; side: string; caption: string | null;
    storage_path: string; taken_at: string | null; created_at: string | null;
  }[]) {
    const meta = inspectionMeta.get(ph.inspection_id);
    pending.push({
      key: `insp:${ph.id}`,
      day: (ph.taken_at ?? ph.created_at ?? "").slice(0, 10) || meta?.day || period.end,
      // The side matters to the reader: an AHC photo is our own verification,
      // a sub photo is what they submitted for it.
      who: `${meta?.title ?? "Inspection"} (${ph.side === "ahc" ? "AHC" : "sub"})`,
      caption: ph.caption,
      source: "inspection",
      taskKey: meta?.taskKey ?? null,
      side: ph.side === "ahc" ? "ahc" : "sub",
      bucket: "inspection-photos",
      path: ph.storage_path,
    });
  }

  for (const ph of (cmPhotoRes.data ?? []) as {
    id: string; cm_daily_log_id: string; caption: string | null;
    storage_path: string; created_at: string | null;
  }[]) {
    pending.push({
      key: `cmlog:${ph.id}`,
      day: logMeta.get(ph.cm_daily_log_id) ?? (ph.created_at ?? "").slice(0, 10) ?? period.end,
      who: "CM daily log",
      caption: ph.caption,
      source: "cmlog",
      taskKey: null,
      side: null,
      bucket: "dpr-photos",
      path: ph.storage_path,
    });
  }

  for (const ph of (dprPhotoRes.data ?? []) as {
    id: string; dpr_id: string | null; caption: string | null;
    storage_path: string; taken_at: string | null; created_at: string | null;
  }[]) {
    const dpr = dprs.find((d) => d.id === ph.dpr_id);
    pending.push({
      key: `dpr:${ph.id}`,
      day: (ph.taken_at ?? ph.created_at ?? "").slice(0, 10) || dpr?.report_date || period.end,
      who: subs.find((sb) => sb.id === dpr?.subcontractor_id)?.company_name ?? "Field report",
      caption: ph.caption,
      source: "dpr",
      taskKey: null,
      side: null,
      bucket: "dpr-photos",
      path: ph.storage_path,
    });
  }

  // One signing call per bucket, not per photo.
  const signedByKey = new Map<string, string | null>();
  await Promise.all(
    Array.from(new Set(pending.map((x) => x.bucket))).map(async (bucket) => {
      const rows = pending.filter((x) => x.bucket === bucket);
      const signed = await supabase.storage
        .from(bucket)
        .createSignedUrls(rows.map((r) => r.path), 60 * 60);
      const byPath = new Map((signed.data ?? []).map((r) => [r.path ?? "", r.signedUrl ?? null]));
      for (const r of rows) signedByKey.set(r.key, byPath.get(r.path) ?? null);
    }),
  );

  const photoCandidates: WeeklyPhoto[] = pending
    // Only photos taken INSIDE the reported week. An inspection approved on the
    // 19th can carry a photo the sub took on the 4th, and printing that on a
    // weekly progress report claims a fortnight-old pile as this week's work.
    // The inspection date is the fallback when a photo has no timestamp of its
    // own, so this filters on what the photo actually depicts.
    .filter((x) => x.day >= period.start && x.day <= period.end)
    .map((x) => ({
      key: x.key,
      day: x.day,
      who: x.who,
      caption: x.caption,
      source: x.source,
      taskKey: x.taskKey ?? null,
      side: x.side ?? null,
      url: signedByKey.get(x.key) ?? null,
    }))
    .sort((a, b) => (a.day === b.day ? a.key.localeCompare(b.key) : a.day < b.day ? -1 : 1));

  const photoSelection = ((o.photo_keys ?? []) as unknown[]).filter(
    (k): k is string => typeof k === "string",
  );
  const byPhotoKey = new Map(photoCandidates.map((c) => [c.key, c]));
  const photos = selectPhotoKeys(photoCandidates, photoSelection)
    .map((k) => byPhotoKey.get(k))
    .filter((c): c is WeeklyPhoto => Boolean(c));
  const photoAuto = photoSelection.length === 0;

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

  // Evidence is for the person WRITING the report, so it deliberately includes
  // the unapproved reports the derivations refuse to read. They are tagged with
  // their status in the panel: seeing that Thursday is sitting in `submitted` is
  // how you know to go and approve it rather than write around a blank day.
  const evidence = [
    ...allDprs.map((d) => ({
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

  // A day with an unapproved report is covered for the purpose of the gap
  // warning - somebody was there and filed. It gets its own warning instead.
  const covered = new Set(evidence.map((e) => e.day));
  const nonWorkDays = new Set(
    (calendarRes.data ?? [])
      .filter((c) => (c as { kind?: string }).kind !== "workday")
      .map((c) => (c as { exception_date: string }).exception_date),
  );
  const gaps = coverageGaps(period.start, period.end, covered, workWeek, nonWorkDays);

  const manHours = deriveManHours(
    dprs as never,
    (allHoursRes.data ?? []) as never,
    (manpowerRes.data ?? []) as never,
    period.end,
  );

  const position = deriveProjectPosition(
    typedTasks,
    cpm,
    (commodityRes.data ?? []) as never,
    (allProductionRes.data ?? []) as never,
  );

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

    base: {
      // The same three derivations with the overrides left out, which is the
      // only honest baseline to diff an edited form against.
      contractors: deriveContractors(
        subs as never,
        dprs as never,
        (manpowerRes.data ?? []) as never,
        (onsiteRes.data ?? []) as never,
        typedTasks,
        {},
        [],
      ),
      equipment: deriveEquipment(dprs as never, (equipmentRes.data ?? []) as never, {}, []),
      milestones: deriveMilestones(typedTasks, prev?.milestones ?? {}, {}),
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

    environment: deriveEnvironment(
      logs as never,
      dprs as never,
      (delayRes.data ?? []) as never,
      (inspectionRes.data ?? []) as never,
      period,
    ),
    security: deriveSecurity(dprs as never, logs as never),
    safety: deriveSafety(dprs as never, logs as never, manHours.value),
    manHours,
    position,
    positionText: positionSentence(position.value),
    photos,
    photoCandidates,
    photoSelection,
    photoAuto,
    weather: deriveWeather(dprs as never, logs as never, (delayRes.data ?? []) as never),
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
    unapproved: unapproved.map((u) => ({
      day: u.day,
      who: subs.find((s) => s.id === u.subcontractor_id)?.company_name ?? "Field report",
      status: u.status,
    })),
    scheduleFlagsAvailable,
    extraOverridesAvailable,
    photoSelectionAvailable,
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
    safety: pick(o?.safety_summary, view.safety.value),
    position: pick(o?.position_note, view.positionText),
    lookaheadNote: o?.lookahead_note ?? null,
    photoNote: o?.photo_note ?? null,
    swppp: o?.swppp_inspection_date ?? view.swppp.value,
  };
}

/**
 * The report as a reader sees it, from the one source that is correct for its
 * status.
 *
 * A DRAFT is derived live, which is the whole point of the feature: a field
 * report that lands on Tuesday improves last week's numbers instead of leaving
 * a stale figure frozen in a saved copy.
 *
 * An ISSUED report is read back out of `issued_payload`. That column was being
 * written at issue and then never read by anything - so the print sheet, which
 * is the artefact that actually gets sent, went on re-deriving live. Correct a
 * field report after issue and "the report we sent Dimension on the 24th"
 * quietly became a different document. Reproducing what was sent is the one
 * job a snapshot is right for, and now it does it.
 */
export function weeklySheet(view: WeeklyReportView) {
  const frozen = view.status === "issued" ? view.saved?.issued_payload : null;
  const live = resolveWeekly(view);

  if (!frozen) {
    return {
      source: "live" as const,
      header: view.header,
      contractors: view.contractors,
      equipment: view.equipment,
      milestones: Object.fromEntries(
        MILESTONE_FIELDS.map((f) => [f.key, view.milestones[f.key]?.value ?? null]),
      ) as Record<string, string | null>,
      lookahead: view.lookahead,
      manHours: view.manHours.value,
      ...live,
    };
  }

  return {
    source: "issued" as const,
    header: frozen.header ?? view.header,
    contractors: frozen.contractors ?? view.contractors,
    equipment: frozen.equipment ?? view.equipment,
    milestones:
      frozen.milestones ??
      (Object.fromEntries(
        MILESTONE_FIELDS.map((f) => [f.key, view.milestones[f.key]?.value ?? null]),
      ) as Record<string, string | null>),
    lookahead: frozen.lookahead ?? view.lookahead,
    environment: frozen.environment ?? live.environment,
    security: frozen.security ?? live.security,
    safety: frozen.safety ?? live.safety,
    weather: frozen.weather ?? live.weather,
    workThisWeek: frozen.workThisWeek ?? live.workThisWeek,
    risks: frozen.risks ?? live.risks,
    position: frozen.position ?? live.position,
    manHours: frozen.manHours ?? view.manHours.value,
    lookaheadNote: frozen.lookaheadNote ?? live.lookaheadNote,
    photoNote: frozen.photoNote ?? live.photoNote,
    swppp: frozen.swppp ?? live.swppp,
  };
}

/**
 * Whether the live derivation has moved since the report was issued. Shown on
 * the editor so "a corrected field report landed after we sent this" is a thing
 * you find out on the screen rather than in a phone call with the owner.
 */
export function issuedDrift(view: WeeklyReportView): string[] {
  const frozen = view.status === "issued" ? view.saved?.issued_payload : null;
  if (!frozen) return [];
  const live = resolveWeekly(view);
  const drift: string[] = [];
  const cmp = (label: string, was: string | null | undefined, now: string) => {
    if ((was ?? "").trim() !== now.trim()) drift.push(label);
  };
  cmp("Environment concerns", frozen.environment, live.environment);
  cmp("Security concerns", frozen.security, live.security);
  cmp("Weather", frozen.weather, live.weather);
  cmp("Work this week", frozen.workThisWeek, live.workThisWeek);
  cmp("Open schedule risks", frozen.risks, live.risks);
  cmp("Safety", frozen.safety, live.safety);
  cmp("Project position", frozen.position, live.position);
  if ((frozen.contractors ?? []).length !== view.contractors.length) drift.push("Contractors");
  if ((frozen.equipment ?? []).length !== view.equipment.length) drift.push("Equipment");
  return drift;
}

/**
 * Which boxes a human typed, and which the platform derived off the field
 * record.
 *
 * The distinction already exists in the data - `saved` holds ONLY overrides, so
 * a non-empty column there is by definition something a person wrote - it was
 * just never surfaced on the sheet. Reviewing the report before it goes out,
 * the first question is always "which of this did we write and which did the
 * platform work out", and the honest answer is one lookup away.
 *
 * A row is manual when its override is set, not when it merely differs from the
 * derivation: `Reset to derived` clears the override, and a box that has been
 * reset is back to being the platform's.
 *
 * Deliberately reads the overrides even for an issued report. The frozen
 * payload records the values that were sent, not who wrote them, so the
 * overrides remain the only record of authorship.
 */
export type WeeklyProvenance = {
  dimensionCm: boolean;
  epcReportingManager: boolean;
  epcTeam: boolean;
  environment: boolean;
  security: boolean;
  safety: boolean;
  weather: boolean;
  position: boolean;
  workThisWeek: boolean;
  risks: boolean;
  swppp: boolean;
  lookaheadNote: boolean;
  photoNote: boolean;
  milestones: Record<string, boolean>;
  /** Contractor key -> the cells a person typed, from `ContractorRow.overridden`. */
  contractors: Record<string, string[]>;
  equipment: Record<string, string[]>;
  /** How many boxes in total, for the legend on the sheet. */
  manualCount: number;
};

export function weeklyProvenance(view: WeeklyReportView): WeeklyProvenance {
  const o = view.saved;
  const typed = (v: string | null | undefined) => v != null && v.trim() !== "";

  const milestones: Record<string, boolean> = {};
  for (const f of MILESTONE_FIELDS) milestones[f.key] = typed(o?.milestones?.[f.key]);

  // Contractor and equipment rows already carry the per-cell answer: the
  // derivation stamps `overridden` as it merges the saved overrides in. A row
  // typed in by hand has no derivation behind it at all, so every cell is ours.
  //
  // Read off the frozen rows for an issued report, because those are the rows
  // that print - a sub added to the project after issue is not on the sheet and
  // must not be counted in the legend.
  const frozen = view.status === "issued" ? view.saved?.issued_payload : null;
  const contractors: Record<string, string[]> = {};
  for (const c of frozen?.contractors ?? view.contractors) {
    contractors[c.key] = c.key.startsWith("manual:")
      ? ["name", "scope", "headcount", "lastOnsite", "endDate"]
      : c.overridden;
  }
  const equipment: Record<string, string[]> = {};
  for (const e of frozen?.equipment ?? view.equipment) {
    equipment[e.key] = e.key.startsWith("manual:") ? ["name", "quantity"] : e.overridden;
  }

  const p: WeeklyProvenance = {
    // The three names are never derived from anything - they are typed once and
    // carried forward, so a filled name is always a person's.
    dimensionCm: typed(view.header.dimensionCm),
    epcReportingManager: typed(view.header.epcReportingManager),
    epcTeam: typed(view.header.epcTeam),
    environment: typed(o?.environment_concerns),
    security: typed(o?.security_concerns),
    safety: typed(o?.safety_summary),
    weather: typed(o?.weather_summary),
    position: typed(o?.position_note),
    workThisWeek: typed(o?.work_this_week),
    risks: typed(o?.schedule_risks),
    swppp: typed(o?.swppp_inspection_date),
    lookaheadNote: typed(o?.lookahead_note),
    photoNote: typed(o?.photo_note),
    milestones,
    contractors,
    equipment,
    manualCount: 0,
  };

  p.manualCount =
    [
      p.dimensionCm,
      p.epcReportingManager,
      p.epcTeam,
      p.environment,
      p.security,
      p.safety,
      p.weather,
      p.position,
      p.workThisWeek,
      p.risks,
      p.swppp,
      p.lookaheadNote,
      p.photoNote,
    ].filter(Boolean).length +
    Object.values(milestones).filter(Boolean).length +
    Object.values(contractors).reduce((n, cells) => n + cells.length, 0) +
    Object.values(equipment).reduce((n, cells) => n + cells.length, 0);

  return p;
}
