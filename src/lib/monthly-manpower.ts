// Deriving the owner's Monthly Manpower and Incident Report from what the
// project already knows.
//
// The form is short and it asks two unrelated things. One submission carries
// the period's man-hours. A further submission is filed for every incident,
// classified as Near Miss, First Aid, Asset Damage, Recordable or Lost Time.
// So this module produces N+1 submissions, not one document, and the report
// page's job is to make each of them keyable without anyone counting rows by
// hand.
//
// Everything here is PURE - rows in, report out, no Supabase, no dates read
// from the clock. That is what lets the print page, the edit form and the
// submit action all produce identical output from the same inputs, and what
// makes this testable without a database.
//
// Same contract as the weekly report: a derived value is never silently
// authoritative. Each one comes back as { value, basis, sources } so the page
// can show WHY it says 1,284 hours, and the reviewer can disagree with the
// reasoning rather than just the digit.

import { periodEndOf, periodLabel } from "./billing-period";

export type Derived<T> = {
  value: T;
  /** One line of plain English: how this number was arrived at. */
  basis: string;
  /** The days that fed it, so the page can link back to the evidence. */
  sources: string[];
};

function derive<T>(value: T, basis: string, sources: string[] = []): Derived<T> {
  return { value, basis, sources };
}

// ---------------------------------------------------------------------------
// Inputs - the narrowest shape each query needs, not table Rows.
// ---------------------------------------------------------------------------

export type MonthlyDpr = {
  id: string;
  report_date: string;
  status: string | null;
  subcontractor_id: string | null;
  crew_count: number | null;
  total_man_hours: number | null;
  safety_incident: boolean | null;
  near_miss: boolean | null;
  safety_narrative: string | null;
  work_narrative: string | null;
};

export type MonthlyManpower = {
  dpr_id: string;
  subcontractor_id: string | null;
  trade: string | null;
  headcount: number;
  regular_hours: number;
  ot_hours: number;
};

export type MonthlyCmLog = {
  log_date: string;
  status?: string | null;
  safety_notes: string | null;
  progress_summary: string | null;
  /**
   * 0045's columns. Optional on the type as well as nullable in the column,
   * because the page has to keep working on a database where 0045 has not been
   * applied yet - see `ahcColumnsAvailable` on the loaded view.
   */
  ahc_headcount?: number | null;
  ahc_man_hours?: number | null;
};

export type MonthlySub = {
  id: string;
  company_name: string;
  trade: string | null;
};

// ---------------------------------------------------------------------------
// The period
// ---------------------------------------------------------------------------

export type Period = { start: string; end: string };

