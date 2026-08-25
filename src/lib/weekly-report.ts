// Deriving the Dimension weekly progress report from what the project already
// knows.
//
// The form Dimension sends is a spreadsheet with sixteen boxes. Fifteen of
// them are answerable from rows this database already holds; the sixteenth (a
// sub's demob date) is a commercial fact nobody has told us. So this module's
// job is to answer the fifteen and be honest about the one.
//
// Everything here is PURE - rows in, report out, no Supabase, no dates read
// from the clock. That is what lets the print page, the edit form and the
// issue action all produce identical output from the same inputs, and what
// makes this testable without a database.
//
// A derived value is never silently authoritative. Each one comes back as
// { value, basis, sources } so the form can show WHY it says eight crew, and
// the reviewer can disagree with the reasoning rather than just the digit.

export type Derived<T> = {
  value: T;
  /** One line of plain English: how this number was arrived at. */
  basis: string;
  /** The days that fed it, so the form can link back to the evidence. */
  sources: string[];
};

function derive<T>(value: T, basis: string, sources: string[] = []): Derived<T> {
  return { value, basis, sources };
}

// ---------------------------------------------------------------------------
// Inputs - deliberately the narrowest shape each query needs, not table Rows.
// ---------------------------------------------------------------------------

export type WeeklyDpr = {
  id: string;
  report_date: string;
  status: string | null;
  subcontractor_id: string | null;
  work_narrative: string | null;
  crew_count: number | null;
  total_man_hours: number | null;
  weather_conditions: string | null;
  temp_high: number | null;
  temp_low: number | null;
  safety_incident: boolean | null;
  near_miss: boolean | null;
  safety_narrative: string | null;
};

export type WeeklyCmLog = {
  log_date: string;
  progress_summary: string | null;
  site_conditions: string | null;
  safety_notes: string | null;
  weather_conditions: string | null;
  temp_high: number | null;
  temp_low: number | null;
};

export type WeeklyManpower = {
  dpr_id: string;
  subcontractor_id: string | null;
  trade: string | null;
  headcount: number;
  regular_hours: number;
  ot_hours: number;
};

export type WeeklyEquipment = {
  dpr_id: string;
  equipment_name: string;
  quantity: number | null;
  active: boolean;
  rental_company: string | null;
};

export type WeeklySub = {
  id: string;
  company_name: string;
  trade: string | null;
  active: boolean | null;
};

export type WeeklyDelay = {
  dpr_id: string;
  cause_code: string;
  hours_lost: number | null;
  narrative: string | null;
};

export type WeeklyConstraint = {
  id: string;
  title: string;
  category: string;
  owner: string | null;
  need_by: string | null;
  status: string;
  wbs_code: string | null;
};

export type WeeklyTask = {
  wbs_code: string;
  task_name: string;
  assigned_to: string | null;
  status: string | null;
  pct_complete: number | null;
  end_date: string | null;
  is_milestone?: boolean | null;
  is_at_risk?: boolean | null;
};

export type WeeklyInspection = {
  inspection_type: string | null;
  inspector_name: string | null;
  status: string;
  submitted_at: string | null;
  decided_at: string | null;
  created_at: string | null;
};

export type WeeklyProduction = {
  production_date: string;
  commodity_id: string;
  quantity: number;
  confirmed_at: string | null;
};

export type WeeklyCommodity = { id: string; label: string; uom: string };

// The saved row. Every narrative field is null until somebody types over it.
export type WeeklyOverrides = {
  dimension_cm: string | null;
  epc_reporting_manager: string | null;
  epc_team: string | null;
  environment_concerns: string | null;
  security_concerns: string | null;
  weather_summary: string | null;
  work_this_week: string | null;
  lookahead_note: string | null;
  schedule_risks: string | null;
  swppp_inspection_date: string | null;
  milestones: Record<string, string | null>;
  contractor_overrides: Record<string, ContractorOverride>;
  extra_contractors: ContractorRow[];
  equipment_overrides: Record<string, EquipmentOverride>;
  extra_equipment: EquipmentRow[];
};

export type ContractorOverride = Partial<{
  scope: string;
  headcount: number;
  lastOnsite: string;
  endDate: string;
  hidden: boolean;
}>;

