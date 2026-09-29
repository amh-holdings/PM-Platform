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
//   2. The list runs in the schedule's own order, under the same outline
//      headings the schedule page draws. It used to sort by relevance bucket -
//      open now, starting soon, everything else - which reads well on paper and
//      badly in practice: the buckets cut across the outline, so one summary
//      could head three separate stretches of the same list and a foreman had
//      no stable place to look. What is in play is now marked on the option
//      instead of moving it.
//   3. Every option names its parents. Sweet Springs' September is the second
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
  /** The schedule grid's own row order. Null rows fall back to WBS order. */
  sortOrder?: number | null;
};

/** One summary row above a leaf, as the outline shows it. */
export type PickerAncestor = { wbsCode: string; name: string };

/** What the picker renders for one option, parent first. */
export type PickerLabel = {
  /** Immediate parent's task name, e.g. "Construct Basin 1 ESC". */
  parentName: string | null;
  /**
   * Every summary row above this leaf that really exists in the schedule,
   * shallowest first: [Civil Construction, Phase 1, Construct Basin 1 ESC].
   * This is the outline path the schedule page draws down the left, and it is
   * what lets the dropdown repeat that outline instead of flattening it.
   */
  ancestors: PickerAncestor[];
  /** True when another selectable leaf shares this exact task name. */
  nameIsAmbiguous: boolean;
};

export type PickerGroup = "open" | "soon" | "other";

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

/**
 * The ancestor chain of a WBS code, shallowest first, limited to rows that
 * really exist in the schedule.
 *
 * Derived from the code rather than from parent_wbs_code, for the same reason
 * schedule-tree.ts derives the outline that way: the dots ARE the structure,
 * and parent_wbs_code can drift after an import while the code cannot.
 * parent_wbs_code is still the fallback, so a schedule whose numbering skips a
 * level does not lose its heading.
 */
function ancestorsOf(
  wbsCode: string,
  nameByCode: Map<string, string>,
  parentWbsCode: string | null | undefined,
): PickerAncestor[] {
  const chain: PickerAncestor[] = [];
  let code = wbsCode;
  for (;;) {
    const i = code.lastIndexOf(".");
    if (i === -1) break;
    code = code.slice(0, i);
    const name = nameByCode.get(code);
    if (name) chain.unshift({ wbsCode: code, name });
  }
  if (!chain.length && parentWbsCode) {
    const name = nameByCode.get(parentWbsCode);
    if (name) chain.push({ wbsCode: parentWbsCode, name });
  }
  return chain;
}

/**
 * The schedule grid's own row order: sort_order first, WBS as the tiebreak.
 *
 * Deliberately the same rule as scheduleOrder in schedule-edit.ts. The picker
 * used to sort by relevance bucket instead, which meant the dropdown and the
 * schedule page disagreed about what came after what - and since the buckets
 * cut across the outline, one summary could appear as a heading three separate
 * times in one list. Zarina, looking at exactly that: "organize the dropdown in
 * order by how it is looking in the schedule page."
 */
export function compareScheduleOrder(
  a: { sortOrder?: number | null; wbsCode: string },
  b: { sortOrder?: number | null; wbsCode: string },
): number {
  const as = a.sortOrder;
  const bs = b.sortOrder;
  if (as != null && bs != null && as !== bs) return as - bs;
  if (as != null && bs == null) return -1;
  if (as == null && bs != null) return 1;
  return compareWbsCodes(a.wbsCode, b.wbsCode);
}

/**
 * Leaf tasks only, in the order the schedule page draws them.
 *
 * `refIso` is the report date (YYYY-MM-DD), not necessarily today - a report
 * filed late still gets the picker its own day would have shown. It no longer
 * moves anything up the list; it decides which options are marked as in play,
 * so the crew can still spot them without the list being reshuffled out of the
 * shape they know from the schedule.
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
      ancestors: ancestorsOf(t.wbsCode, nameByCode, t.parentWbsCode),
      nameIsAmbiguous: (nameCounts.get(t.taskName.trim().toLowerCase()) ?? 0) > 1,
    }))
    .sort(compareScheduleOrder);
}

/**
 * The list as the dropdown renders it: the schedule's outline, with every
 * summary row above a leaf appearing as its own indented heading.
 *
 * Summary rows are still not selectable - pinning to one writes a rollup
 * percent onto the schedule, which is why they were filtered out in the first
 * place. But filtering them out entirely meant a scope the whole crew calls by
 * its parent's name was nowhere in the list: "Construct Basin 1 ESC" is
 * 5.1.1.6, a summary, and after the 9 Sep split its work lives in six leaves
 * with names like "Culvert outflow". Somebody looking for Basin 1 ESC found
 * nothing and concluded the schedule had lost it.
 *
 * So the parents come back as disabled headings. The scope is findable, and
 * what gets picked is still a leaf.
 *
 * Every level comes back, not just the immediate parent. Showing one level
 * only is what put "Civil Construction" in the list three separate times on
 * Sweet Springs - 5.1.2, 5.1.5 and 5.1.6 all hang directly off it, with Phase 1
 * and Phase 2 branches in between, so the heading flipped back and forth as the
 * list stepped in and out of depth. Carrying the whole path means a heading is
 * emitted only where the outline itself actually changes, exactly as the
 * schedule page draws it.
 *
 * Headings key on WBS code, never on name: two summary rows may legitimately
 * share a name, and merging them would put one basin's leaves under the
 * other's heading.
 */
