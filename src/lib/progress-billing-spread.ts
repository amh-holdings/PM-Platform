// How a percent-complete SOV line is forecast across months.
//
// Phil, on Sussex: "with Dimension we only bill what is completed which is
// what our subs would bill us as well." The projection billed every SOV line
// in one lump on its task's planned finish, which is right for a milestone
// (Mechanical Completion) and wrong for install work. 7.02 AC/DC Wire is
// $814,540 of work done May through August; billed as a lump it all landed in
// August while the cost of doing it went out every month, and that gap was
// most of a -$1.13M low point.
//
// A line marked billing_method = 'progress' (migration 0076) is spread over
// the calendar days of the tasks it links to, in proportion to the days in
// each month - the same weighting map-sussex-to-schedule uses for cost, so
// the two sides of the same work move together.

export type SpreadTask = {
  start_date: string | null;
  end_date: string | null;
};

const DAY = 86_400_000;

function utc(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7) + "-01";
}

export function isProgressBilled(line: { billing_method?: string | null }): boolean {
  return line.billing_method === "progress";
}

/**
 * The amount split by month across the union of the tasks' date ranges, as
 * [first-of-month ISO, amount] pairs in date order. A day two tasks share is
 * counted once. Rounded to cents with the remainder on the last month, so
 * the parts always add back to the amount exactly.
 *
 * Empty when no task has both dates; the caller falls back to the finish
 * month, so the money is never dropped.
 */
export function spreadByTaskDays(
  amount: number,
  tasks: readonly SpreadTask[],
): [string, number][] {
  const days = new Set<number>();
  for (const t of tasks) {
    if (!t.start_date || !t.end_date) continue;
    const a = utc(t.start_date);
    const b = utc(t.end_date);
    for (let x = Math.min(a, b); x <= Math.max(a, b); x += DAY) days.add(x);
  }
  if (days.size === 0) return [];

  const perMonth = new Map<string, number>();
  for (const x of Array.from(days)) perMonth.set(monthOf(x), (perMonth.get(monthOf(x)) ?? 0) + 1);
  const months = Array.from(perMonth.keys()).sort();

  const out: [string, number][] = [];
  let used = 0;
  months.forEach((m, i) => {
    const share =
      i === months.length - 1
        ? Math.round((amount - used) * 100) / 100
        : Math.round((amount * perMonth.get(m)!) / days.size * 100) / 100;
    used += share;
    out.push([m, share]);
  });
  return out;
}