export type EquipmentOverride = Partial<{ quantity: number; hidden: boolean }>;

export type ContractorRow = {
  /** subcontractors.id, or a `manual:<name>` handle for a typed-in row. */
  key: string;
  name: string;
  scope: string;
  headcount: number | null;
  lastOnsite: string | null;
  endDate: string | null;
  /** Which of the four cells the human changed, so the form can show it. */
  overridden: string[];
  /** How headcount was arrived at. Empty for manually added rows. */
  basis: string;
};

export type EquipmentRow = {
  key: string;
  name: string;
  quantity: number | null;
  overridden: string[];
  basis: string;
};

export const MILESTONE_FIELDS = [
  { key: "mechanicalCompletion", label: "Mechanical Completion", match: ["mechanical completion", "mech completion", "mechanically complete"] },
  { key: "permissionToOperate", label: "Permission to Operate", match: ["permission to operate", "pto"] },
  { key: "placedInService", label: "Placed in Service", match: ["placed in service", "pis", "commercial operation", "cod"] },
  { key: "substantialCompletion", label: "Substantial Completion", match: ["substantial completion", "subcompletion"] },
] as const;

export type MilestoneKey = (typeof MILESTONE_FIELDS)[number]["key"];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function msOf(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function addDays(iso: string, days: number): string {
  return isoOf(msOf(iso) + days * DAY_MS);
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let ms = msOf(from); ms <= msOf(to) && out.length < 60; ms += DAY_MS) {
    out.push(isoOf(ms));
  }
  return out;
}

export function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Dimension writes dates as 24-Aug-26. Match the form rather than the app. */
export function dimensionDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    })
    .replace(/ /g, "-");
}

/**
 * The seven days the report covers, given the date in the Week Ending box.
 *
 * Sweet Springs files on a Monday for the week that ended the Friday before,
 * so "week ending 24-Aug-26" covers 17-23 Aug, not 18-24. Anchoring on the
 * Sunday before the week-ending date gets that right for a Monday filing and
 * still gets it right when the box holds the Sunday itself.
 */
export function defaultPeriod(weekEnding: string): { start: string; end: string } {
  const dow = new Date(msOf(weekEnding)).getUTCDay(); // 0 Sun .. 6 Sat
  // Sunday stays put; any other day walks back to the Sunday before it.
  const end = dow === 0 ? weekEnding : addDays(weekEnding, -dow);
  return { start: addDays(end, -6), end };
}

/** The most recent Sunday on or before `today`, which is the usual filing week. */
export function defaultWeekEnding(today: string): string {
  const dow = new Date(msOf(today)).getUTCDay();
  return dow === 0 ? today : addDays(today, -dow);
}

// ---------------------------------------------------------------------------
// Site resources
// ---------------------------------------------------------------------------

/**
 * Contractors on site this week.
 *
 * Headcount is the PEAK day, not the average and not the last day. Dimension
 * reads this as "how many bodies did you have", and an average over a week
 * containing a rained-out Monday understates the crew that actually showed up.
 * The average is carried in the basis line so the reviewer can see the spread.
 *
 * `lastOnsite` looks at ALL history, not just this week - it is a statement of
 * fact about the sub, and a sub who demobbed in July should show July here
 * rather than showing blank because they were absent from these seven days.
 */