export type PickerRow<T> =
  | { kind: "heading"; key: string; name: string; wbsCode: string; depth: number }
  | { kind: "task"; key: string; task: T; depth: number };

export function withOutlineHeadings<
  T extends { id: string; ancestors?: PickerAncestor[] },
>(options: T[]): PickerRow<T>[] {
  const rows: PickerRow<T>[] = [];
  let open: PickerAncestor[] = [];
  for (const t of options) {
    const path = t.ancestors ?? [];
    // How much of the previous option's path this one still shares. Everything
    // below that point is a branch the list is entering for the first time.
    let shared = 0;
    while (
      shared < path.length &&
      shared < open.length &&
      path[shared].wbsCode === open[shared].wbsCode
    ) {
      shared++;
    }
    for (let d = shared; d < path.length; d++) {
      rows.push({
        kind: "heading",
        key: `heading:${path[d].wbsCode}`,
        name: path[d].name,
        wbsCode: path[d].wbsCode,
        depth: d,
      });
    }
    open = path;
    rows.push({ kind: "task", key: t.id, task: t, depth: path.length });
  }
  return rows;
}

/** Two spaces per outline level, so a five-deep WBS still fits a phone. */
function indent(depth: number): string {
  return "\u00a0\u00a0".repeat(Math.max(0, depth));
}

/**
 * What is in play on the report date, said on the option instead of by moving
 * it. The crew used to get three relevance buckets at the top of the list; the
 * list is in schedule order now, so the signal rides along with the row.
 */
export const PICKER_GROUP_MARK: Record<PickerGroup, string> = {
  open: " \u2022 open now",
  soon: " \u2022 soon",
  other: "",
};

/**
 * A summary row as a heading, indented to its place in the outline.
 * "\u00a0\u00a0\u00a0\u00a0Construct Basin 1 ESC - 5.1.1.6"
 */
export function pickerHeadingLabel(row: {
  name: string;
  wbsCode: string;
  depth: number;
}): string {
  return `${indent(row.depth)}${row.name} - ${row.wbsCode}`;
}

/**
 * A leaf under its parents' headings. They are already on screen above it, so
 * repeating them here would just push the part that tells two siblings apart
 * off the right edge of a phone.
 * "\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0Embankment - 5.1.1.6.5 (25%) \u2022 open now"
 */
export function pickerLeafLabel(t: {
  wbsCode: string;
  taskName: string;
  currentPct: number | null;
  group?: PickerGroup;
  depth?: number;
}): string {
  const pct = t.currentPct != null ? ` (${t.currentPct}%)` : "";
  const mark = t.group ? PICKER_GROUP_MARK[t.group] : "";
  return `${indent(t.depth ?? 1)}${t.taskName} - ${t.wbsCode}${pct}${mark}`;
}

/**
 * The one option label, shared by the report form and the review screen so the
 * crew and the CM are never reading the same task two different ways. Used
 * where there is no heading above the row to carry the parent.
 * "Construct Basin 1 ESC / Embankment - 5.1.1.6.5 (25%)"
 */
export function pickerOptionLabel(t: {
  wbsCode: string;
  taskName: string;
  currentPct: number | null;
  parentName?: string | null;
  group?: PickerGroup;
}): string {
  const head = t.parentName ? `${t.parentName} / ${t.taskName}` : t.taskName;
  const pct = t.currentPct != null ? ` (${t.currentPct}%)` : "";
  const mark = t.group ? PICKER_GROUP_MARK[t.group] : "";
  return `${head} - ${t.wbsCode}${pct}${mark}`;
}
