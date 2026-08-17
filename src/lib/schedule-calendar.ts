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

export type WorkWeek = 5 | 6;

const DAY_MS = 86_400_000;

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

export function isWorkingDay(iso: string, workWeek: WorkWeek = 5): boolean {
  const ms = parseIso(iso);
  const dow = new Date(ms).getUTCDay();
  if (dow === 0) return false;                 // Sunday is never worked
  if (dow === 6 && workWeek === 5) return false;
  return !holidays(Number(iso.slice(0, 4))).has(iso);
}

// Next working day at or after the given date.
export function snapForward(iso: string, workWeek: WorkWeek = 5): string {
  let ms = parseIso(iso);
  for (let guard = 0; guard < 400; guard++) {
    const candidate = toIso(ms);
    if (isWorkingDay(candidate, workWeek)) return candidate;
    ms += DAY_MS;
  }
  return iso;
}

// Previous working day at or before the given date.
export function snapBack(iso: string, workWeek: WorkWeek = 5): string {
  let ms = parseIso(iso);
  for (let guard = 0; guard < 400; guard++) {
    const candidate = toIso(ms);
    if (isWorkingDay(candidate, workWeek)) return candidate;
    ms -= DAY_MS;
  }
  return iso;
}

// Add working days to a date. addWorkingDays(start, 1) is the same day when
// start is a working day, matching how durations are quoted in the field: a
// one-day task starts and finishes on the same day.
export function addWorkingDays(
  iso: string,
  days: number,
  workWeek: WorkWeek = 5,
): string {
  if (days <= 0) return snapForward(iso, workWeek);
  let current = snapForward(iso, workWeek);
  let remaining = days - 1;
  while (remaining > 0) {
    current = toIso(parseIso(current) + DAY_MS);
    current = snapForward(current, workWeek);
    remaining--;
  }
  return current;
}

// Inclusive count of working days from a to b. Negative when b precedes a,
// which is what variance reporting needs: a task finishing early reads as a
// negative slip.
export function workingDaysBetween(
  a: string,
  b: string,
  workWeek: WorkWeek = 5,
): number {
  if (a === b) return 0;
  const forward = parseIso(a) <= parseIso(b);
  const from = forward ? a : b;
  const to = forward ? b : a;
  let count = 0;
  let ms = parseIso(from);
  const end = parseIso(to);
  while (ms < end) {
    ms += DAY_MS;
    if (isWorkingDay(toIso(ms), workWeek)) count++;
  }
  return forward ? count : -count;
}

// Working days a task spans, inclusive of both ends.
export function durationInWorkingDays(
  start: string,
  end: string,
  workWeek: WorkWeek = 5,
): number {
  return Math.max(1, workingDaysBetween(start, end, workWeek) + 1);
}