export function deriveContractors(
  subs: WeeklySub[],
  dprs: WeeklyDpr[],
  manpower: WeeklyManpower[],
  allTimeOnsite: { subcontractor_id: string | null; report_date: string }[],
  tasks: WeeklyTask[],
  overrides: Record<string, ContractorOverride>,
  extras: ContractorRow[],
): ContractorRow[] {
  const dprById = new Map(dprs.map((d) => [d.id, d]));

  // Peak and average headcount per sub, per day.
  const perSubDay = new Map<string, Map<string, number>>();
  for (const m of manpower) {
    const dpr = dprById.get(m.dpr_id);
    if (!dpr) continue;
    const sub = m.subcontractor_id ?? dpr.subcontractor_id;
    if (!sub) continue;
    const days = perSubDay.get(sub) ?? new Map<string, number>();
    days.set(dpr.report_date, (days.get(dpr.report_date) ?? 0) + m.headcount);
    perSubDay.set(sub, days);
  }
  // A field report with no manpower breakdown still carries a crew count.
  for (const d of dprs) {
    if (!d.subcontractor_id || d.crew_count == null) continue;
    const days = perSubDay.get(d.subcontractor_id) ?? new Map<string, number>();
    if (!days.has(d.report_date)) days.set(d.report_date, d.crew_count);
    perSubDay.set(d.subcontractor_id, days);
  }

  const lastSeen = new Map<string, string>();
  for (const row of allTimeOnsite) {
    if (!row.subcontractor_id) continue;
    const prev = lastSeen.get(row.subcontractor_id);
    if (!prev || row.report_date > prev) lastSeen.set(row.subcontractor_id, row.report_date);
  }

  // A sub's end date, where the schedule has an opinion: the last day of any
  // task assigned to them. Weak evidence, so it is offered rather than filled.
  const lastTaskEnd = new Map<string, string>();
  for (const t of tasks) {
    if (!t.assigned_to || !t.end_date) continue;
    const name = t.assigned_to.trim().toLowerCase();
    const prev = lastTaskEnd.get(name);
    if (!prev || t.end_date > prev) lastTaskEnd.set(name, t.end_date);
  }

  const rows: ContractorRow[] = [];
  for (const sub of subs) {
    const o = overrides[sub.id] ?? {};
    if (o.hidden) continue;

    // A sub under contract who has never set foot on site is not a site
    // resource, and listing all ten of them with blank cells buries the one
    // crew that actually worked. Anyone with history stays - including a sub
    // who demobbed months ago, because their last-onsite date is the answer to
    // a question Dimension is asking. A sub with an override typed against
    // them was deliberately put on the report, so they stay too.
    const hasHistory = lastSeen.has(sub.id) || perSubDay.has(sub.id);
    if (!hasHistory && Object.keys(o).length === 0) continue;

    const days = perSubDay.get(sub.id);
    const counts = days ? Array.from(days.values()).filter((n) => n > 0) : [];
    const peak = counts.length ? Math.max(...counts) : null;
    const avg = counts.length
      ? Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 10) / 10
      : null;

    const scheduleEnd = lastTaskEnd.get(sub.company_name.trim().toLowerCase()) ?? null;
    const overridden: string[] = [];
    for (const k of ["scope", "headcount", "lastOnsite", "endDate"] as const) {
      if (o[k] != null) overridden.push(k);
    }

    let basis: string;
    if (o.headcount != null) {
      basis = "Entered by hand.";
    } else if (peak == null) {
      basis = "No field report from this sub in the period.";
    } else {
      basis = `Peak of ${peak} across ${counts.length} reported day${counts.length === 1 ? "" : "s"}${
        avg != null && avg !== peak ? `, averaging ${avg}` : ""
      }.`;
    }

    rows.push({
      key: sub.id,
      name: sub.company_name,
      scope: o.scope ?? sub.trade ?? "",
      headcount: o.headcount ?? peak,
      lastOnsite: o.lastOnsite ?? lastSeen.get(sub.id) ?? null,
      endDate: o.endDate ?? scheduleEnd,
      overridden,
      basis,
    });
  }

  // Subs who actually worked come first; the rest keep alphabetical order so
  // the table does not reshuffle week to week.
  rows.sort((a, b) => {
    const aOn = a.headcount ? 1 : 0;
    const bOn = b.headcount ? 1 : 0;
    if (aOn !== bOn) return bOn - aOn;
    return a.name.localeCompare(b.name);
  });

  return [...rows, ...extras];
}

/**
 * Plant on site, from the equipment lines on the week's field reports.
 *
 * Quantity is the peak day again, and for the same reason: two dozers on
 * Tuesday and none on Friday is "2 dozers", not "1". Idle equipment (`active`
 * false) is excluded - Dimension is asking what was working, and listing a
 * broken-down machine as plant on site overstates the resource.
 */
