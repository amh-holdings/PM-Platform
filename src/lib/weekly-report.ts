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
  duration_days?: number | null;
  baseline_end?: string | null;
  is_milestone?: boolean | null;
  is_at_risk?: boolean | null;
};

export type WeeklyInspection = {
  inspection_type: string | null;
  title?: string | null;
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

export type WeeklyCommodity = {
  id: string;
  label: string;
  uom: string;
  /** Contract quantity, where the project has one. Null means unknown. */
  total_quantity?: number | null;
  /** False when the total is a placeholder nobody has confirmed. */
  total_verified?: boolean | null;
};

// The saved row. Every narrative field is null until somebody types over it.
export type WeeklyOverrides = {
  dimension_cm: string | null;
  epc_reporting_manager: string | null;
  epc_team: string | null;
  environment_concerns: string | null;
  security_concerns: string | null;
  safety_summary: string | null;
  photo_note: string | null;
  photo_keys: string[];
  position_note: string | null;
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
  /** Every field spelling folded into this row, when more than one. */
  variants?: string[];
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
 * The box holds one of two different things and they have to be told apart.
 *
 * A Sunday, Monday or Tuesday date is a FILING date: Sweet Springs hands the
 * form in on Monday for the week that ended the day before, so "week ending
 * 24-Aug-26" covers 17-23 Aug, not 18-24. Those walk back to the Sunday.
 *
 * Any other day is read as the last day of work itself. The old rule walked
 * every date back to the preceding Sunday, so a week-ending date of Friday
 * 21-Aug reported 10-16 Aug and SIX WORKED DAYS appeared in no report at all,
 * silently. A date late in the week means the week that ended on it.
 */
export function defaultPeriod(weekEnding: string): { start: string; end: string } {
  const dow = new Date(msOf(weekEnding)).getUTCDay(); // 0 Sun .. 6 Sat
  const end = dow === 0 ? weekEnding : dow <= 2 ? addDays(weekEnding, -dow) : weekEnding;
  return { start: addDays(end, -6), end };
}

/**
 * Worked days in the period with nothing filed against them.
 *
 * Weekends are not gaps. The old version walked every calendar day, so on a
 * five-day week the banner permanently read "2 days have no field report" -
 * which is how you train somebody to ignore the one week it means something.
 */
export function coverageGaps(
  start: string,
  end: string,
  covered: Set<string>,
  workWeek: 5 | 6,
  nonWorkDays: Set<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const day of eachDay(start, end)) {
    if (covered.has(day)) continue;
    const dow = new Date(msOf(day)).getUTCDay();
    if (dow === 0) continue; // Sunday is never a work day here
    if (dow === 6 && workWeek === 5) continue;
    if (nonWorkDays.has(day)) continue; // holiday or a shutdown on the calendar
    out.push(day);
  }
  return out;
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

// ---------------------------------------------------------------------------
// Equipment naming
// ---------------------------------------------------------------------------

// The DPR form takes the equipment name as free text, and one month of reports
// from a single crew produced THIRTY-FOUR spellings of about nine machines:
// "620 skidder", "Tigercat 620 skidder", "620 tigercat" and "620 tigercat
// skidder" are one skidder. Grouping on the exact string put every spelling on
// its own row, so the owner's Equipment table read as a fleet three times the
// size of the one standing on site.
//
// The model number is the signal that survives. A crew misspells the make and
// reorders the words, but they get "620" right - so the model is the primary
// key, split by make only when two spellings name DIFFERENT makes. Nothing is
// merged on a guess: what could not be matched stays on its own row rather
// than being folded into the nearest plausible machine.

/** Make spellings seen in the field, each mapped to one name. */
const EQUIPMENT_MAKES: [RegExp, string][] = [
  // Doosan renamed itself DEVELON in 2023, so the crew types both - plus
  // "Devlon", "Devolon" and "Dodson", which are the same machine again.
  [/\b(develon|devlon|devolon|devlone|doosan|dodson|deveon)/, "Develon"],
  [/\btiger\s*cat/, "Tigercat"],
  [/\b(caterpillar|cat)\b/, "Cat"],
  [/\b(john\s*deere|deere|jd)\b/, "John Deere"],
  [/\bkomatsu/, "Komatsu"],
  [/\bbobcat/, "Bobcat"],
  [/\bvolvo/, "Volvo"],
  [/\bkubota/, "Kubota"],
  [/\btakeuchi/, "Takeuchi"],
  [/\bhitachi/, "Hitachi"],
  [/\bcase\b/, "Case"],
];

/** Machine types, longest first so "mini excavator" beats "excavator". */
const EQUIPMENT_TYPES = [
  "mini excavator",
  "front end loader",
  "off road dump truck",
  "off road dumptruck",
  "knuckleboom",
  "knuckle boom",
  "skid steer",
  "dump truck",
  "dumptruck",
  "water truck",
  "bull dozer",
  "bulldozer",
  "telehandler",
  "excavator",
  "compactor",
  "trencher",
  "backhoe",
  "skidder",
  "forklift",
  "feller",
  "grader",
  "roller",
  "loader",
  "cutter",
  "dozer",
  "crane",
  "truck",
];

/**
 * Type spellings that mean the same machine. "Bulldozer" and "bull dozer" have
 * to land on one canonical word or the crew's two spellings never meet.
 */
const EQUIPMENT_TYPE_CANON: Record<string, string> = {
  bulldozer: "dozer",
  "bull dozer": "dozer",
  "knuckle boom": "knuckleboom",
  dumptruck: "dump truck",
  "off road dumptruck": "dump truck",
  "off road dump truck": "dump truck",
  "front end loader": "loader",
  feller: "cutter",
};

/** True when `word` is `target` with one character added, dropped or changed. */
function withinOneEdit(word: string, target: string): boolean {
  if (word === target) return true;
  if (Math.abs(word.length - target.length) > 1) return false;
  const [a, b] = word.length <= target.length ? [word, target] : [target, word];
  let i = 0;
  let j = 0;
  let slack = 1;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (slack-- === 0) return false;
    if (a.length === b.length) i++;
    j++;
  }
  return true;
}

export type EquipmentParts = {
  make: string | null;
  model: string | null;
  type: string | null;
  norm: string;
};

/** Pull the make, model and machine type out of one free-text name. */
export function parseEquipmentName(raw: string): EquipmentParts {
  const norm = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let make: string | null = null;
  for (const [re, name] of EQUIPMENT_MAKES) {
    if (re.test(norm)) {
      make = name;
      break;
    }
  }

  let type: string | null = null;
  for (const t of EQUIPMENT_TYPES) {
    if (norm.includes(t)) {
      type = EQUIPMENT_TYPE_CANON[t] ?? t;
      break;
    }
  }
  // Nothing matched cleanly - try again allowing one typo per word, because
  // "Devlon excvator" is the same excavator as "Devlon excavator" and a crew
  // typing on a phone in a field produces exactly this.
  if (!type) {
    for (const tok of norm.split(" ")) {
      if (tok.length < 5) continue;
      const hit = EQUIPMENT_TYPES.find((t) => !t.includes(" ") && withinOneEdit(tok, t));
      if (hit) {
        type = EQUIPMENT_TYPE_CANON[hit] ?? hit;
        break;
      }
    }
  }

  // The model number: a 2- or 3-digit run, optionally with a letter glued on
  // ("750k" is a 750). Four digits are not a model - that is somebody typing a
  // year into the wrong box.
  let model: string | null = null;
  for (const tok of norm.split(" ")) {
    const m = /^(\d{2,3})[a-z]?$/.exec(tok);
    if (m) {
      model = m[1];
      break;
    }
  }

  return { make, model, type, norm };
}

/**
 * How much a spelling tells you, used to pick the row's display name.
 *
 * The make-first bonus matters: "Develon 235" and "235 Develon1" carry the same
 * three facts, and without it the longer string wins and the owner's report is
 * headed with the typo.
 */
function nameScore(p: EquipmentParts, raw: string): number {
  const makeFirst = p.make && p.norm.startsWith(p.make.toLowerCase()) ? 0.5 : 0;
  return (
    (p.make ? 4 : 0) +
    (p.model ? 2 : 0) +
    (p.type ? 1 : 0) +
    makeFirst +
    Math.min(raw.length, 40) / 100
  );
}

/**
 * Fold the week's equipment spellings into one group per machine.
 *
 * Returns a map from raw name to group key, plus each group's display name and
 * the spellings that fed it - the spellings go on the form so a merge the crew
 * would disagree with is visible rather than buried.
 */
export function groupEquipmentNames(rawNames: string[]): {
  keyOf: Map<string, string>;
  display: Map<string, string>;
  variants: Map<string, string[]>;
} {
  const names = Array.from(new Set(rawNames.map((n) => n.trim()).filter(Boolean)));
  const parsed = new Map(names.map((n) => [n, parseEquipmentName(n)]));

  // Pass 1: everything with a model number, bucketed by model. A model claimed
  // by two different makes splits - a Cat 350 is not a Develon 350.
  const byModel = new Map<string, string[]>();
  const noModel: string[] = [];
  for (const n of names) {
    const p = parsed.get(n)!;
    if (!p.model) {
      noModel.push(n);
      continue;
    }
    const bucket = byModel.get(p.model) ?? [];
    bucket.push(n);
    byModel.set(p.model, bucket);
  }

  const keyOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  const add = (key: string, name: string) => {
    keyOf.set(name, key);
    const group = members.get(key) ?? [];
    group.push(name);
    members.set(key, group);
  };

  for (const [model, group] of Array.from(byModel.entries())) {
    const makes = Array.from(
      new Set(group.map((n) => parsed.get(n)!.make).filter((m): m is string => Boolean(m))),
    );
    if (makes.length <= 1) {
      for (const n of group) add(`m:${model}`, n);
      continue;
    }
    // Two makes share this model number. Split by make; a spelling that names
    // no make cannot be assigned, so it keeps its own row.
    for (const n of group) {
      const make = parsed.get(n)!.make;
      add(make ? `m:${model}|${make.toLowerCase()}` : `raw:${parsed.get(n)!.norm}`, n);
    }
  }

  // Pass 2: spellings with no model ("Knuckleboom", "Bulldozer", "Devlon
  // excavator"). Attach to an existing group only when exactly ONE group fits,
  // so an ambiguous name stays visible instead of joining the wrong machine.
  for (const n of noModel) {
    const p = parsed.get(n)!;
    const candidates = Array.from(members.entries()).filter(([, group]) => {
      const parts = group.map((g) => parsed.get(g)!);
      const makeOk = p.make ? parts.some((q) => q.make === p.make) : true;
      const typeOk = p.type ? parts.some((q) => q.type === p.type) : false;
      // A type match is required: a bare make matches every machine that make
      // built, which on this project is two different excavators.
      return makeOk && typeOk;
    });
    if (candidates.length === 1) add(candidates[0][0], n);
    else add(`raw:${p.norm}`, n);
  }

  const display = new Map<string, string>();
  const variants = new Map<string, string[]>();
  for (const [key, group] of Array.from(members.entries())) {
    const best = group
      .slice()
      .sort((a, b) => nameScore(parsed.get(b)!, b) - nameScore(parsed.get(a)!, a))[0];
    display.set(key, best);
    variants.set(key, group.slice().sort());
  }

  return { keyOf, display, variants };
}

/**
 * Plant on site, from the equipment lines on the week's field reports.
 *
 * One row per machine, not one row per spelling per day - see
 * `groupEquipmentNames`. Quantity is the peak day: two dozers on Tuesday and
 * none on Friday is "2 dozers", not "1". Idle equipment (`active` false) is
 * excluded - Dimension is asking what was working, and a broken-down machine
 * listed as plant on site overstates the resource.
 *
 * Within one day, identical spellings SUM (two lines of "620 skidder" is two
 * skidders) but different spellings in the same group take the MAX (a crew that
 * wrote "620 skidder" and "Tigercat 620" on the same report described one
 * machine twice). Summing across spellings is what double-counted the fleet.
 */
export function deriveEquipment(
  dprs: WeeklyDpr[],
  equipment: WeeklyEquipment[],
  overrides: Record<string, EquipmentOverride>,
  extras: EquipmentRow[],
): EquipmentRow[] {
  const dprById = new Map(dprs.map((d) => [d.id, d]));
  const live = equipment.filter((e) => e.active && e.equipment_name.trim() && dprById.has(e.dpr_id));
  const { keyOf, display, variants } = groupEquipmentNames(live.map((e) => e.equipment_name));

  // group -> day -> spelling -> quantity on that day under that spelling
  const perGroup = new Map<string, Map<string, Map<string, number>>>();
  for (const e of live) {
    const name = e.equipment_name.trim();
    const key = keyOf.get(name);
    if (!key) continue;
    const day = dprById.get(e.dpr_id)!.report_date;
    const days = perGroup.get(key) ?? new Map<string, Map<string, number>>();
    const spellings = days.get(day) ?? new Map<string, number>();
    spellings.set(name, (spellings.get(name) ?? 0) + (e.quantity ?? 1));
    days.set(day, spellings);
    perGroup.set(key, days);
  }

  const rows: EquipmentRow[] = [];
  for (const [key, days] of Array.from(perGroup.entries())) {
    const name = display.get(key) ?? key;
    const o = overrides[key] ?? overrides[name] ?? {};
    if (o.hidden) continue;

    const dayTotals = Array.from(days.values()).map((spellings) =>
      Math.max(...Array.from(spellings.values())),
    );
    const peak = dayTotals.length ? Math.max(...dayTotals) : null;
    const spelled = variants.get(key) ?? [name];

    rows.push({
      key,
      name,
      quantity: o.quantity ?? peak,
      overridden: o.quantity != null ? ["quantity"] : [],
      variants: spelled.length > 1 ? spelled : undefined,
      basis:
        o.quantity != null
          ? "Entered by hand."
          : `Peak of ${peak} on site across ${days.size} reported day${days.size === 1 ? "" : "s"}${
              spelled.length > 1
                ? `. Merged ${spelled.length} spellings from the field reports: ${spelled.join(", ")}`
                : ""
            }.`,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return [...rows, ...extras];
}

// ---------------------------------------------------------------------------
// Man-hours
// ---------------------------------------------------------------------------

export type ManHours = {
  week: number;
  cumulative: number;
  /** Days in the period that reported any hours at all. */
  days: number;
  /** True when the week's figure had to be built from crew x 8. */
  estimated: boolean;
};

/**
 * Man-hours worked, this week and to date.
 *
 * Every field report already carries `total_man_hours` and nothing read it.
 * Man-hours are standard on an owner's weekly report - they are how the owner
 * sees effort rather than headcount, and they are the denominator under every
 * safety statistic that gets quoted later. Reporting a crew of seven says
 * nothing about whether they worked two hours or ten.
 *
 * Cumulative is all-time through the end of the period, not a running total
 * kept in a column - so a corrected field report from three weeks ago fixes the
 * cumulative figure too.
 */
export function deriveManHours(
  periodDprs: WeeklyDpr[],
  allTimeDprs: { report_date: string; total_man_hours: number | null; crew_count: number | null }[],
  manpower: WeeklyManpower[],
  periodEnd: string,
): Derived<ManHours> {
  const byDpr = new Map<string, number>();
  for (const m of manpower) {
    byDpr.set(m.dpr_id, (byDpr.get(m.dpr_id) ?? 0) + m.regular_hours + m.ot_hours);
  }

  let estimated = false;
  const hoursOf = (d: {
    id?: string;
    total_man_hours: number | null;
    crew_count: number | null;
  }): number => {
    if (d.total_man_hours != null) return Number(d.total_man_hours);
    // The manpower breakdown, when the reporter filled one in.
    const fromCrew = d.id ? byDpr.get(d.id) : undefined;
    if (fromCrew) return fromCrew;
    // Last resort. Flagged, because a figure the owner may quote back at us
    // should not be a silent guess.
    if (d.crew_count != null) {
      estimated = true;
      return d.crew_count * 8;
    }
    return 0;
  };

  const perDay = new Map<string, number>();
  for (const d of periodDprs) {
    const h = hoursOf(d);
    if (!h) continue;
    perDay.set(d.report_date, (perDay.get(d.report_date) ?? 0) + h);
  }
  const week = Array.from(perDay.values()).reduce((a, b) => a + b, 0);

  const cumulative = allTimeDprs
    .filter((d) => d.report_date <= periodEnd)
    .reduce((n, d) => n + (d.total_man_hours != null ? Number(d.total_man_hours) : 0), 0);

  const round = (n: number) => Math.round(n * 10) / 10;
  return derive(
    { week: round(week), cumulative: round(cumulative), days: perDay.size, estimated },
    week === 0
      ? "No field report in the period recorded man-hours."
      : `${round(week)} hours across ${perDay.size} reported day${
          perDay.size === 1 ? "" : "s"
        }, ${round(cumulative)} to date${
          estimated ? ". Some days had no hours recorded and were estimated at crew x 8 - check them" : ""
        }.`,
    Array.from(perDay.keys()).sort(),
  );
}

// ---------------------------------------------------------------------------
// Environment, security, safety, weather
// ---------------------------------------------------------------------------

const NO_SECURITY_CONCERNS =
  "There were no security concerns or unauthorized access issues noted in any of the daily logs for this week.";

// Words that make a note a SECURITY matter. The box asks about site security -
// who got in, what went missing - and that is a different question from
// whether anybody got hurt.
const SECURITY_WORDS = [
  "unauthorized", "unauthorised", "trespass", "intruder", "theft", "stolen",
  "stole", "break in", "broke in", "break-in", "vandal", "graffiti", "security",
  "gate was open", "gate left open", "gate open", "fence cut", "cut the fence",
  "lock", "padlock", "missing tools", "missing equipment", "camera", "guard",
  "suspicious",
];

/**
 * Security concerns.
 *
 * The default is not blank, it is the sentence that says nothing happened -
 * and it is only written when the logs actually support it. An empty box on a
 * form the owner reads means "we did not fill this in"; the sentence means "we
 * checked". Those are different claims and the form should only make the
 * second one when it is true.
 *
 * SAFETY used to be answered in here too - the sentence claimed "no security
 * concerns, unauthorized access issues, or safety incidents", one sentence
 * answering three questions, and a flagged injury printed in this box. That is
 * the wrong place for it: an owner looking for the safety record does not read
 * the security box, and an injury filed there reads as a trespasser. Safety is
 * derived separately now and prints as its own row - see `deriveSafety`.
 */
export function deriveSecurity(
  dprs: WeeklyDpr[],
  logs: WeeklyCmLog[],
): Derived<string> {
  const findings: string[] = [];
  const sources: string[] = [];

  const consider = (day: string, label: string, text: string | null | undefined) => {
    const t = text?.trim();
    if (!t) return;
    if (!SECURITY_WORDS.some((w) => t.toLowerCase().includes(w))) return;
    findings.push(`${shortDay(day)} - ${label}: ${t}`);
    sources.push(day);
  };

  for (const d of dprs) {
    consider(d.report_date, "Field report", d.safety_narrative);
    consider(d.report_date, "Field report", d.work_narrative);
  }
  for (const l of logs) {
    consider(l.log_date, "CM log", l.safety_notes);
    consider(l.log_date, "CM log", l.progress_summary);
  }

  const seen = Array.from(new Set(sources)).sort();
  const reportCount = dprs.length + logs.length;

  if (findings.length) {
    return derive(
      findings.join("\n"),
      `${findings.length} note${findings.length === 1 ? "" : "s"} in the period mention site security. Read them before sending - a keyword match is not a finding.`,
      seen,
    );
  }

  if (reportCount === 0) {
    return derive(
      "",
      "No field reports or CM log entries in the period, so there is nothing to stand behind a no-concerns statement.",
    );
  }

  return derive(
    NO_SECURITY_CONCERNS,
    `Nothing in the ${reportCount} report${
      reportCount === 1 ? "" : "s"
    } filed this period mentions unauthorized access, theft or damage to site security. Safety is reported in its own box.`,
    seen,
  );
}

// A note only reaches the Safety box if it describes a hazard or an event.
const SAFETY_WORDS = [
  "injur", "first aid", "recordable", "lost time", "near miss", "close call",
  "incident", "accident", "hazard", "unsafe", "stop work", "stopped work",
  "ppe", "hard hat", "safety glasses", "harness", "fall protection", "tie off",
  "tie-off", "fell", "slip", "trip", "struck by", "struck", "pinch point",
  "laceration", "cut his", "cut her", "burn", "strain", "sprain", "fracture",
  "heat exhaustion", "heat stress", "dehydrat", "lockout", "loto", "hot work",
  "confined space", "arc flash", "trench collapse", "cave in", "cave-in",
  "spotter", "flagger", "exclusion zone", "backed into", "rollover",
  "overhead line", "electrocut", "shock", "citation", "osha",
];

function safetyHit(text: string): boolean {
  const hay = text.toLowerCase();
  return SAFETY_WORDS.some((w) => hay.includes(w));
}

/**
 * Safety, reported on its own.
 *
 * The incident FLAGS are the only thing that can contradict a clean week -
 * those are a deliberate act by the reporter.
 *
 * Free text is not. On Sweet Springs the CM uses `safety_notes` as a general
 * notepad and his POD minutes live there, so carrying every note under the
 * clean-week statement put "Pyramid is going to start hauling the brush out
 * today, they're going to make a new pile towards the center of the field" into
 * the owner's Safety box. Meeting minutes are not a safety matter. A note now
 * has to describe a hazard or an event to be carried, and everything else stays
 * in the evidence panel where the writer can still see it.
 *
 * The man-hours worked go in the clean-week sentence deliberately. "No
 * incidents" means something different across 283 hours than across 12, and the
 * owner is going to quote this number back in a safety statistic later.
 */
export function deriveSafety(
  dprs: WeeklyDpr[],
  logs: WeeklyCmLog[],
  manHours: ManHours,
): Derived<string> {
  const incidents: string[] = [];
  const notes: string[] = [];
  const sources: string[] = [];
  let skipped = 0;

  for (const d of dprs) {
    const flagged = d.safety_incident || d.near_miss;
    const text = d.safety_narrative?.trim();
    if (!flagged && !text) continue;
    if (flagged || safetyHit(text!)) sources.push(d.report_date);
    if (flagged) {
      const tag = d.safety_incident ? "Safety incident" : "Near miss";
      incidents.push(`${shortDay(d.report_date)} - ${tag}${text ? `: ${text}` : "."}`);
    } else if (safetyHit(text!)) {
      // A narrative with no flag against it: the reporter wrote something that
      // reads as a hazard but did not call it an incident.
      notes.push(`${shortDay(d.report_date)} - Field report note: ${text}`);
    } else {
      skipped++;
    }
  }
  for (const l of logs) {
    const text = l.safety_notes?.trim();
    if (!text) continue;
    if (!safetyHit(text)) {
      skipped++;
      continue;
    }
    notes.push(`${shortDay(l.log_date)} - CM log note: ${text}`);
    sources.push(l.log_date);
  }

  const seen = Array.from(new Set(sources)).sort();
  const hours = manHours.week
    ? `${manHours.week.toLocaleString()} man-hours worked this week`
    : "the hours worked this week";

  if (incidents.length) {
    const body = [...incidents, ...(notes.length ? ["", "Also noted:", ...notes] : [])];
    return derive(
      body.join("\n"),
      `${incidents.length} incident${incidents.length === 1 ? "" : "s"} flagged in the period${
        notes.length ? `, plus ${notes.length} unflagged hazard note${notes.length === 1 ? "" : "s"}` : ""
      }.${skipped ? ` ${skipped} non-safety note${skipped === 1 ? "" : "s"} left out.` : ""}`,
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

  const clean = `No injuries, recordable incidents or near misses were reported in ${hours}${
    manHours.cumulative ? `, or in ${manHours.cumulative.toLocaleString()} man-hours to date` : ""
  }.`;
  const body = notes.length
    ? [clean, "", "Noted in the logs:", ...notes].join("\n")
    : clean;
  return derive(
    body,
    `No incident flagged on any of the ${reportCount} report${reportCount === 1 ? "" : "s"} in the period.${
      notes.length
        ? ` ${notes.length} unflagged note${notes.length === 1 ? " reads" : "s read"} as a hazard and ${
            notes.length === 1 ? "is" : "are"
          } carried below the statement.`
        : ""
    }${
      skipped
        ? ` ${skipped} other note${skipped === 1 ? "" : "s"} in the safety boxes ${
            skipped === 1 ? "was" : "were"
          } left out as not being a safety matter - meeting minutes and general site notes. They are in the source entries beside this box.`
        : ""
    }`,
    seen,
  );
}

// Words that are an environmental event on their own.
const ENV_INCIDENT = [
  "spill", "spilled", "leak", "leaking", "hydraulic fluid", "diesel release",
  "fuel release", "contaminat", "hazmat", "hazardous material", "turbidity",
  "discharge", "notice of violation", "nov issued", "violation", "wetland",
  "endangered", "protected species", "nesting", "gopher tortoise", "tortoise",
  "archaeolog", "cultural resource", "asbestos", "dust complaint",
  "tracking offsite", "tracking off site", "mud on the road", "mud on road",
  "offsite tracking", "dewater", "turbid",
];

// Erosion-control nouns. Installing a silt fence is progress, not a concern -
// these only count when something has gone wrong with one.
const ENV_CONTROL = [
  "silt fence", "rock fence", "silt sock", "wattle", "check dam", "sediment",
  "basin", "diversion ditch", "erosion", "swppp", "inlet protection",
  "rip rap", "riprap", "stabiliz", "seeding", "matting",
];

const ENV_FAILURE = [
  "fail", "damag", "breach", "blew out", "blow out", "blowout", "washed",
  "wash out", "washout", "overtop", "deficien", "silted in", "clogged",
  "corrective", "not installed", "missing", "undermin", "collaps", "sloughed",
];

function envHit(text: string): boolean {
  const hay = text.toLowerCase();
  if (ENV_INCIDENT.some((w) => hay.includes(w))) return true;
  return (
    ENV_CONTROL.some((w) => hay.includes(w)) && ENV_FAILURE.some((w) => hay.includes(w))
  );
}

/**
 * Environment concerns - and specifically NOT the weather.
 *
 * This box used to be assembled from the CM's site-conditions notes plus every
 * weather delay, and on Sweet Springs that made it a straight restatement of
 * the Weather box: ten weeks of "Dry and good to go", "Wet muddy and slick".
 * Weather has its own box two rows up. An owner reading two boxes that say the
 * same thing learns to read neither.
 *
 * So this now reports environmental FINDINGS only, from three places: a
 * spill/wildlife/violation word anywhere in the week's notes, an erosion
 * control that FAILED (installing a silt fence is progress and belongs in Work
 * This Week - a silt fence that blew out belongs here), and any ESC or SWPPP
 * inspection in the period that did not pass.
 *
 * The box never prints blank. An empty box on a form the owner reads means "we
 * did not fill this in", which is a worse claim than the true one - so a clean
 * week gets a sentence that says what was actually checked and found nothing,
 * naming the notes searched and the erosion-control inspections passed. That is
 * a statement the logs CAN support, unlike a bare "no concerns".
 */
export function deriveEnvironment(
  logs: WeeklyCmLog[],
  dprs: WeeklyDpr[],
  delays: WeeklyDelay[],
  inspections: WeeklyInspection[],
  period: { start: string; end: string },
): Derived<string> {
  const dprById = new Map(dprs.map((d) => [d.id, d]));
  const lines: string[] = [];
  const sources: string[] = [];
  let scanned = 0;

  const consider = (day: string, label: string, text: string | null | undefined) => {
    const t = text?.trim();
    if (!t) return;
    scanned++;
    if (!envHit(t)) return;
    lines.push(`${shortDay(day)} - ${label}: ${t}`);
    sources.push(day);
  };

  for (const l of logs) {
    consider(l.log_date, "CM log", l.site_conditions);
    consider(l.log_date, "CM log", l.safety_notes);
  }
  for (const d of dprs) {
    consider(d.report_date, "Field report", d.work_narrative);
    consider(d.report_date, "Field report", d.safety_narrative);
  }

  // Environmental delays only. Weather and ground conditions are reported
  // under Weather, with the hours lost, rather than twice.
  for (const d of delays) {
    const cause = d.cause_code.toLowerCase();
    if (cause.includes("weather") || cause.includes("ground")) continue;
    if (!cause.includes("environ") && !cause.includes("spill") && !cause.includes("permit")) continue;
    const dpr = dprById.get(d.dpr_id);
    const when = dpr ? shortDay(dpr.report_date) : "In the period";
    lines.push(
      `${when} - ${d.cause_code}${d.hours_lost ? ` (${d.hours_lost}h lost)` : ""}${
        d.narrative ? `: ${d.narrative}` : "."
      }`,
    );
    if (dpr) sources.push(dpr.report_date);
  }

  // An ESC inspection that did not pass is an environmental finding whether or
  // not anybody wrote a note about it.
  let failedInspections = 0;
  let passedInspections = 0;
  for (const insp of inspections) {
    const when = (insp.decided_at ?? insp.submitted_at ?? insp.created_at ?? "").slice(0, 10);
    if (!when || when < period.start || when > period.end) continue;
    if (insp.status === "approved") {
      passedInspections++;
      continue;
    }
    failedInspections++;
    lines.push(
      `${shortDay(when)} - Erosion-control inspection not passed${
        insp.title ? `: ${insp.title}` : ""
      } (${insp.status}).`,
    );
    sources.push(when);
  }

  if (lines.length) {
    return derive(
      lines.join("\n"),
      `${lines.length} environmental finding${lines.length === 1 ? "" : "s"}${
        failedInspections ? `, including ${failedInspections} inspection not passed` : ""
      }. Weather is reported in its own box.`,
      Array.from(new Set(sources)).sort(),
    );
  }

  // Nothing found. Say so as a statement of what was checked, never as a blank.
  if (scanned === 0 && passedInspections === 0) {
    return derive(
      "No daily reports or inspections were filed for this period, so no environmental review can be stated.",
      "Nothing was filed in the period. The sentence says that rather than claiming a clean week nobody checked.",
    );
  }

  const said: string[] = ["No environmental concerns were identified this week."];
  const checked: string[] = [];
  if (scanned > 0) {
    said.push(
      `No spills, releases, erosion-control failures, wildlife or permit findings were reported in the ${scanned} daily report and CM log note${
        scanned === 1 ? "" : "s"
      } filed during the period.`,
    );
    checked.push(`${scanned} daily note${scanned === 1 ? "" : "s"}`);
  }
  if (passedInspections > 0) {
    said.push(
      `${
        passedInspections === 1
          ? "The erosion and sediment control inspection"
          : `All ${passedInspections} erosion and sediment control inspections`
      } carried out during the period passed.`,
    );
    checked.push(
      `${passedInspections} ESC inspection${passedInspections === 1 ? "" : "s"}`,
    );
  }
  return derive(
    said.join(" "),
    `Nothing environmental found in ${checked.join(
      " and ",
    )}. The box states what was checked rather than sitting empty, because a blank on the owner's copy reads as "not filled in". Weather is reported in its own box, not here.`,
    Array.from(new Set(sources)).sort(),
  );
}

/**
 * Weather, condensed to one line. The daily detail is on the field reports;
 * what the owner wants here is the shape of the week and the temperature band.
 *
 * Weather delays are counted HERE, with the hours lost. They used to be listed
 * under Environment Concerns, and when that box became findings-only the lost
 * time would have vanished from the report entirely - so it moved to the box
 * that is actually about weather, which is where an owner looks for it.
 */
export function deriveWeather(
  dprs: WeeklyDpr[],
  logs: WeeklyCmLog[],
  delays: WeeklyDelay[] = [],
): Derived<string> {
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

  // Weather and ground-condition delays, which are the same story: the ground
  // was too wet to work.
  const weatherDelays = delays.filter((d) => {
    const c = d.cause_code.toLowerCase();
    return c.includes("weather") || c.includes("ground");
  });
  const dprById = new Map(dprs.map((d) => [d.id, d]));
  const lostDays = new Set(
    weatherDelays.map((d) => dprById.get(d.dpr_id)?.report_date).filter(Boolean) as string[],
  );
  const lostHours = weatherDelays.reduce((n, d) => n + (d.hours_lost ?? 0), 0);
  const lost = weatherDelays.length
    ? ` ${lostDays.size || weatherDelays.length} day${
        (lostDays.size || weatherDelays.length) === 1 ? "" : "s"
      } affected by weather${lostHours ? ` (${lostHours}h lost)` : ""}.`
    : "";

  if (byDay.size === 0 && !highs.length && !lows.length) {
    return lost
      ? derive(lost.trim(), `No conditions recorded, but ${weatherDelays.length} weather delay logged.`)
      : derive("", "No weather recorded on any report in the period.");
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
    `${parts.join("; ")}.${band}${lost}`.replace(/^\.\s*/, "").trim(),
    `Conditions from ${byDay.size} reported day${byDay.size === 1 ? "" : "s"}${
      weatherDelays.length
        ? `, plus ${weatherDelays.length} weather delay${weatherDelays.length === 1 ? "" : "s"}`
        : ""
    }.`,
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

/**
 * SWPPP inspections, identified by type or title - both free text today.
 *
 * Matching only on the word "SWPPP" found NOTHING on Sweet Springs, so the box
 * read "no inspection is typed or titled as SWPPP" every week while the CM was
 * in fact inspecting erosion control constantly. His titles are
 * "5.1.1.6 Construct Basin 1 ESC" and "5.1.1.5 Silt/Rock Fence Install" - the
 * industry's own abbreviations, not the acronym the form happens to print.
 */
export function isSwppp(row: { inspection_type: string | null; title?: string | null }): boolean {
  const hay = ` ${`${row.inspection_type ?? ""} ${row.title ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, " ")
    .trim()} `;
  if (/(swppp|storm ?water|erosion|sediment|silt|rock fence)/.test(hay)) return true;
  // ESC (Erosion and Sediment Control) and E&S only as whole words - "esc"
  // as a substring also lives inside "escort" and "escalation".
  return / (esc|e&s) /.test(hay);
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * One narrative, tidied for joining into a sentence list.
 *
 * Deliberately does NOT touch the words. Everything Dimension reads here was
 * written by somebody standing on the site, and a rewrite that "improves" it is
 * a rewrite that can be wrong about what happened.
 */
function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
}

/**
 * Collapse a contractor's week into a sentence list.
 *
 * Repeats are merged, but ONLY when the two entries are identical once case,
 * punctuation and spacing are normalised. Numbers are deliberately part of the
 * key: "3 loads of pulpwood" and "7 loads of pulpwood" are different days'
 * work, and folding them together would report the wrong quantity.
 */
function condense(entries: { day: string; text: string }[]): string[] {
  const order: string[] = [];
  const groups = new Map<string, { text: string; days: string[] }>();
  for (const e of entries) {
    const text = tidy(e.text);
    if (!text) continue;
    const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
    const hit = groups.get(key);
    if (hit) {
      if (!hit.days.includes(e.day)) hit.days.push(e.day);
      continue;
    }
    groups.set(key, { text, days: [e.day] });
    order.push(key);
  }
  return order.map((key) => {
    const g = groups.get(key)!;
    return g.days.length > 1 ? `${g.text} (${g.days.length} days)` : g.text;
  });
}

/** Sentence-case the first character and leave the rest of the words alone. */
function joinClauses(clauses: string[]): string {
  if (!clauses.length) return "";
  const [first, ...rest] = clauses;
  const head = first.charAt(0).toUpperCase() + first.slice(1);
  const tail = rest.map((c) => {
    // Lowercase a leading word only when it is ordinary prose - an acronym or
    // a proper noun ("RCP", "Basin 1") keeps its capital.
    const w = c.split(" ")[0];
    return /^[A-Z][a-z]+$/.test(w) ? c.charAt(0).toLowerCase() + c.slice(1) : c;
  });
  return `${[head, ...tail].join("; ")}.`;
}

/**
 * Work this week, as a starting draft.
 *
 * This used to be a dated log - one line per report, seven or eight of them,
 * each prefixed with its day, then the quantities. It was complete and nobody
 * wanted to read it, which for the one box on the form the owner actually reads
 * is the wrong trade.
 *
 * So it is now grouped the way Dimension asks for it: a short paragraph per
 * contractor, days on site in the heading, identical repeats collapsed, and the
 * week's confirmed quantities underneath. The day-by-day detail has not gone
 * anywhere - it is in the evidence panel beside the box, which is where you
 * want it while you are writing rather than inside what you are writing.
 *
 * The CM log is deliberately NOT pasted in. It reads as a full internal daily
 * log - POD minutes, who he phoned, what a surveyor quoted per pole - and one
 * real week of it ran to nine hundred words that dwarfed every contractor
 * summary on the page. Worse, it is internal: a draft assembled from it carried
 * AHC's own subcontractor pricing into a document addressed to the owner. It
 * stays in the evidence panel beside the box, where the person writing can draw
 * on it deliberately, which is the only safe way for it to reach the owner.
 *
 * The one exception is a week where no contractor filed anything. A blank box
 * is worse than a long one, so the CM log fills it, dated, and the basis says
 * that is what happened.
 *
 * The words themselves are never rewritten. Only confirmed quantities are
 * totalled: a proposed figure has not been stood behind by anyone, and this
 * document goes to the owner.
 */
export function deriveWorkThisWeek(
  dprs: WeeklyDpr[],
  logs: WeeklyCmLog[],
  subs: WeeklySub[],
  production: WeeklyProduction[],
  commodities: WeeklyCommodity[],
): Derived<string> {
  const subName = new Map(subs.map((s) => [s.id, s.company_name]));

  // Bucket by who filed it, keeping first-seen order so the busiest crew is
  // not pushed below a one-note trade by an alphabetical sort.
  const buckets = new Map<string, { day: string; text: string }[]>();
  const daysOnSite = new Map<string, Set<string>>();
  const push = (who: string, day: string, text: string) => {
    const bucket = buckets.get(who) ?? [];
    bucket.push({ day, text });
    buckets.set(who, bucket);
    const days = daysOnSite.get(who) ?? new Set<string>();
    days.add(day);
    daysOnSite.set(who, days);
  };

  const dated = dprs
    .slice()
    .sort((a, b) => (a.report_date === b.report_date ? 0 : a.report_date < b.report_date ? -1 : 1));
  let entryCount = 0;
  for (const d of dated) {
    const text = d.work_narrative?.trim();
    if (!text) continue;
    entryCount++;
    push(d.subcontractor_id ? (subName.get(d.subcontractor_id) ?? "Field report") : "Field report", d.report_date, text);
  }
  const cmEntries = logs
    .slice()
    .sort((a, b) => (a.log_date < b.log_date ? -1 : 1))
    .filter((l) => l.progress_summary?.trim());
  // Only as a fallback - see the note above.
  const cmIsFallback = buckets.size === 0;
  if (cmIsFallback) {
    for (const l of cmEntries) {
      entryCount++;
      push("CM log", l.log_date, l.progress_summary!.trim());
    }
  }

  const lines: string[] = [];
  for (const [who, entries] of Array.from(buckets.entries())) {
    const days = daysOnSite.get(who)?.size ?? 0;
    if (who === "CM log") {
      // The fallback path. Kept dated and one line per day, because these
      // entries are long and running them together is unreadable.
      if (lines.length) lines.push("");
      lines.push("From the CM log:");
      for (const e of entries) lines.push(`${shortDay(e.day)} - ${tidy(e.text)}.`);
      continue;
    }
    const clauses = condense(entries);
    if (!clauses.length) continue;
    if (lines.length) lines.push("");
    lines.push(`${who} - ${days} day${days === 1 ? "" : "s"} on site:`, joinClauses(clauses));
  }

  const label = new Map(commodities.map((c) => [c.id, c]));
  const totals = new Map<string, number>();
  for (const row of production) {
    // Confirmed only. A proposed figure has not been stood behind by anyone and
    // this document goes to the owner.
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
    if (lines.length) lines.push("");
    lines.push("Quantities installed this week (confirmed):", ...quantityLines.map((l) => `  ${l}`));
  }

  const crews = Array.from(buckets.keys()).filter((k) => k !== "CM log").length;
  return derive(
    lines.join("\n"),
    cmIsFallback
      ? `No contractor filed a narrative this period, so the ${cmEntries.length} CM log entr${
          cmEntries.length === 1 ? "y is" : "ies are"
        } shown instead. The CM log is an internal record - read it before sending.`
      : `${entryCount} contractor narrative${entryCount === 1 ? "" : "s"} condensed into ${crews} summar${
          crews === 1 ? "y" : "ies"
        }${
          quantityLines.length
            ? `, with ${quantityLines.length} confirmed commodity total${quantityLines.length === 1 ? "" : "s"}`
            : ""
        }.${
          cmEntries.length
            ? ` The ${cmEntries.length} CM log entr${
                cmEntries.length === 1 ? "y is" : "ies are"
              } left out on purpose - it is an internal log. Read it in the source entries beside this box and pull in anything the owner should see.`
            : ""
        }`,
    dated.map((d) => d.report_date),
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

  let listedDelays = 0;
  for (const d of delays) {
    const cause = d.cause_code.toLowerCase();
    if (cause.includes("weather") || cause.includes("ground")) continue; // counted under Weather
    listedDelays++;
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
      // Counts the delays actually LISTED, not every delay in the period. The
      // basis said "3 delays logged" above a box showing one, because the
      // weather delays it had already excluded were still in the total.
      ? `${open.length} open constraint${open.length === 1 ? "" : "s"}, ${atRisk.length} task${
          atRisk.length === 1 ? "" : "s"
        } flagged at risk, ${listedDelays} non-weather delay${listedDelays === 1 ? "" : "s"} logged.`
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

// ---------------------------------------------------------------------------
// Turning an edited report back into overrides
// ---------------------------------------------------------------------------

// This is the write half of the derive/override contract and the reason the
// saved row stays a thin diff: a cell equal to what the platform derived is
// dropped, so a field report that lands on Tuesday can still move last week's
// number.
//
// The baseline MUST be the derivation with NO overrides applied. Diffing
// against the resolved view - the derivation with the human's own corrections
// already folded in - makes every unchanged override equal to its own baseline,
// so it is dropped, so the second Save silently erases the first Save's
// corrections. That bug shipped, and end date was the worst of it: the one
// column with no derivation at all, gone for good on the next save.

export type ContractorDiff = {
  overrides: Record<string, ContractorOverride>;
  extras: ContractorRow[];
};

export function diffContractors(
  submitted: ContractorRow[],
  base: ContractorRow[],
): ContractorDiff {
  const byKey = new Map(base.map((r) => [r.key, r]));
  const overrides: Record<string, ContractorOverride> = {};
  const extras: ContractorRow[] = [];
  const seen = new Set<string>();

  for (const row of submitted) {
    if (row.key.startsWith("manual:") || !byKey.has(row.key)) {
      // Typed in by hand and matching no sub on the project.
      if (!row.name.trim()) continue;
      extras.push({ ...row, key: row.key.startsWith("manual:") ? row.key : `manual:${row.name}` });
      continue;
    }
    const b = byKey.get(row.key)!;
    seen.add(row.key);
    const diff: ContractorOverride = {};
    if ((row.scope ?? "") !== (b.scope ?? "")) diff.scope = row.scope;
    if (row.headcount != null && row.headcount !== b.headcount) diff.headcount = row.headcount;
    if (row.lastOnsite && row.lastOnsite !== b.lastOnsite) diff.lastOnsite = row.lastOnsite;
    if (row.endDate !== b.endDate && row.endDate) diff.endDate = row.endDate;
    if (Object.keys(diff).length) overrides[row.key] = diff;
  }

  // A derived row the human deleted from the table is a deliberate omission,
  // recorded as hidden rather than forgotten - otherwise it reappears the next
  // time the derivation runs.
  for (const row of base) {
    if (row.key.startsWith("manual:") || seen.has(row.key)) continue;
    overrides[row.key] = { ...(overrides[row.key] ?? {}), hidden: true };
  }

  return { overrides, extras };
}

export type EquipmentDiff = {
  overrides: Record<string, EquipmentOverride>;
  extras: EquipmentRow[];
};

export function diffEquipment(
  submitted: EquipmentRow[],
  base: EquipmentRow[],
): EquipmentDiff {
  const byKey = new Map(base.map((r) => [r.key, r]));
  const overrides: Record<string, EquipmentOverride> = {};
  const extras: EquipmentRow[] = [];
  const seen = new Set<string>();

  for (const row of submitted) {
    if (row.key.startsWith("manual:") || !byKey.has(row.key)) {
      if (!row.name.trim()) continue;
      extras.push({ ...row, key: row.key.startsWith("manual:") ? row.key : `manual:${row.name}` });
      continue;
    }
    const b = byKey.get(row.key)!;
    seen.add(row.key);
    if (row.quantity != null && row.quantity !== b.quantity) {
      overrides[row.key] = { quantity: row.quantity };
    }
  }
  for (const row of base) {
    if (row.key.startsWith("manual:") || seen.has(row.key)) continue;
    overrides[row.key] = { ...(overrides[row.key] ?? {}), hidden: true };
  }
  return { overrides, extras };
}

/** Milestone dates that differ from the schedule-derived answer. */
export function diffMilestones(
  submitted: Record<string, string>,
  base: Record<MilestoneKey, Derived<string | null>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of MILESTONE_FIELDS) {
    const value = submitted[field.key];
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
    if (base[field.key]?.value === value) continue;
    out[field.key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Where the project actually stands
// ---------------------------------------------------------------------------

export type CommodityProgress = {
  label: string;
  uom: string;
  toDate: number;
  total: number | null;
  pct: number | null;
  /** True when `total` is a placeholder nobody has confirmed. */
  provisional: boolean;
};

export type ProjectPosition = {
  /** Duration-weighted percent complete across the schedule's leaf tasks. */
  pctComplete: number | null;
  tasksComplete: number;
  tasksTotal: number;
  plannedFinish: string | null;
  projectedFinish: string | null;
  /** Positive is late. */
  slipDays: number;
  /**
   * What the slip is measured against. "baseline" only when the schedule
   * actually has one - otherwise this is drift against the working plan, which
   * is a weaker claim and must not be reported as if it were a baseline.
   */
  finishBasis: "baseline" | "plan";
  commodities: CommodityProgress[];
};

/**
 * Leaf tasks only.
 *
 * A WBS is a tree and the parents carry the sum of their children's durations -
 * Sweet Springs has "5.1 Civil Construction" at 210 days sitting above the 20-
 * and 30-day activities that make it up. Weighting by duration across all 24
 * rows counts the same work three times over and hands the parents most of the
 * weight, so the percentage is not a percentage of anything.
 */
function leafTasks(tasks: WeeklyTask[]): WeeklyTask[] {
  const codes = tasks.map((t) => t.wbs_code);
  return tasks.filter((t) => !codes.some((c) => c !== t.wbs_code && c.startsWith(`${t.wbs_code}.`)));
}

/**
 * Percent complete, the projected finish, and quantities installed to date.
 *
 * The report covered last week and the next three and never said where the
 * project stands, which is the first thing an owner asks and the one number
 * they carry into their own reporting. All three parts are already in this
 * database and none of them were being read.
 *
 * Percent complete is weighted by DURATION, not a plain average of the
 * percentages. A plain average lets a one-day punch item count as much as a
 * six-week pile drive, which is how a project reads 40% complete in the week it
 * started. Milestones carry no duration and are excluded rather than counted as
 * zero-length work that is either 0% or 100%.
 *
 * The finish comes from the CPM projection, not from the latest end date on the
 * task list, so a task running late drags the finish the way it actually will.
 */
export function deriveProjectPosition(
  tasks: WeeklyTask[],
  cpm: { plannedFinish: string | null; projectedFinish: string | null; finishSlipDays: number },
  commodities: WeeklyCommodity[],
  productionToDate: WeeklyProduction[],
): Derived<ProjectPosition> {
  const work = leafTasks(tasks).filter((t) => !t.is_milestone && (t.duration_days ?? 0) > 0);
  const totalDuration = work.reduce((n, t) => n + (t.duration_days ?? 0), 0);
  const earned = work.reduce(
    (n, t) => n + (t.duration_days ?? 0) * ((t.pct_complete ?? 0) / 100),
    0,
  );
  const pctComplete = totalDuration > 0 ? Math.round((earned / totalDuration) * 1000) / 10 : null;
  const tasksComplete = work.filter(
    (t) => (t.pct_complete ?? 0) >= 100 || t.status === "Complete" || t.status === "complete",
  ).length;

  const byId = new Map(commodities.map((c) => [c.id, c]));
  const toDate = new Map<string, number>();
  for (const row of productionToDate) {
    // Confirmed only, same rule as the weekly totals.
    if (!row.confirmed_at) continue;
    toDate.set(row.commodity_id, (toDate.get(row.commodity_id) ?? 0) + Number(row.quantity));
  }

  const progress: CommodityProgress[] = [];
  for (const [id, qty] of Array.from(toDate.entries())) {
    if (qty === 0) continue;
    const c = byId.get(id);
    if (!c) continue;

    // A commodity measured in percent is ALREADY a percentage: the tracker
    // records daily percentage points and `total_quantity` is 1 as a
    // placeholder. Dividing by it reported Site Prep as 6002% complete.
    const isPercent = c.uom.trim() === "%";
    const rounded = Math.round(qty * 100) / 100;
    if (isPercent) {
      progress.push({
        label: c.label,
        uom: "%",
        toDate: rounded,
        total: null,
        pct: rounded,
        provisional: false,
      });
      continue;
    }

    const total = c.total_quantity != null && c.total_quantity > 0 ? Number(c.total_quantity) : null;
    progress.push({
      label: c.label,
      uom: c.uom,
      toDate: rounded,
      total,
      pct: total ? Math.round((qty / total) * 1000) / 10 : null,
      provisional: total != null && c.total_verified === false,
    });
  }
  progress.sort((a, b) => a.label.localeCompare(b.label));

  // Measure against the baseline when the schedule has one. Sweet Springs has
  // none set, so the only available comparison is the CPM's own planned pass -
  // a real statement ("nothing is currently forecast past its planned date")
  // but a weaker one than "against baseline", and it must not be dressed up as
  // the stronger claim.
  const baselines = tasks
    .map((t) => t.baseline_end)
    .filter((d): d is string => Boolean(d))
    .sort();
  const baselineFinish = baselines.length ? baselines[baselines.length - 1] : null;
  const finishBasis: "baseline" | "plan" = baselineFinish ? "baseline" : "plan";
  const slipDays =
    baselineFinish && cpm.projectedFinish
      ? Math.round((msOf(cpm.projectedFinish) - msOf(baselineFinish)) / DAY_MS)
      : cpm.finishSlipDays;

  const value: ProjectPosition = {
    pctComplete,
    tasksComplete,
    tasksTotal: work.length,
    plannedFinish: baselineFinish ?? cpm.plannedFinish,
    projectedFinish: cpm.projectedFinish,
    slipDays,
    finishBasis,
    commodities: progress,
  };

  if (!work.length) {
    return derive(value, "The schedule has no durationed work loaded, so percent complete cannot be calculated.");
  }

  const against = finishBasis === "baseline" ? "the baseline" : "the current plan";
  const slip =
    slipDays > 0
      ? `Projected finish is ${slipDays} day${slipDays === 1 ? "" : "s"} behind ${against}.`
      : slipDays < 0
        ? `Projected finish is ${Math.abs(slipDays)} day${
            Math.abs(slipDays) === 1 ? "" : "s"
          } ahead of ${against}.`
        : `Projected finish holds ${against}.${
            finishBasis === "plan" ? " No baseline is set on this schedule, so there is nothing stronger to measure against." : ""
          }`;

  return derive(
    value,
    `${pctComplete}% complete, weighted by task duration across ${work.length} activities (${tasksComplete} finished). ${slip}${
      progress.some((c) => c.provisional)
        ? " Some contract quantities are unverified placeholders and their percentages should be read as provisional."
        : ""
    }`,
  );
}

/** The Project Position box as prose, for the printed sheet. */
export function positionSentence(p: ProjectPosition): string {
  const bits: string[] = [];
  if (p.pctComplete != null) {
    bits.push(
      `The project is ${p.pctComplete}% complete by schedule duration, with ${p.tasksComplete} of ${p.tasksTotal} activities finished.`,
    );
  }
  if (p.projectedFinish) {
    const against = p.finishBasis === "baseline" ? "baseline" : "current plan";
    const slip =
      p.slipDays > 0
        ? ` (${p.slipDays} day${p.slipDays === 1 ? "" : "s"} behind ${against})`
        : p.slipDays < 0
          ? ` (${Math.abs(p.slipDays)} day${Math.abs(p.slipDays) === 1 ? "" : "s"} ahead of ${against})`
          : ` (holding ${against})`;
    bits.push(`Projected completion ${dimensionDate(p.projectedFinish)}${slip}.`);
  }

  const quantities = p.commodities.map((c) => {
    if (c.total != null && c.pct != null) {
      return `${c.label} ${c.toDate.toLocaleString()} of ${c.total.toLocaleString()} ${c.uom} (${c.pct}%)`;
    }
    return c.uom === "%"
      ? `${c.label} ${c.toDate.toLocaleString()}%`
      : `${c.label} ${c.toDate.toLocaleString()} ${c.uom}`;
  });
  if (quantities.length) {
    bits.push(`Installed to date: ${quantities.join("; ")}.`);
    // Said once. Repeating it on every line buries the lines.
    if (p.commodities.some((c) => c.provisional)) {
      bits.push(
        "Percentages against contract quantities are provisional - those totals are not yet verified.",
      );
    }
  }
  return bits.join("\n");
}

// ---------------------------------------------------------------------------
// Choosing the photos
// ---------------------------------------------------------------------------

export type PhotoCandidate = {
  /** "<source>:<id>", stable across weeks so a choice survives a reload. */
  key: string;
  day: string;
  /** Where it came from, in words the reader recognises. */
  who: string;
  caption: string | null;
  source: "inspection" | "cmlog" | "dpr";
  /**
   * The schedule activity this photo evidences - the WBS code off its
   * inspection title. Null for a CM log photo, which is not tied to an activity.
   */
  taskKey?: string | null;
  /** Which side filed it. AHC is our own verification, sub is what they sent. */
  side?: "ahc" | "sub" | null;
};

/**
 * Ceiling on the automatic selection. One per activity is the rule and a week
 * rarely has more than a handful, but a schedule with thirty activities running
 * at once should not silently produce a fifteen-page photo section.
 */
export const PHOTO_AUTO_LIMIT = 12;

/**
 * The automatic selection: ONE photo per activity worked.
 *
 * The earlier rule spread photos evenly across the days of the week, which
 * answered "what did each day look like". That is not what the page is for. The
 * owner is reading a progress report activity by activity - Basin 1, Basin 2,
 * debris haul, laydown yard - so one photo per activity is the page they want,
 * and eleven shots of Thursday is not.
 *
 * The activity is the WBS code off the photo's inspection. That deliberately
 * groups the SAME activity inspected twice in a week into one row: Basin 1 ESC
 * signed off on Monday and again on Wednesday is one activity, not two.
 *
 * Within an activity: the LATEST day wins, because it shows how far the work
 * actually got, and AHC's own verification photo is preferred over the sub's
 * submission on our own outbound document.
 *
 * CM daily log photos carry no activity. They are the bulk of what gets
 * uploaded (47 of 64 in one real week) and are general site shots, so they are
 * not auto-selected while any activity photo exists - they stay one click away
 * in the picker. A week with no inspection photos at all falls back to a spread
 * across the days, because a blank photo page is worse than a general one.
 */
export function autoSelectPhotos(
  candidates: PhotoCandidate[],
  limit = PHOTO_AUTO_LIMIT,
): string[] {
  const byTask = new Map<string, PhotoCandidate[]>();
  for (const c of candidates) {
    if (!c.taskKey) continue;
    const bucket = byTask.get(c.taskKey) ?? [];
    bucket.push(c);
    byTask.set(c.taskKey, bucket);
  }

  if (byTask.size > 0) {
    // WBS order, so the page reads down the schedule rather than at random.
    const tasks = Array.from(byTask.keys()).sort(compareWbs);
    const chosen: string[] = [];
    for (const task of tasks) {
      if (chosen.length >= limit) break;
      const best = byTask.get(task)!.slice().sort((a, b) => {
        if (a.day !== b.day) return a.day < b.day ? 1 : -1; // latest first
        const rank = (x: PhotoCandidate) => (x.side === "ahc" ? 0 : 1);
        return rank(a) - rank(b) || a.key.localeCompare(b.key);
      })[0];
      chosen.push(best.key);
    }
    return chosen;
  }

  // No activity photos this week. Spread the general shots across the days that
  // have them - every day gets one before any day gets two.
  const byDay = new Map<string, PhotoCandidate[]>();
  for (const c of candidates) {
    const bucket = byDay.get(c.day) ?? [];
    bucket.push(c);
    byDay.set(c.day, bucket);
  }
  const days = Array.from(byDay.keys()).sort();
  for (const day of days) {
    byDay.get(day)!.sort((a, b) => a.key.localeCompare(b.key));
  }
  const chosen: string[] = [];
  let round = 0;
  while (chosen.length < limit) {
    let tookOne = false;
    for (const day of days) {
      const bucket = byDay.get(day)!;
      if (round >= bucket.length) continue;
      chosen.push(bucket[round].key);
      tookOne = true;
      if (chosen.length >= limit) break;
    }
    if (!tookOne) break;
    round++;
  }
  return chosen;
}

/** Sort WBS codes numerically per segment, so 5.1.1.10 follows 5.1.1.9. */
export function compareWbs(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const c = (pa[i] ?? "").localeCompare(pb[i] ?? "");
      if (c) return c;
      continue;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Which photos the report prints, in the order they print.
 *
 * Activity photos come first, in WBS order, so the page reads down the schedule
 * the same way the rest of the report does - not in upload order, and not in
 * date order, which scattered Basin 1 and Basin 2 either side of the debris
 * haul. General site shots follow, by date.
 *
 * A saved choice wins over the automatic selection. A key that no longer
 * matches a candidate is dropped rather than printed as a gap, because a photo
 * can be deleted from its inspection after the report was drafted.
 */
export function selectPhotoKeys(
  candidates: PhotoCandidate[],
  saved: string[],
): string[] {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const keys = saved.length ? saved : autoSelectPhotos(candidates);
  return keys
    .filter((k) => byKey.has(k))
    .sort((a, b) => {
      const x = byKey.get(a)!;
      const y = byKey.get(b)!;
      if (x.taskKey && y.taskKey) return compareWbs(x.taskKey, y.taskKey) || a.localeCompare(b);
      if (x.taskKey) return -1;
      if (y.taskKey) return 1;
      return x.day === y.day ? a.localeCompare(b) : x.day < y.day ? -1 : 1;
    });
}