/** The YYYY-MM-01 the report defaults to: the month just finished. */
export function defaultPeriodMonth(todayIso: string): string {
  const [y, m] = todayIso.split("-").map(Number);
  // Month 0 of the next year is December of this one, which Date.UTC handles.
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** The calendar month a YYYY-MM-01 names, as the form's start/finish pair. */
export function monthPeriod(periodMonth: string): Period {
  return { start: periodMonth, end: periodEndOf(periodMonth) };
}

/** The month before / after a YYYY-MM-01, for the page's two-click stepper. */
export function stepMonth(periodMonth: string, by: number): string {
  const [y, m] = periodMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export { periodLabel };

/** "14-Sep-26", matching the weekly report's date style. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return iso ?? "";
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" })
    .replace(/ /g, "-");
}

/** "09/14/2026" - what the owner's Smartsheet date boxes expect. */
export function formDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return iso ?? "";
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Man-hours
// ---------------------------------------------------------------------------

export type SubHours = {
  subcontractorId: string | null;
  name: string;
  hours: number;
  days: number;
  /** True when any day in this sub's total had to be estimated at crew x 8. */
  estimated: boolean;
};

export type ManHoursBreakdown = {
  /** Hours from approved field reports. */
  subHours: number;
  /** Hours AHC's own people worked, from the CM daily log. */
  ahcHours: number;
  /** What goes in the form's Manhours box. */
  total: number;
  bySub: SubHours[];
  /**
   * Days with an AHC entry on the CM log. Zero means nobody recorded ours, which
   * is NOT the same claim as "AHC worked no hours" - the callers show a dash
   * rather than a 0 on the strength of this.
   */
  ahcRecordedDays: number;
  /** Days in the period that reported any hours at all. */
  daysWorked: number;
  /**
   * `ahcRecorded` is not the same question as `ahc > 0`. A day nobody entered
   * and a day AHC genuinely did not work both come out as zero hours, and
   * printing a bare 0 for the first one claims we checked. The backup sheet
   * prints "-" for an unrecorded day on the strength of this flag.
   */
  perDay: { day: string; sub: number; ahc: number; ahcRecorded: boolean }[];
};

export type HoursGap = {
  /**
   * The day at fault, or - for a `period` gap - an arbitrary day inside the
   * window, used only for sorting. Never print it for a period gap: a finding
   * about the whole month stamped with one date reads as a problem with that
   * date.
   */
  day: string;
  /** Whether this is one day's problem or the whole period's. */
  scope: "day" | "period";
  /** What is missing, in the words the page shows. */
  issue: string;
  /**
   * Whether the total is provably wrong (`missing`) or merely unverified
   * (`estimated`). A month with any `missing` gap under-reports the site.
   */
  kind: "missing" | "estimated";
};

/**
 * Man-hours worked in the period, and everything that is wrong with the figure.
 *
 * The gaps are not decoration. This number goes on an owner's form and is the
 * denominator under every safety statistic quoted back at us for the life of
 * the project, so a figure that is short by a sub's unfiled week has to say so
 * on its face rather than print clean and be defended later.
 *
 * Three sources, in order of trust:
 *   1. `dprs.total_man_hours`   - what the reporter said the crew worked.
 *   2. `dpr_manpower` regular+OT - the per-trade breakdown, when one was filled.
 *   3. `crew_count x 8`          - a last resort, and always flagged.
 * Plus AHC's own hours from the CM log, which no field report can know.
 */
export function deriveManHours(
  dprs: MonthlyDpr[],
  manpower: MonthlyManpower[],
  logs: MonthlyCmLog[],
  subs: MonthlySub[],
  ahcColumnsAvailable: boolean,
): Derived<ManHoursBreakdown> & { gaps: HoursGap[] } {
  const byDpr = new Map<string, number>();
  for (const m of manpower) {
    byDpr.set(m.dpr_id, (byDpr.get(m.dpr_id) ?? 0) + Number(m.regular_hours) + Number(m.ot_hours));
  }
  const subName = new Map(subs.map((s) => [s.id, s.company_name]));

  const gaps: HoursGap[] = [];
  const perDay = new Map<string, { sub: number; ahc: number; ahcRecorded: boolean }>();
  const bump = (day: string, key: "sub" | "ahc", n: number) => {
    const row = perDay.get(day) ?? { sub: 0, ahc: 0, ahcRecorded: false };
    row[key] += n;
    if (key === "ahc") row.ahcRecorded = true;
    perDay.set(day, row);
  };

  const tally = new Map<string, SubHours>();
  for (const d of dprs) {
    let hours = 0;
    let estimated = false;
    if (d.total_man_hours != null) {
      hours = Number(d.total_man_hours);
    } else if (byDpr.get(d.id)) {
      hours = byDpr.get(d.id)!;
    } else if (d.crew_count != null) {
      // Flagged, because a figure the owner may quote back at us should never
      // be a silent guess.
      hours = d.crew_count * 8;
      estimated = true;
      gaps.push({
        day: d.report_date,
        scope: "day",
        issue: `${subName.get(d.subcontractor_id ?? "") ?? "A sub"} reported ${d.crew_count} crew and no hours - counted at crew x 8.`,
        kind: "estimated",
      });
    } else {
      gaps.push({
        day: d.report_date,
        scope: "day",
        issue: `${subName.get(d.subcontractor_id ?? "") ?? "A sub"} filed a report with no hours and no crew count - it contributes nothing.`,
        kind: "missing",
      });
      continue;
    }

    const key = d.subcontractor_id ?? "unassigned";
    const row = tally.get(key) ?? {
      subcontractorId: d.subcontractor_id,
      name: subName.get(d.subcontractor_id ?? "") ?? "Unattributed",
      hours: 0,
      days: 0,
      estimated: false,
    };
    row.hours += hours;
    row.days += 1;
    row.estimated = row.estimated || estimated;
    tally.set(key, row);
    bump(d.report_date, "sub", hours);
  }

  // AHC's own hours. A CM log with nothing entered is the gap that matters
  // most here: it is the one the field reports cannot cover for, and it is
  // silent - the total simply comes out low.
  let ahcHours = 0;
  if (ahcColumnsAvailable) {
    const blank: string[] = [];
    for (const l of logs) {
      const h = l.ahc_man_hours;
      if (h != null) {
        ahcHours += Number(h);
        bump(l.log_date, "ahc", Number(h));
      } else {
        blank.push(l.log_date);
      }
    }
    // Collapsed when NOTHING was ever entered. A month where the CM has not
    // started filling these in produces one gap per working day - twenty-one
    // identical rows that bury the gaps that are actually specific to a day,
    // and read as twenty-one problems rather than one habit.
    if (blank.length && blank.length === logs.length) {
      gaps.push({
        day: blank[0],
        scope: "period",
        issue: `No AHC hours on any of the ${logs.length} CM log${logs.length === 1 ? "" : "s"} this period - our own people's time is missing from the total entirely.`,
        kind: "missing",
      });
    } else {
      for (const day of blank) {
        gaps.push({
          day,
          scope: "day",
          issue: "CM log has no AHC hours - our own people's time is missing from the total.",
          kind: "missing",
        });
      }
    }
  }

  const subHours = round1(Array.from(tally.values()).reduce((a, r) => a + r.hours, 0));
  ahcHours = round1(ahcHours);
  const total = round1(subHours + ahcHours);

  const bySub = Array.from(tally.values())
    .map((r) => ({ ...r, hours: round1(r.hours) }))
    .sort((a, b) => b.hours - a.hours);

  const ahcRecordedDays = Array.from(perDay.values()).filter((v) => v.ahcRecorded).length;

  const value: ManHoursBreakdown = {
    subHours,
    ahcHours,
    total,
    bySub,
    ahcRecordedDays,
    daysWorked: perDay.size,
    perDay: Array.from(perDay.entries())
      .map(([day, v]) => ({
        day,
        sub: round1(v.sub),
        ahc: round1(v.ahc),
        ahcRecorded: v.ahcRecorded,
      }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };

  const missing = gaps.filter((g) => g.kind === "missing").length;
  const basis = !total
    ? "No approved field report or CM log in the period recorded any hours."
    : `${total.toLocaleString()} hours across ${perDay.size} day${perDay.size === 1 ? "" : "s"}` +
      ` - ${subHours.toLocaleString()} from ${bySub.length} sub${bySub.length === 1 ? "" : "s"}` +
      (!ahcColumnsAvailable
        ? ". AHC's own hours are not included - migration 0045 has not been applied."
        : ahcRecordedDays === 0
          ? ". No AHC hours were recorded on any CM log, so our own time is not in it."
          : `, ${ahcHours.toLocaleString()} AHC across ${ahcRecordedDays} day${ahcRecordedDays === 1 ? "" : "s"}.`) +
      (missing
        ? ` ${missing} day${missing === 1 ? " is" : "s are"} missing hours, so this reads low.`
        : "");

  return {
    ...derive(value, basis, value.perDay.map((p) => p.day)),
    gaps: gaps.sort((a, b) => a.day.localeCompare(b.day)),
  };
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

/** The form's Incident Type checkboxes, in the order the form prints them. */
export const INCIDENT_TYPES = [
  { value: "near_miss", label: "Near Miss" },
  { value: "first_aid", label: "First Aid" },
  { value: "asset_damage", label: "Asset Damage" },
  { value: "recordable", label: "Recordable" },
  { value: "lost_time", label: "Lost Time" },
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number]["value"];

const TYPE_LABEL = new Map<string, string>(INCIDENT_TYPES.map((t) => [t.value, t.label]));

export function incidentTypeLabel(value: string): string {
  return TYPE_LABEL.get(value) ?? value;
}

export function isIncidentType(v: string): v is IncidentType {
  return TYPE_LABEL.has(v);
}

// Words that suggest a classification. These SUGGEST and never decide - the
// checkbox stays unticked until a human ticks it. A keyword that quietly
// classified an injury as Recordable would be putting an OSHA determination in
// the hands of a substring match.
const TYPE_HINTS: { type: IncidentType; words: string[] }[] = [
  {
    type: "near_miss",
    words: ["near miss", "near-miss", "close call", "could have", "no injury", "narrowly"],
  },
  {
    type: "first_aid",
    words: ["first aid", "first-aid", "band aid", "band-aid", "bandage", "minor cut", "scrape", "splinter", "eye wash", "eyewash"],
  },
  {
    type: "asset_damage",
    words: ["damage", "damaged", "backed into", "struck the", "broke the", "broken", "rollover", "roll over", "property damage", "equipment damage", "vehicle", "windshield", "fence", "collision"],
  },
  {
    type: "recordable",
    words: ["recordable", "stitches", "sutures", "fracture", "broken bone", "hospital", "emergency room", "er visit", "urgent care", "physician", "prescription", "laceration", "concussion", "burn"],
  },
  {
    type: "lost_time",
    words: ["lost time", "lost-time", "days away", "off work", "unable to return", "sent home", "restricted duty", "light duty", "did not return"],
  },
];

/**
 * Words that make a free-text note worth raising as a possible incident.
 *
 * Split into two lists, because a keyword in a CM's notepad is not evidence of
 * anything on its own. "Toolbox talk on heat stress" is a TRAINING TOPIC, and a
 * list that raises it teaches the reader to skim past the candidates - which is
 * how a real incident gets dismissed with the noise. The weekly report learned
 * the same lesson the hard way when POD minutes started printing in the owner's
 * Safety box.
 *
 * STRONG words describe an event that happened. They raise a candidate wherever
 * they appear, including inside a safety briefing, because "toolbox talk on
 * heat stress, and Ruiz was later taken to hospital" is one note describing
 * both a topic and an event.
 */
const STRONG_INCIDENT_WORDS = [
  "injur", "incident", "accident", "first aid", "near miss", "near-miss",
  "close call", "recordable", "lost time", "struck by", "struck the", "fell",
  "fall from", "laceration", "stitches", "fracture", "concussion", "hospital",
  "ambulance", "emergency room", "urgent care", "backed into", "rollover",
  "roll over", "collision", "property damage", "equipment damage",
  "damaged the", "sent home", "electrocut", "trench collapse", "cave in",
  "cave-in", "citation", "osha",
];

/**
 * WEAK words describe a hazard or a condition. They raise a candidate only when
 * the note is not plainly a safety talk - the same word is a topic on Monday
 * and an event on Tuesday, and only the surrounding note says which.
 */
const WEAK_INCIDENT_WORDS = [
  "cut his", "cut her", "cut their", "burn", "sprain", "strain",
  "heat exhaustion", "heat stress", "dehydrat", "stop work", "stopped work",
  "shock", "damage", "damaged",
];

/** Wording that makes a note a safety BRIEFING rather than a safety EVENT. */
const TALK_CONTEXT = [
  "toolbox", "tool box", "tailgate", "safety meeting", "safety talk",
  "jha", "job hazard analysis", "training", "briefing", "topic",
  "stretch and flex", "pre-task", "pretask", "reminder", "discussed",
  "all ppe in order", "no issues", "reviewed",
];

function hits(text: string, words: string[]): boolean {
  const hay = text.toLowerCase();
  return words.some((w) => hay.includes(w));
}

/** Whether a note, on its own, is worth raising as a possible incident. */
function readsAsIncident(text: string): boolean {
  if (hits(text, STRONG_INCIDENT_WORDS)) return true;
  if (!hits(text, WEAK_INCIDENT_WORDS)) return false;
  return !hits(text, TALK_CONTEXT);
}

function suggestTypes(text: string | null | undefined, nearMissFlag: boolean): IncidentType[] {
  const out = new Set<IncidentType>();
  if (nearMissFlag) out.add("near_miss");
  const t = text?.trim();
  if (t) {
    for (const hint of TYPE_HINTS) {
      if (hits(t, hint.words)) out.add(hint.type);
    }
  }
  return INCIDENT_TYPES.map((t) => t.value).filter((v) => out.has(v));
}

/**
 * Something in the period that might be an incident the owner has to be told
 * about. A candidate is not a finding.
 *
 * Two origins with very different weight:
 *   - A field report's `safety_incident` / `near_miss` flag is a deliberate act
 *     by the reporter. It is an incident.
 *   - A keyword in a narrative or in the CM's safety notes is a guess. On this
 *     project the CM uses `safety_notes` as a general notepad, so the guesses
 *     will over-raise, and every one of them has to be dismissable.
 */
export type IncidentCandidate = {
  /** `dpr:<uuid>` or `cm:<date>`. Stable, so a classification survives a reload. */
  key: string;
  occurredOn: string;
  origin: "dpr" | "cm";
  /** "Pyramid Excavations field report" / "CM daily log". */
  sourceLabel: string;
  /** Whether a human deliberately flagged this, or a keyword found it. */
  flagged: boolean;
  narrative: string;
  suggestedTypes: IncidentType[];
};

export function deriveIncidentCandidates(
  dprs: MonthlyDpr[],
  logs: MonthlyCmLog[],
  subs: MonthlySub[],
): Derived<IncidentCandidate[]> {
  const subName = new Map(subs.map((s) => [s.id, s.company_name]));
  const out: IncidentCandidate[] = [];

  for (const d of dprs) {
    const flagged = Boolean(d.safety_incident || d.near_miss);
    const narrative = d.safety_narrative?.trim() ?? "";
    const fromText = !flagged && narrative ? readsAsIncident(narrative) : false;
    if (!flagged && !fromText) continue;
    out.push({
      key: `dpr:${d.id}`,
      occurredOn: d.report_date,
      origin: "dpr",
      sourceLabel: `${subName.get(d.subcontractor_id ?? "") ?? "Sub"} field report`,
      flagged,
      narrative,
      suggestedTypes: suggestTypes(narrative, Boolean(d.near_miss)),
    });
  }

  for (const l of logs) {
    const text = l.safety_notes?.trim() ?? "";
    if (!text || !readsAsIncident(text)) continue;
    out.push({
      key: `cm:${l.log_date}`,
      occurredOn: l.log_date,
      origin: "cm",
      sourceLabel: "CM daily log",
      flagged: false,
      narrative: text,
      suggestedTypes: suggestTypes(text, false),
    });
  }

  out.sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.key.localeCompare(b.key));

  const flaggedCount = out.filter((c) => c.flagged).length;
  const guessed = out.length - flaggedCount;
  const basis = !out.length
    ? "No field report flagged an incident and nothing in the period's notes reads like one."
    : `${flaggedCount} flagged on a field report` +
      (guessed ? `, ${guessed} raised from the wording of a note - read those before filing or dismissing them.` : ".");

  return derive(out, basis, out.map((c) => c.occurredOn));
}

// ---------------------------------------------------------------------------
// Applying the human's corrections
// ---------------------------------------------------------------------------

/** What a human decided about one candidate. Absent = undecided. */
export type IncidentOverride = {
  types?: string[];
  description?: string;
  occurredOn?: string;
  hidden?: boolean;
};

/** An incident with no trace in the field record - typed in whole. */
export type ExtraIncident = {
  key: string;
  occurredOn: string;
  types: string[];
  description: string;
  reportedBy?: string;
};

export type ResolvedIncident = {
  key: string;
  occurredOn: string;
  origin: "dpr" | "cm" | "manual";
  sourceLabel: string;
  /** Deliberately flagged on a field report, rather than found in free text. */
  flagged: boolean;
  narrative: string;
  types: IncidentType[];
  suggestedTypes: IncidentType[];
  description: string;
  hidden: boolean;
  /** False until at least one type is ticked. An unclassified incident cannot be filed. */
  classified: boolean;
};

const cleanTypes = (v: unknown): IncidentType[] =>
  Array.isArray(v) ? (v.filter((x) => typeof x === "string" && isIncidentType(x)) as IncidentType[]) : [];

export function resolveIncidents(
  candidates: IncidentCandidate[],
  overrides: Record<string, IncidentOverride>,
  extras: ExtraIncident[],
): ResolvedIncident[] {
  const resolved: ResolvedIncident[] = candidates.map((c) => {
    const o = overrides[c.key] ?? {};
    // A saved empty array means "considered and left blank"; an absent key
    // means "never looked at". Both come out unclassified, but only the second
    // should ever be pre-ticked from the suggestion.
    const types = o.types !== undefined ? cleanTypes(o.types) : [];
    return {
      key: c.key,
      occurredOn: o.occurredOn ?? c.occurredOn,
      origin: c.origin,
      sourceLabel: c.sourceLabel,
      flagged: c.flagged,
      narrative: c.narrative,
      types,
      suggestedTypes: c.suggestedTypes,
      description: o.description ?? c.narrative,
      hidden: Boolean(o.hidden),
      classified: types.length > 0,
    };
  });

  for (const e of extras) {
    const types = cleanTypes(e.types);
    resolved.push({
      key: e.key,
      occurredOn: e.occurredOn,
      origin: "manual",
      sourceLabel: e.reportedBy?.trim() ? `Reported by ${e.reportedBy.trim()}` : "Added by hand",
      flagged: true,
      narrative: "",
      types,
      suggestedTypes: [],
      description: e.description ?? "",
      hidden: false,
      classified: types.length > 0,
    });
  }

  return resolved.sort(
    (a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.key.localeCompare(b.key),
  );
}

/** Drop overrides that say nothing, so an untouched report stays fully derived. */
export function diffIncidents(
  submitted: Record<string, IncidentOverride>,
  candidates: IncidentCandidate[],
): Record<string, IncidentOverride> {
  const base = new Map(candidates.map((c) => [c.key, c]));
  const out: Record<string, IncidentOverride> = {};
  for (const [key, o] of Object.entries(submitted)) {
    const c = base.get(key);
    const kept: IncidentOverride = {};
    const types = cleanTypes(o.types);
    // Classification is always stored once made. It has no derivation to fall
    // back to - the suggestion is a hint, not an answer - so "same as suggested"
    // is still a decision a human took and must survive the next save.
    if (types.length) kept.types = types;
    const desc = o.description?.trim();
    if (desc && desc !== (c?.narrative ?? "").trim()) kept.description = desc;
    if (o.occurredOn && o.occurredOn !== c?.occurredOn) kept.occurredOn = o.occurredOn;
    if (o.hidden) kept.hidden = true;
    if (Object.keys(kept).length) out[key] = kept;
  }
  return out;
}

// ---------------------------------------------------------------------------
// What actually gets keyed into the owner's form
// ---------------------------------------------------------------------------

/**
 * One Smartsheet submission. The form is filed once for the hours and once per
 * incident, so this is the unit the page hands over with a copy button beside
 * each field - the whole point of the report is that nobody re-counts anything.
 */
export type FormSubmission = {
  kind: "manhours" | "incident";
  /** Heading on the card: "Manhours" or "Incident 2 of 3 - 14-Sep-26". */
  title: string;
  fields: { label: string; value: string; /** Nothing to copy, e.g. a checkbox list. */ readOnly?: boolean }[];
  /** Why this submission cannot be filed yet. Empty when it is ready. */
  blockers: string[];
};

export function buildSubmissions(input: {
  projectName: string;
  period: Period;
  hours: number;
  hoursDerived: number;
  hoursOverridden: boolean;
  hoursNote: string;
  gaps: HoursGap[];
  incidents: ResolvedIncident[];
}): FormSubmission[] {
  const live = input.incidents.filter((i) => !i.hidden);

  const hoursBlockers: string[] = [];
  if (!input.hours) hoursBlockers.push("The period has no hours to report.");
  for (const g of input.gaps.filter((x) => x.kind === "missing")) {
    hoursBlockers.push(
      `${g.scope === "period" ? "All month" : shortDate(g.day)}: ${g.issue}`,
    );
  }
  if (input.hoursOverridden && !input.hoursNote.trim()) {
    hoursBlockers.push("The total was typed over the derived figure with no reason given.");
  }

  const submissions: FormSubmission[] = [
    {
      kind: "manhours",
      title: "Manhours",
      fields: [
        { label: "Project", value: input.projectName },
        { label: "Report Type", value: "Manhours", readOnly: true },
        { label: "Report Period Start Date", value: formDate(input.period.start) },
        { label: "Report Period Finish Date", value: formDate(input.period.end) },
        { label: "Manhours", value: String(input.hours) },
      ],
      blockers: hoursBlockers,
    },
  ];

  live.forEach((inc, i) => {
    submissions.push({
      kind: "incident",
      title: `Incident ${i + 1} of ${live.length} - ${shortDate(inc.occurredOn)}`,
      fields: [
        { label: "Project", value: input.projectName },
        { label: "Report Type", value: "Incident", readOnly: true },
        {
          label: "Incident Type",
          value: inc.types.length ? inc.types.map(incidentTypeLabel).join(", ") : "-",
          readOnly: true,
        },
        { label: "Description", value: inc.description.trim() },
      ],
      blockers: inc.classified ? [] : ["No incident type ticked - the form cannot be submitted without one."],
    });
  });

  return submissions;
}

/** Everything standing between this report and being filed. */
export function readiness(submissions: FormSubmission[]): {
  ready: boolean;
  blockers: string[];
} {
  const blockers = submissions.flatMap((s) =>
    s.blockers.map((b) => (s.kind === "manhours" ? b : `${s.title}: ${b}`)),
  );
  return { ready: blockers.length === 0, blockers };
}
