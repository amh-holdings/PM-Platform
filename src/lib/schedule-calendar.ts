// Working-day calendar for schedule math.
//
// Every date on the schedule is a plain ISO 'YYYY-MM-DD' string with no time
// component, so all arithmetic here runs in UTC. Doing it in local time makes
// a task silently shift a day for anyone east or west of the server.
//
// Construction schedules are worked in working days, not calendar days. Dennis
// Brookman's look-aheads run Monday to Friday and skip Labor Day; without a
// calendar the app would happily land a finish date on a Saturday and then
// compound the error through every downstream task.
//
// A calendar is a work week plus two exception sets, and the direction of each
// matters. `nonWorking` removes a day that would otherwise be worked - a rain
// day, a shutdown, a holiday this crew takes that the built-in list does not.
// `working` adds one back - a Saturday recovery push, working through Labor
// Day. Civil solar work is weather-driven, so rain days are the single most
// common reason a week disappears and there has to be somewhere to put them.
//
// Every function accepts either a full Calendar or a bare work week, so the
// older call sites that pass 5 or 6 keep working unchanged.

export type WorkWeek = 5 | 6;

export type Calendar = {
  workWeek: WorkWeek;
  /** Days NOT worked that otherwise would be. Rain, shutdown, extra holiday. */
  nonWorking: ReadonlySet<string>;
  /** Days worked that otherwise would not be. Saturday push, worked holiday. */
  working: ReadonlySet<string>;
};

export type CalendarLike = Calendar | WorkWeek | null | undefined;

const DAY_MS = 86_400_000;
const EMPTY: ReadonlySet<string> = new Set<string>();

// The two bare work weeks, allocated once. toCalendar() runs inside every date
// loop in the CPM engine, so it must not build a new object per call.
const PLAIN_5: Calendar = { workWeek: 5, nonWorking: EMPTY, working: EMPTY };
const PLAIN_6: Calendar = { workWeek: 6, nonWorking: EMPTY, working: EMPTY };

export const DEFAULT_CALENDAR = PLAIN_5;

export type CalendarException = {
  exception_date: string;
  kind: "nonworking" | "working";
};

export function makeCalendar(
  workWeek: WorkWeek,
  exceptions: CalendarException[] = [],
): Calendar {
  if (!exceptions.length) return workWeek === 6 ? PLAIN_6 : PLAIN_5;
  const nonWorking = new Set<string>();
  const working = new Set<string>();
  for (const e of exceptions) {
    if (e.kind === "working") working.add(e.exception_date);
    else nonWorking.add(e.exception_date);
  }
  return { workWeek, nonWorking, working };
}

export function toCalendar(cal: CalendarLike): Calendar {
  if (cal == null) return PLAIN_5;
  if (cal === 5) return PLAIN_5;
  if (cal === 6) return PLAIN_6;
  return cal as Calendar;
}

export function parseIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// nth weekday of a month, e.g. nthWeekday(2026, 9, 1, 1) = first Monday in
// September. A negative n counts back from the end of the month.
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = Date.UTC(year, month - 1, 1);
    const shift = (weekday - new Date(first).getUTCDay() + 7) % 7;
    return first + (shift + (n - 1) * 7) * DAY_MS;
  }
  const last = Date.UTC(year, month, 0);
  const shift = (new Date(last).getUTCDay() - weekday + 7) % 7;
  return last - (shift + (-n - 1) * 7) * DAY_MS;
}

// Holidays a US construction site actually takes. Deliberately shorter than the
// federal list - crews generally work Columbus Day and Veterans Day, and
// scheduling around holidays nobody takes pushes finish dates out for no reason.
// A project that works one of these overrides it with a `working` exception.
function holidaysFor(year: number): Set<string> {
  const out = new Set<string>();
  const add = (ms: number) => out.add(toIso(ms));

  // Fixed-date holidays roll to the nearest weekday when they land on one.
  const observed = (month: number, day: number) => {
    const ms = Date.UTC(year, month - 1, day);
    const dow = new Date(ms).getUTCDay();
    if (dow === 0) return ms + DAY_MS; // Sunday -> Monday
    if (dow === 6) return ms - DAY_MS; // Saturday -> Friday
    return ms;
  };

  add(observed(1, 1));                     // New Year's Day
  add(nthWeekday(year, 5, 1, -1));         // Memorial Day, last Monday in May
  add(observed(7, 4));                     // Independence Day
  add(nthWeekday(year, 9, 1, 1));          // Labor Day, first Monday in September
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  add(thanksgiving);                       // Thanksgiving
  add(thanksgiving + DAY_MS);              // and the Friday after
  add(observed(12, 25));                   // Christmas Day

  return out;
}

const holidayCache = new Map<number, Set<string>>();
function holidays(year: number): Set<string> {
  let h = holidayCache.get(year);
  if (!h) { h = holidaysFor(year); holidayCache.set(year, h); }
  return h;
}

