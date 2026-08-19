// What a field crew is offered when they pin a day's work to the schedule.
//
// The pin -> schedule_task link is the first hop in the chain that ends at a
// dollar figure on the owner's G702, so what the picker offers decides what the
// AFP can defensibly bill. Sweet Springs' August is the worked example of it
// going wrong: eleven approved reports, every one of them describing timber
// processing and stump haul-off, and not one pinned to
// "5.1.2.10 Timber processing and wood chip haul-off". The crew picked what the
// form put in front of them - a flat list of all 30 tasks in raw wbs_code order
// with the summary rows mixed in.
//
// Two rules fix that:
//   1. Summary rows are not selectable. A parent's percent is a rollup, and
//      pinning to one writes a meaningless number straight onto the schedule
//      via applyPinProgressToSchedule. Only leaf tasks represent real work.
//   2. Tasks actually in play sort first. A crew scrolling a 30-row list picks
//      something near the top that looks close enough.

export type PickerTask = {
  id: string;
  wbsCode: string;
  taskName: string;
  phase: string | null;
  currentStatus: string | null;
  currentPct: number | null;
  startDate: string | null;
  endDate: string | null;
};

export type PickerGroup = "open" | "soon" | "other";

export const PICKER_GROUP_LABEL: Record<PickerGroup, string> = {
  open: "Open now",
  soon: "Starting soon / just finished",
  other: "Everything else",
};

/** Days either side of the reference date that still count as "soon". */
const SOON_WINDOW_DAYS = 14;

/**
 * Natural WBS ordering, so 5.1.1.2 comes before 5.1.1.10.
 * Plain string sort puts "5.1.1.10" before "5.1.1.2", which is how the picker
 * ended up showing deep Phase-1 detail above the tasks in progress.
 */
export function compareWbsCodes(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const c = (pa[i] ?? "").localeCompare(pb[i] ?? "");
      if (c !== 0) return c;
      continue;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** WBS codes that are some other task's parent, i.e. summary rows. */
export function summaryCodesOf(
  tasks: Array<{ parent_wbs_code?: string | null }>,
): Set<string> {
  const parents = new Set<string>();
  for (const t of tasks) {
    if (t.parent_wbs_code) parents.add(t.parent_wbs_code);
  }
  return parents;
}

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.round((a - b) / 86_400_000);
}

/**
 * Which bucket a task belongs in, relative to the day being reported on.
 *
 * "open" is deliberately broad: anything already In Progress, or whose planned
 * window contains the report date. A crew reporting a day's work is almost
 * always working one of these, so they belong at the top of the list.
 */
export function groupForTask(task: PickerTask, refIso: string): PickerGroup {
  const status = (task.currentStatus ?? "").toLowerCase();
  if (status.includes("progress")) return "open";
  if (
    task.startDate &&
    task.endDate &&
    task.startDate <= refIso &&
    refIso <= task.endDate
  ) {
    return "open";
  }
  if (task.startDate && daysBetween(task.startDate, refIso) > 0) {
    // Starts in the future.
    if (daysBetween(task.startDate, refIso) <= SOON_WINDOW_DAYS) return "soon";
    return "other";
  }
  if (task.endDate && daysBetween(refIso, task.endDate) >= 0) {
    // Ended on or before the reference date.
    if (daysBetween(refIso, task.endDate) <= SOON_WINDOW_DAYS) return "soon";
    return "other";
  }
  return "other";
}

const GROUP_RANK: Record<PickerGroup, number> = { open: 0, soon: 1, other: 2 };

/**
 * Leaf tasks only, ordered so what the crew is most likely working on is first.
 * `refIso` is the report date (YYYY-MM-DD), not necessarily today - a report
 * filed late still gets the picker its own day would have shown.
 */
export function buildTaskPicker<
  T extends PickerTask & { parentWbsCode?: string | null },
>(
  tasks: T[],
  summaryCodes: Set<string>,
  refIso: string,
): Array<T & { group: PickerGroup }> {
  return tasks
    .filter((t) => !summaryCodes.has(t.wbsCode))
    .map((t) => ({ ...t, group: groupForTask(t, refIso) }))
    .sort((a, b) => {
      const g = GROUP_RANK[a.group] - GROUP_RANK[b.group];
      if (g !== 0) return g;
      return compareWbsCodes(a.wbsCode, b.wbsCode);
    });
}