export function deriveEquipment(
  dprs: WeeklyDpr[],
  equipment: WeeklyEquipment[],
  overrides: Record<string, EquipmentOverride>,
  extras: EquipmentRow[],
): EquipmentRow[] {
  const dprById = new Map(dprs.map((d) => [d.id, d]));
  const perNameDay = new Map<string, Map<string, number>>();

  for (const e of equipment) {
    if (!e.active) continue;
    const dpr = dprById.get(e.dpr_id);
    if (!dpr) continue;
    const name = e.equipment_name.trim();
    if (!name) continue;
    const days = perNameDay.get(name) ?? new Map<string, number>();
    days.set(dpr.report_date, (days.get(dpr.report_date) ?? 0) + (e.quantity ?? 1));
    perNameDay.set(name, days);
  }

  const rows: EquipmentRow[] = [];
  for (const [name, days] of Array.from(perNameDay.entries())) {
    const o = overrides[name] ?? {};
    if (o.hidden) continue;
    const counts = Array.from(days.values());
    const peak = counts.length ? Math.max(...counts) : null;
    rows.push({
      key: name,
      name,
      quantity: o.quantity ?? peak,
      overridden: o.quantity != null ? ["quantity"] : [],
      basis:
        o.quantity != null
          ? "Entered by hand."
          : `Peak of ${peak} on site across ${days.size} reported day${days.size === 1 ? "" : "s"}.`,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return [...rows, ...extras];
}

// ---------------------------------------------------------------------------
// Environment, security, weather
// ---------------------------------------------------------------------------

const NO_SECURITY_CONCERNS =
  "There were no security concerns, unauthorized access issues, or safety incidents noted in any of the daily logs for this week.";

/**
 * Security concerns.
 *
 * The default is not blank, it is the sentence that says nothing happened -
 * and it is only written when the logs actually support it. An empty box on a
 * form the owner reads means "we did not fill this in"; the sentence means "we
 * checked". Those are different claims and the form should only make the
 * second one when it is true.
 */
export function deriveSecurity(
  dprs: WeeklyDpr[],
  logs: WeeklyCmLog[],
): Derived<string> {
  // INCIDENTS are the flags a reporter deliberately set. They are the only
  // thing that can contradict the no-incidents sentence.
  //
  // NOTES are free text somebody typed into a safety box. On Sweet Springs the
  // CM uses `safety_notes` as a general notepad - his POD meeting minutes live
  // there - and an earlier version of this function let that prose REPLACE the
  // no-incidents sentence, so the owner's Security Concerns box would have read
  // "Pyramid exclamations it's going to start hauling the brush out today".
  // Free text is not a claim that something went wrong, so it is carried as
  // context underneath the finding rather than standing in for one.
  const incidents: string[] = [];
  const notes: string[] = [];
  const sources: string[] = [];

  for (const d of dprs) {
    const flagged = d.safety_incident || d.near_miss;
    const text = d.safety_narrative?.trim();
    if (!flagged && !text) continue;
    sources.push(d.report_date);
    if (flagged) {
      const tag = d.safety_incident ? "Safety incident" : "Near miss";
      incidents.push(`${shortDay(d.report_date)} - ${tag}${text ? `: ${text}` : "."}`);
    } else {
      // A narrative with no flag against it: the reporter wrote something but
      // did not call it an incident.
      notes.push(`${shortDay(d.report_date)} - Field report note: ${text}`);
    }
  }
  for (const l of logs) {
    const text = l.safety_notes?.trim();
    if (!text) continue;
    notes.push(`${shortDay(l.log_date)} - CM log note: ${text}`);
    sources.push(l.log_date);
  }

  const seen = Array.from(new Set(sources)).sort();

  if (incidents.length) {
    const body = [...incidents, ...(notes.length ? ["", "Also noted:", ...notes] : [])];
    return derive(
      body.join("\n"),
      `${incidents.length} incident${incidents.length === 1 ? "" : "s"} flagged in the period${
        notes.length ? `, plus ${notes.length} unflagged note${notes.length === 1 ? "" : "s"}` : ""
      }.`,
      seen,
    );
  }

  const reportCount = dprs.length + logs.length;
  if (reportCount === 0) {
    return derive(
      "",
      "No field reports or CM log entries in the period, so there is nothing to stand behind a no-incidents statement.",
    );
  }

  // Nothing flagged. The sentence is the finding; any notes ride underneath it
  // so they are visible without contradicting it.
  const body = notes.length
    ? [NO_SECURITY_CONCERNS, "", "Noted in the logs:", ...notes].join("\n")
    : NO_SECURITY_CONCERNS;
  return derive(
    body,
    `No incident flagged on any of the ${reportCount} report${reportCount === 1 ? "" : "s"} in the period${
      notes.length
        ? `. ${notes.length} unflagged note${notes.length === 1 ? " is" : "s are"} carried below the statement - trim anything that is not a security matter`
        : ""
    }.`,
    seen,
  );
}

/**
 * Environment concerns, assembled from the CM's site-conditions notes and
 * anything the field reports logged as a weather delay. Left blank when there
 * is nothing to say - unlike security, "no environmental concerns" is not a
 * claim the logs can support on their own.
 */
export function deriveEnvironment(
  logs: WeeklyCmLog[],
  dprs: WeeklyDpr[],
  delays: WeeklyDelay[],
): Derived<string> {
  const dprById = new Map(dprs.map((d) => [d.id, d]));
  const lines: string[] = [];
  const sources: string[] = [];

  for (const l of logs) {
    const text = l.site_conditions?.trim();
    if (!text) continue;
    lines.push(`${shortDay(l.log_date)} - ${text}`);
    sources.push(l.log_date);
  }
  for (const d of delays) {
    const cause = d.cause_code.toLowerCase();
    if (!cause.includes("weather") && !cause.includes("ground") && !cause.includes("environ")) continue;
    const dpr = dprById.get(d.dpr_id);
    const when = dpr ? shortDay(dpr.report_date) : "In the period";
    lines.push(
      `${when} - ${d.cause_code}${d.hours_lost ? ` (${d.hours_lost}h lost)` : ""}${
        d.narrative ? `: ${d.narrative}` : "."
      }`,
    );
    if (dpr) sources.push(dpr.report_date);
  }

  return derive(
    lines.join("\n"),
    lines.length
      ? `${lines.length} site-condition or weather-delay entr${lines.length === 1 ? "y" : "ies"}.`
      : "No site-condition notes in the CM log and no weather delays logged.",
    Array.from(new Set(sources)).sort(),
  );
}

/**
 * Weather, condensed to one line. The daily detail is on the field reports;
 * what the owner wants here is the shape of the week and the temperature band.
 */
export function deriveWeather(dprs: WeeklyDpr[], logs: WeeklyCmLog[]): Derived<string> {
  const byDay = new Map<string, string>();
  const highs: number[] = [];
  const lows: number[] = [];

  // The CM log wins where both exist - it is one observer across the whole
  // site, where the DPR is whichever sub happened to file.
  for (const d of dprs) {
    if (d.weather_conditions?.trim()) byDay.set(d.report_date, d.weather_conditions.trim());
    if (d.temp_high != null) highs.push(d.temp_high);
    if (d.temp_low != null) lows.push(d.temp_low);
  }
  for (const l of logs) {
    if (l.weather_conditions?.trim()) byDay.set(l.log_date, l.weather_conditions.trim());
    if (l.temp_high != null) highs.push(l.temp_high);
    if (l.temp_low != null) lows.push(l.temp_low);
  }

  if (byDay.size === 0 && !highs.length && !lows.length) {
    return derive("", "No weather recorded on any report in the period.");
  }

  // Collapse to distinct conditions with the days they occurred, so a week of
  // "Clear" reads as "Clear" and not as five identical clauses.
  const grouped = new Map<string, string[]>();
  for (const day of Array.from(byDay.keys()).sort()) {
    const cond = byDay.get(day)!;
    const bucket = grouped.get(cond) ?? [];
    bucket.push(day);
    grouped.set(cond, bucket);
  }

  const parts: string[] = [];
  for (const [cond, days] of Array.from(grouped.entries())) {
    parts.push(days.length === byDay.size ? cond : `${cond} (${days.map(shortDay).join(", ")})`);
  }

  const band =
    highs.length && lows.length
      ? ` Temperatures ${Math.min(...lows)}-${Math.max(...highs)}°F.`
      : "";

  return derive(
    `${parts.join("; ")}.${band}`.replace(/^\.\s*/, "").trim(),
    `Conditions from ${byDay.size} reported day${byDay.size === 1 ? "" : "s"}.`,
    Array.from(byDay.keys()).sort(),
  );
}

/**
 * The most recent SWPPP inspection on or before the period end. Deliberately
 * not limited to the period: the box asks for the DATE OF THE MOST RECENT one,
 * and a week with no inspection should show the last one rather than a blank
 * that reads as "never".
 */
export function deriveSwppp(
  inspections: WeeklyInspection[],
  periodEnd: string,
): Derived<string | null> {
  const dated = inspections
    .map((i) => ({
      i,
      when: (i.decided_at ?? i.submitted_at ?? i.created_at ?? "").slice(0, 10),
    }))
    .filter((r) => r.when && r.when <= periodEnd)
    .sort((a, b) => (a.when < b.when ? 1 : -1));

  const latest = dated[0];
  if (!latest) {
    return derive(null, "No inspection on this project is typed or titled as SWPPP.");
  }
  const inside = latest.when >= addDays(periodEnd, -6);
  return derive(
    latest.when,
    inside
      ? `SWPPP inspection${latest.i.inspector_name ? ` by ${latest.i.inspector_name}` : ""} during the period.`
      : `Most recent SWPPP inspection on record. It falls BEFORE this reporting week - check whether one is overdue.`,
    [latest.when],
  );
}

/** SWPPP inspections are identified by type or title, both free text today. */
export function isSwppp(row: { inspection_type: string | null; title?: string | null }): boolean {
  const hay = `${row.inspection_type ?? ""} ${row.title ?? ""}`.toLowerCase();
  return hay.includes("swppp") || hay.includes("storm water") || hay.includes("stormwater");
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Work this week, as a starting draft.
 *
 * This is the one box that is genuinely writing rather than reporting - the
 * version that goes to Dimension is grouped by discipline and reads as prose.
 * What the platform can do honestly is lay out every narrative filed in the
 * period, in date order, attributed, with the week's confirmed quantities
 * underneath. That is the raw material. The form shows it as the draft AND
 * keeps it visible beside the edit box so the rewrite never has to go hunting
 * back through seven days of reports.
 */
export function deriveWorkThisWeek(
  dprs: WeeklyDpr[],
  logs: WeeklyCmLog[],
  subs: WeeklySub[],
  production: WeeklyProduction[],
  commodities: WeeklyCommodity[],
): Derived<string> {
  const subName = new Map(subs.map((s) => [s.id, s.company_name]));
  const entries: { day: string; text: string }[] = [];

  for (const d of dprs) {
    const text = d.work_narrative?.trim();
    if (!text) continue;
    const who = d.subcontractor_id ? subName.get(d.subcontractor_id) : null;
    entries.push({ day: d.report_date, text: `${who ? `${who}: ` : ""}${text}` });
  }
  for (const l of logs) {
    const text = l.progress_summary?.trim();
    if (!text) continue;
    entries.push({ day: l.log_date, text: `CM log: ${text}` });
  }
  entries.sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? -1 : 1));

  const lines = entries.map((e) => `${shortDay(e.day)} - ${e.text}`);

  // Confirmed quantities only. A proposed figure has not been stood behind by
  // anyone, and this document goes to the owner.
  const label = new Map(commodities.map((c) => [c.id, c]));
  const totals = new Map<string, number>();
  for (const row of production) {
    if (!row.confirmed_at) continue;
    totals.set(row.commodity_id, (totals.get(row.commodity_id) ?? 0) + Number(row.quantity));
  }
  const quantityLines = Array.from(totals.entries())
    // A commodity with nothing installed is not news. Eighteen "0 ea" lines
    // bury the two that moved, and on the owner's copy they read as a claim
    // that the trade was worked and produced nothing.
    .filter(([, qty]) => qty !== 0)
    .map(([id, qty]) => {
      const c = label.get(id);
      return c ? `${c.label}: ${qty.toLocaleString()} ${c.uom}` : null;
    })
    .filter((s): s is string => Boolean(s))
    .sort();

  if (quantityLines.length) {
    lines.push("", "Quantities installed this week (confirmed):", ...quantityLines.map((l) => `  ${l}`));
  }

  return derive(
    lines.join("\n"),
    `${entries.length} narrative${entries.length === 1 ? "" : "s"} from ${dprs.length} field report${
      dprs.length === 1 ? "" : "s"
    } and ${logs.length} CM log entr${logs.length === 1 ? "y" : "ies"}${
      quantityLines.length ? `, plus ${quantityLines.length} confirmed commodity total${quantityLines.length === 1 ? "" : "s"}` : ""
    }.`,
    entries.map((e) => e.day),
  );
}

/**
 * Open schedule risks: the constraint log, plus anything flagged at risk on the
 * schedule, plus non-weather delays logged this week. Three different systems
 * of record for "what is going wrong", which is exactly why the box was being
 * filled from memory before.
 */
export function deriveRisks(
  constraints: WeeklyConstraint[],
  tasks: WeeklyTask[],
  delays: WeeklyDelay[],
  dprs: WeeklyDpr[],
  periodEnd: string,
): Derived<string> {
  const dprById = new Map(dprs.map((d) => [d.id, d]));
  const lines: string[] = [];

  const open = constraints
    .filter((c) => c.status === "open" || c.status === "in_progress")
    .sort((a, b) => (a.need_by ?? "9999") .localeCompare(b.need_by ?? "9999"));
  for (const c of open) {
    const late = c.need_by && c.need_by < periodEnd ? " PAST DUE" : "";
    lines.push(
      `${c.category}: ${c.title}${c.owner ? ` - owner ${c.owner}` : ""}${
        c.need_by ? ` - needed by ${dimensionDate(c.need_by)}${late}` : ""
      }`,
    );
  }

  const atRisk = tasks.filter((t) => t.is_at_risk && t.status !== "Complete");
  for (const t of atRisk) {
    lines.push(
      `Schedule: ${t.wbs_code} ${t.task_name} flagged at risk${
        t.pct_complete != null ? ` (at ${t.pct_complete}%)` : ""
      }.`,
    );
  }

  for (const d of delays) {
    const cause = d.cause_code.toLowerCase();
    if (cause.includes("weather") || cause.includes("ground")) continue; // reported under Environment
    const dpr = dprById.get(d.dpr_id);
    lines.push(
      `Delay ${dpr ? shortDay(dpr.report_date) : ""} - ${d.cause_code}${
        d.hours_lost ? ` (${d.hours_lost}h lost)` : ""
      }${d.narrative ? `: ${d.narrative}` : ""}`.trim(),
    );
  }

  return derive(
    lines.join("\n"),
    lines.length
      ? `${open.length} open constraint${open.length === 1 ? "" : "s"}, ${atRisk.length} task${
          atRisk.length === 1 ? "" : "s"
        } flagged at risk, ${delays.length} delay${delays.length === 1 ? "" : "s"} logged.`
      : "No open constraints, no tasks flagged at risk, and no delays logged in the period.",
  );
}

/**
 * Expected milestone dates. Matched off the schedule by name where a milestone
 * task exists, otherwise carried forward from last week's report - a date the
 * team agreed to last Monday is a better answer than a blank.
 */
export function deriveMilestones(
  tasks: WeeklyTask[],
  carriedForward: Record<string, string | null>,
  overrides: Record<string, string | null>,
): Record<MilestoneKey, Derived<string | null>> {
  const milestones = tasks.filter((t) => t.is_milestone && t.end_date);
  const out = {} as Record<MilestoneKey, Derived<string | null>>;

  for (const field of MILESTONE_FIELDS) {
    const override = overrides[field.key];
    if (override) {
      out[field.key] = derive(override, "Entered by hand.");
      continue;
    }
    const hit = milestones.find((t) =>
      field.match.some((m) => t.task_name.toLowerCase().includes(m)),
    );
    if (hit) {
      out[field.key] = derive(hit.end_date, `Schedule milestone ${hit.wbs_code} ${hit.task_name}.`);
      continue;
    }
    const carried = carriedForward[field.key];
    out[field.key] = carried
      ? derive(carried, "Carried forward from last week's report - no matching schedule milestone.")
      : derive(null, "No schedule milestone matches this name and no prior report to carry forward.");
  }
  return out;
}