/** True when the built-in list treats this date as a holiday, exceptions aside. */
export function isStandardHoliday(iso: string): boolean {
  return holidays(Number(iso.slice(0, 4))).has(iso);
}

export function isWorkingDay(iso: string, cal: CalendarLike = 5): boolean {
  const c = toCalendar(cal);
  // An explicit "worked" exception beats everything, including Sunday. That is
  // the point of it: the crew was on site.
  if (c.working.has(iso)) return true;
  if (c.nonWorking.has(iso)) return false;
  const dow = new Date(parseIso(iso)).getUTCDay();
  if (dow === 0) return false;                 // Sunday is never worked
  if (dow === 6 && c.workWeek === 5) return false;
  return !holidays(Number(iso.slice(0, 4))).has(iso);
}

// Next working day at or after the given date.
export function snapForward(iso: string, cal: CalendarLike = 5): string {
  const c = toCalendar(cal);
  let ms = parseIso(iso);
  for (let guard = 0; guard < 400; guard++) {
    const candidate = toIso(ms);
    if (isWorkingDay(candidate, c)) return candidate;
    ms += DAY_MS;
  }
  return iso;
}

// Previous working day at or before the given date.
export function snapBack(iso: string, cal: CalendarLike = 5): string {
  const c = toCalendar(cal);
  let ms = parseIso(iso);
  for (let guard = 0; guard < 400; guard++) {
    const candidate = toIso(ms);
    if (isWorkingDay(candidate, c)) return candidate;
    ms -= DAY_MS;
  }
  return iso;
}

// Add working days to a date. addWorkingDays(start, 1) is the same day when
// start is a working day, matching how durations are quoted in the field: a
// one-day task starts and finishes on the same day.
//
// Zero or fewer days snaps forward without consuming a day, which is what a
// milestone needs - it marks an instant and occupies no working time.
export function addWorkingDays(
  iso: string,
  days: number,
  cal: CalendarLike = 5,
): string {
  const c = toCalendar(cal);
  if (days <= 0) return snapForward(iso, c);
  let current = snapForward(iso, c);
  let remaining = days - 1;
  while (remaining > 0) {
    current = toIso(parseIso(current) + DAY_MS);
    current = snapForward(current, c);
    remaining--;
  }
  return current;
}

// Subtract working days. subWorkingDays(iso, 0) snaps back onto a working day
// without consuming one.
//
// The count is taken from the raw date rather than from its snapped-back
// position, which matters when the input lands on a non-working day: one
// working day before Labor Day is the Friday before it, not the Thursday. The
// mirror of addWorkingDays, where 0 and 1 both mean "the same day" once the
// date is snapped.
export function subWorkingDays(
  iso: string,
  days: number,
  cal: CalendarLike = 5,
): string {
  const c = toCalendar(cal);
  if (days <= 0) return snapBack(iso, c);
  let ms = parseIso(iso);
  let left = days;
  for (let guard = 0; left > 0 && guard < 4000; guard++) {
    ms -= DAY_MS;
    if (isWorkingDay(toIso(ms), c)) left--;
  }
  return snapBack(toIso(ms), c);
}

// Signed offsets, used for relationship lag. These are exact mirrors of each
// other, which addWorkingDays and subWorkingDays are not: add is inclusive
// (add 1 day = the same day) while sub is exclusive (sub 1 day = the previous
// day). Lag arithmetic needs a single consistent origin or the forward and
// backward passes disagree, and a negative lag - a LEAD, which the predecessor
// editor allows - has to move in the other direction rather than collapsing to
// zero.
//
//   advance(x, 0) === x   advance(x, 2) === two working days after x
//   retreat(x, 0) === x   retreat(x, 2) === two working days before x
//
// A negative count flips to the other function.
export function advance(iso: string, days: number, cal: CalendarLike = 5): string {
  const c = toCalendar(cal);
  if (days < 0) return retreat(iso, -days, c);
  return addWorkingDays(iso, days + 1, c);
}

export function retreat(iso: string, days: number, cal: CalendarLike = 5): string {
  const c = toCalendar(cal);
  if (days < 0) return advance(iso, -days, c);
  return subWorkingDays(iso, days, c);
}

// Inclusive count of working days from a to b. Negative when b precedes a,
// which is what variance reporting needs: a task finishing early reads as a
// negative slip.
export function workingDaysBetween(
  a: string,
  b: string,
  cal: CalendarLike = 5,
): number {
  if (a === b) return 0;
  const c = toCalendar(cal);
  const forward = parseIso(a) <= parseIso(b);
  const from = forward ? a : b;
  const to = forward ? b : a;
  let count = 0;
  let ms = parseIso(from);
  const end = parseIso(to);
  while (ms < end) {
    ms += DAY_MS;
    if (isWorkingDay(toIso(ms), c)) count++;
  }
  return forward ? count : -count;
}

// Working days a task spans, inclusive of both ends.
export function durationInWorkingDays(
  start: string,
  end: string,
  cal: CalendarLike = 5,
): number {
  return Math.max(1, workingDaysBetween(start, end, cal) + 1);
}
