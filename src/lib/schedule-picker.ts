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
//   3. Every option names its parent. Sweet Springs' September is the second
//      worked example: "Construct Basin 1 ESC" and "Construct Basin 2 ESC" each
//      carry a leaf called "Embankment", so the list offered two entries
//      reading "5.1.1.6.5 Embankment" and "5.1.1.7.5 Embankment". Four of six
//      reports between 09-09 and 09-15 described Basin 1 work and pinned Basin
//      2's row. Telling them apart meant decoding one digit of a WBS code on a
//      phone, so the label leads with the parent instead: "Basin 1 ESC /
//      Embankment". `nameIsAmbiguous` marks the leaves that actually collide so
//      the UI can flag them harder than the rest.

export type PickerTask = {
  id: string;
  wbsCode: string;
  taskName: string;
  phase: string | null;
  currentStatus: string | null;
  currentPct: number | null;
  startDate: string | null;
  endDate: string | null;
  parentWbsCode?: string | null;
};

/** What the picker renders for one option, parent first. */
export type PickerLabel = {
  /** Immediate parent's task name, e.g. "Construct Basin 1 ESC". */
  parentName: string | null;
  /** True when another selectable leaf shares this exact task name. */
  nameIsAmbiguous: boolean;
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
): Array<T & { group: PickerGroup } & PickerLabel> {
  // Built from the FULL list, summary rows included - a leaf's parent is by
  // definition a summary row, so resolving the name after the filter would
  // always come back empty.
  const nameByCode = new Map(tasks.map((t) => [t.wbsCode, t.taskName]));

  const leaves = tasks.filter((t) => !summaryCodes.has(t.wbsCode));

  // Only the names that actually collide among selectable leaves. Two summary
  // rows sharing a name is harmless; two pinnable ones is the Basin 1/2 trap.
  const nameCounts = new Map<string, number>();
  for (const t of leaves) {
    const key = t.taskName.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  return leaves
    .map((t) => ({
      ...t,
      group: groupForTask(t, refIso),
      parentName: t.parentWbsCode
        ? nameByCode.get(t.parentWbsCode) ?? null
        : null,
      nameIsAmbiguous: (nameCounts.get(t.taskName.trim().toLowerCase()) ?? 0) > 1,
    }))
    .sort((a, b) => {
      const g = GROUP_RANK[a.group] - GROUP_RANK[b.group];
      if (g !== 0) return g;
      return compareWbsCodes(a.wbsCode, b.wbsCode);
    });
}

/**
 * The one option label, shared by the report form and the review screen so the
 * crew and the CM are never reading the same task two different ways.
 * "Construct Basin 1 ESC / Embankment - 5.1.1.6.5 (25%)"
 */
export function pickerOptionLabel(t: {
  wbsCode: string;
  taskName: string;
  currentPct: number | null;
  parentName?: string | null;
}): string {
  const head = t.parentName ? `${t.parentName} / ${t.taskName}` : t.taskName;
  const pct = t.currentPct != null ? ` (${t.currentPct}%)` : "";
  return `${head} - ${t.wbsCode}${pct}`;
}
