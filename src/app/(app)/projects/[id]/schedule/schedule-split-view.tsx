"use client";

// The schedule, on one screen.
//
// This replaces three tabs - Table, Edit and Gantt - that between them made
// the schedule hard to read and harder to adjust. The columns that told you a
// task's float were on one tab, the cells that let you change its dates were
// on a second, and the bar that showed you when it ran was on a third. So
// every adjustment was: read the float here, switch, type there, save, switch
// again to see whether it worked. Nothing about that is the schedule's fault.
//
// Now there is one grid, editable, with the derived columns in it, and the
// bars beside it on the same rows. Everything the three tabs did survives:
// the six filters and the weighted progress roll-up came from Table, the
// draft-and-save editing and structural moves from Edit, the draggable bars
// from Gantt.
//
// Two things are new and are the point of the exercise. The outline collapses,
// because 71 tasks becomes 200 when electrical lands and a flat list that long
// is a schedule you scroll rather than read. And the forecast recalculates
// over the unsaved draft, so you see what an edit does to float and to the
// finish date before you commit it rather than after.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  addWorkingDays,
  durationInWorkingDays,
  parseIso,
  snapBack,
  snapForward,
  toIso,
  workingDaysBetween,
  type CalendarLike,
} from "@/lib/schedule-calendar";
import { parsePredecessors, type CpmOutput } from "@/lib/schedule-cpm";
import {
  durationFromDates,
  nextChildCode,
  nextTopLevelCode,
  parentCodeOf,
  planDrop,
  planIndent,
  planMove,
  planOutdent,
  reconcileDates,
  scheduleOrder,
  shiftDates,
  type DateField,
  type DropPlan,
  type EditTask,
  type StructurePlan,
  type TaskDraft,
} from "@/lib/schedule-edit";
import { buildProgress, type Progress } from "@/lib/schedule-rollup";
import {
  collapseToLevel,
  outlineDepth,
  revealTask,
  summaryCodes,
  toggleBranch,
  visibleRows,
} from "@/lib/schedule-tree";
import type { TaskConstraintState } from "@/lib/schedule-constraints";
import {
  applyStructurePlan,
  bulkUpdateScheduleTasks,
  deleteScheduleTasks,
  describeTaskDeletion,
  type TaskPatch,
} from "../schedule-actions";
import {
  BarRow,
  DAY_MS,
  HEADER_H,
  Legend,
  ROW_H,
  TimelineGrid,
  TimelineHeader,
  ZOOMS,
  shortDate,
  useGanttGeometry,
} from "./schedule-bars";
import { TaskEditDialog } from "./task-edit-dialog";
import { hasLinkErrors } from "./predecessor-editor";
import type { ScheduleTaskRow } from "./schedule-types";

// Fields the grid edits in place. Anything not here is either derived (float,
// projected dates), owned by another workflow (progress comes from approved
// field reports, baselines from the baseline action), or too structured for a
// cell (date constraints, the risk flags) and lives in the task dialog.
const FIELDS = [
  "task_name",
  "assigned_to",
  "phase",
  "status",
  "duration_days",
  "start_date",
  "end_date",
  "predecessors",
] as const;

type Field = (typeof FIELDS)[number];

// The three cells that are really one fact. Editing any of them settles the
// other two.
const DATE_FIELDS: readonly Field[] = ["start_date", "end_date", "duration_days"];

type ColumnKey =
  | "code"
  | "task"
  | "assigned"
  | "phase"
  | "status"
  | "progress"
  | "dur"
  | "start"
  | "finish"
  | "projected"
  | "float"
  | "variance"
  | "predecessors";

type Column = {
  key: ColumnKey;
  label: string;
  width: number;
  /** Read-only columns are derived; editing them would be editing an output. */
  derived?: boolean;
  title?: string;
};

// Widths are fixed rather than fluid so the grid and the bars keep the same
// row height when a name wraps - which it must not, or the two halves drift
// apart by a pixel per row and by row 60 they are a whole row out.
const ALL_COLUMNS: Column[] = [
  { key: "code", label: "Code", width: 70 },
  { key: "task", label: "Task", width: 232 },
  { key: "status", label: "Status", width: 106 },
  { key: "assigned", label: "Assigned", width: 110 },
  { key: "phase", label: "Phase", width: 104 },
  { key: "progress", label: "Progress", width: 120, derived: true },
  { key: "dur", label: "Dur", width: 44 },
  { key: "start", label: "Start", width: 120 },
  { key: "finish", label: "Finish", width: 120 },
  {
    key: "projected",
    label: "Projected",
    width: 104,
    derived: true,
    title: "Where the dependency network puts this task, as of the data date. Read-only - it is a result, not a setting.",
  },
  {
    key: "float",
    label: "Float",
    width: 72,
    derived: true,
    title: "Total float over free float. Total is how far the project can absorb; free is how far this task can move without touching a successor.",
  },
  { key: "variance", label: "vs Base", width: 72, derived: true },
  { key: "predecessors", label: "Predecessors", width: 170 },
];

const DEFAULT_COLUMNS: ColumnKey[] = [
  "code", "task", "status", "dur", "start", "finish", "float",
];

const STATUS_TONE: Record<string, string> = {
  Complete: "bg-emerald-100 text-emerald-900",
  "In Progress": "bg-blue-100 text-blue-900",
  Awaiting: "bg-amber-100 text-amber-900",
  "Not Started": "bg-muted text-muted-foreground",
  Rejected: "bg-destructive/10 text-destructive",
  Approved: "bg-emerald-100 text-emerald-900",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
    timeZone: "UTC",
  });
}

function asEdit(t: ScheduleTaskRow): EditTask {
  return {
    id: t.id,
    wbs_code: t.wbs_code,
    task_name: t.task_name,
    predecessors: t.predecessors,
    sort_order: t.sort_order,
    level_code: t.level_code,
    duration_days: t.duration_days,
    start_date: t.start_date,
    end_date: t.end_date,
    phase: t.phase,
    assigned_to: t.assigned_to,
    status: t.status,
    is_milestone: t.is_milestone,
  };
}

function raw(t: ScheduleTaskRow, f: Field): string {
  const v = (t as unknown as Record<string, unknown>)[f];
  return v === null || v === undefined ? "" : String(v);
}

type Props = {
  projectId: string;
  /** Scoped by the workspace filter - what this view shows. */
  tasks: ScheduleTaskRow[];
  /** Every task on the project, for link validation and structural planning. */
  allTasks: ScheduleTaskRow[];
  /** CPM over the committed schedule. */
  cpm: CpmOutput;
  /** CPM over the schedule with the unsaved draft applied. Same when clean. */
  previewCpm: CpmOutput;
  calendar: CalendarLike;
  dataDate: string;
  today: string;
  phaseOptions: string[];
  statusOptions: string[];
  phase1Available: boolean;
  constraintState: Map<string, TaskConstraintState>;
  draft: TaskDraft;
  setDraft: React.Dispatch<React.SetStateAction<TaskDraft>>;
};

type DragState = {
  id: string;
  mode: "move" | "resize";
  startX: number;
  origStart: string;
  origEnd: string;
};

export function ScheduleSplitView({
  projectId,
  tasks,
  allTasks,
  cpm,
  previewCpm,
  calendar,
  dataDate,
  today,
  phaseOptions,
  statusOptions,
  phase1Available,
  constraintState,
  draft,
  setDraft,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [msg, setMsg] = useState<{ tone: "good" | "bad" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(2);
  // Wide enough that the default columns all fit without horizontal scrolling.
  // A finish date you have to scroll to is the problem this view exists to fix.
  const [gridWidth, setGridWidth] = useState(810);
  const [query, setQuery] = useState("");
  const [columns, setColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [showColumnMenu, setShowColumnMenu] = useState(false);

  // Filters, carried over from the old Table view.
  const [phaseFilter, setPhaseFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [hideComplete, setHideComplete] = useState(false);
  const [hideInternal, setHideInternal] = useState(false);
  const [reportedOnly, setReportedOnly] = useState(false);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [slippingOnly, setSlippingOnly] = useState(false);
  const [blockedOnly, setBlockedOnly] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<null | Awaited<
    ReturnType<typeof describeTaskDeletion>
  >>(null);
  const [shiftBy, setShiftBy] = useState("5");
  const [dragging, setDragging] = useState<string[] | null>(null);
  const [dropAt, setDropAt] = useState<{ wbs: string; position: "before" | "after" } | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ plan: DropPlan; parent: string | null } | null>(null);

  // Bars dragged but not saved, held here rather than written on mouse-up so a
  // drag can be looked at, corrected or thrown away before it becomes the plan.
  const [barMoves, setBarMoves] = useState<Map<string, { start: string; end: string }>>(new Map());
  const [barDrag, setBarDrag] = useState<DragState | null>(null);
  const [ghost, setGhost] = useState<{ id: string; start: string; end: string } | null>(null);

  const cellRefs = useRef(new Map<string, HTMLElement>());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [timelineWidth, setTimelineWidth] = useState(900);

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const ordered = useMemo(() => scheduleOrder(tasks.map(asEdit)), [tasks]);
  const allRows = useMemo(
    () => ordered.map((o) => byId.get(o.id)!).filter(Boolean),
    [ordered, byId],
  );

  const summaries = useMemo(() => new Set(summaryCodes(allRows)), [allRows]);
  const progress = useMemo(() => buildProgress(tasks), [tasks]);
  const anyBaseline = useMemo(() => tasks.some((t) => t.baseline_end), [tasks]);

  const valueOf = useCallback(
    (t: ScheduleTaskRow, f: Field) => draft[t.id]?.[f] ?? raw(t, f),
    [draft],
  );
  const isDirty = useCallback(
    (t: ScheduleTaskRow, f: Field) =>
      draft[t.id]?.[f] !== undefined && draft[t.id]?.[f] !== raw(t, f),
    [draft],
  );

  // A row counts as changed only when a cell actually differs from the
  // database. Reconciling a date triple writes all three cells into the draft,
  // two of which usually come back identical.
  const dirtyIds = useMemo(
    () =>
      Object.keys(draft).filter((id) => {
        const t = byId.get(id);
        if (!t) return false;
        return Object.entries(draft[id] ?? {}).some(
          ([f, v]) => v !== undefined && v !== raw(t, f as Field),
        );
      }),
    [draft, byId],
  );
  const dirtyCount = dirtyIds.length;

  // ---- what to show -------------------------------------------------------
  const matchesFilters = useCallback(
    (t: ScheduleTaskRow) => {
      const c = cpm.byWbs.get(t.wbs_code);
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (statusFilter && t.status !== statusFilter) return false;
      if (hideComplete && t.status === "Complete") return false;
      if (hideInternal && t.is_internal) return false;
      if (reportedOnly && t.status_source !== "dpr") return false;
      if (criticalOnly && !c?.critical) return false;
      if (slippingOnly && !(c && c.slipDays > 0)) return false;
      if (blockedOnly && !(constraintState.get(t.wbs_code)?.open ?? 0)) return false;
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const hay = `${t.wbs_code} ${t.task_name} ${t.assigned_to ?? ""} ${t.phase ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    },
    [
      cpm, phaseFilter, statusFilter, hideComplete, hideInternal, reportedOnly,
      criticalOnly, slippingOnly, blockedOnly, constraintState, query,
    ],
  );

  const anyFilter =
    !!phaseFilter || !!statusFilter || hideComplete || hideInternal ||
    reportedOnly || criticalOnly || slippingOnly || blockedOnly || !!query.trim();

  // Filtering a tree is not filtering a list. Dropping a summary because its
  // own name does not match would orphan every matching task beneath it, so a
  // summary survives when anything under it survives. Without this, "critical
  // only" showed a flat list of tasks with no indication of what they belonged
  // to, which is most of why the old Table view read as a spreadsheet dump.
  const filtered = useMemo(() => {
    if (!anyFilter) return allRows;
    const keep = new Set<string>();
    for (const t of allRows) {
      if (!matchesFilters(t)) continue;
      keep.add(t.wbs_code);
      let dot = t.wbs_code.lastIndexOf(".");
      while (dot !== -1) {
        const ancestor = t.wbs_code.slice(0, dot);
        keep.add(ancestor);
        dot = ancestor.lastIndexOf(".");
      }
    }
    return allRows.filter((t) => keep.has(t.wbs_code));
  }, [allRows, anyFilter, matchesFilters]);

  const rows = useMemo(() => visibleRows(filtered, collapsed), [filtered, collapsed]);

  const maxLevel = useMemo(() => outlineDepth(allRows), [allRows]);

  // ---- geometry -----------------------------------------------------------
  const barDatesOf = useCallback(
    (t: ScheduleTaskRow): { start: string | null; end: string | null } => {
      if (ghost?.id === t.id) return { start: ghost.start, end: ghost.end };
      const m = barMoves.get(t.id);
      if (m) return { start: m.start, end: m.end };
      // An unsaved cell edit moves the bar too. The grid and the chart are the
      // same schedule; a date typed on the left that did not move the bar on
      // the right would be two views disagreeing on screen at once.
      const d = draft[t.id];
      if (d?.start_date !== undefined || d?.end_date !== undefined) {
        return {
          start: (d.start_date ?? raw(t, "start_date")) || null,
          end: (d.end_date ?? raw(t, "end_date")) || null,
        };
      }
      return { start: t.start_date, end: t.end_date };
    },
    [ghost, barMoves, draft],
  );

  const spanDates = useMemo(() => {
    const out: (string | null | undefined)[] = [today, dataDate];
    for (const t of rows) {
      const d = barDatesOf(t);
      out.push(d.start, d.end, t.baseline_start, t.baseline_end);
      const c = previewCpm.byWbs.get(t.wbs_code);
      if (c) { out.push(c.projectedStart); out.push(c.projectedEnd); }
    }
    return out;
  }, [rows, barDatesOf, previewCpm, today, dataDate]);

  const geo = useGanttGeometry(spanDates, zoom, timelineWidth);

  useLayoutEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTimelineWidth(el.clientWidth));
    ro.observe(el);
    setTimelineWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Open on the as-of line rather than the far left of the span. Sweet Springs
  // runs Jul 2026 to May 2027, so the old behaviour put this week off screen on
  // every load. Runs once per zoom, not on every geometry change, or scrolling
  // away from today would snap back while you read.
  const scrollToAsOf = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const el = timelineRef.current;
      if (!el) return;
      const x = ((parseIso(dataDate) - geo.min) / DAY_MS) * geo.dayPx;
      el.scrollTo({ left: Math.max(0, x - el.clientWidth * 0.3), behavior });
    },
    [dataDate, geo.min, geo.dayPx],
  );
  useEffect(() => { scrollToAsOf("auto"); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [zoom]);

  // ---- editing ------------------------------------------------------------
  function setCell(id: string, f: Field, v: string) {
    setDraft((prev) => {
      const row = { ...(prev[id] ?? {}), [f]: v };
      if (!DATE_FIELDS.includes(f)) return { ...prev, [id]: row };

      const t = byId.get(id);
      if (!t) return { ...prev, [id]: row };

      // A half-typed date is a keystroke on the way to a real one. Reconciling
      // it would rewrite the other cells from a value not yet finished.
      if ((f === "start_date" || f === "end_date") && v !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return { ...prev, [id]: row };
      }
      if (f === "duration_days" && v.trim() !== "") {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return { ...prev, [id]: row };
      }

      const cur = (field: Field): string => row[field] ?? raw(t, field);
      const durRaw = cur("duration_days").trim();
      const settled = reconcileDates(
        {
          start_date: cur("start_date") || null,
          end_date: cur("end_date") || null,
          duration_days: durRaw === "" ? null : Math.round(Number(durRaw)),
        },
        f as DateField,
        calendar,
        { isMilestone: !!t.is_milestone },
      );
      return {
        ...prev,
        [id]: {
          ...row,
          start_date: settled.start_date ?? "",
          end_date: settled.end_date ?? "",
          duration_days: settled.duration_days == null ? "" : String(settled.duration_days),
        },
      };
    });
  }

  function discard() {
    setDraft({});
    setBarMoves(new Map());
    setMsg(null);
  }

  const key = (r: number, c: number) => `${r}:${c}`;
  const setCellRef = (k: string, el: HTMLElement | null) => {
    if (el) cellRefs.current.set(k, el);
    else cellRefs.current.delete(k);
  };

  function onCellKeyDown(
    e: React.KeyboardEvent,
    r: number,
    c: number,
    t: ScheduleTaskRow,
    f: Field,
  ) {
    const go = (dr: number, dc: number) => {
      const el = cellRefs.current.get(key(r + dr, c + dc));
      if (el) {
        e.preventDefault();
        el.focus();
        if (el instanceof HTMLInputElement) el.select();
      }
    };
    if (e.key === "Escape") {
      setDraft((prev) => {
        const next = { ...prev };
        if (next[t.id]) {
          const row = { ...next[t.id] };
          delete row[f];
          next[t.id] = row;
        }
        return next;
      });
      return;
    }
    if (e.key === "Enter") { go(1, 0); return; }
    if (e.key === "ArrowDown" && !e.shiftKey) { go(1, 0); return; }
    if (e.key === "ArrowUp" && !e.shiftKey) { go(-1, 0); return; }
    // Left and right only jump cells from the ends of the text, so arrowing
    // through a task name still works the way typing expects.
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const el = e.target as HTMLInputElement;
      if (el.type === "date" || el.tagName === "SELECT") return;
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      const atEnd =
        el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
      if (e.key === "ArrowRight" && atEnd) go(0, 1);
      if (e.key === "ArrowLeft" && atStart) go(0, -1);
    }
  }

  async function save() {
    const patches: TaskPatch[] = [];
    const problems: string[] = [];

    for (const id of dirtyIds) {
      const t = byId.get(id);
      if (!t) continue;
      const d = draft[id]!;
      const patch: TaskPatch = { id };

      for (const f of FIELDS) {
        const v = d[f];
        if (v === undefined || v === raw(t, f)) continue;
        if (f === "duration_days") {
          if (v.trim() === "") { patch.duration_days = null; continue; }
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) {
            problems.push(`${t.wbs_code}: duration "${v}" is not a number of days.`);
            continue;
          }
          patch.duration_days = Math.round(n);
        } else if (f === "predecessors") {
          const linkError = hasLinkErrors(allTasks, t.wbs_code, v.trim() || null);
          if (linkError) {
            problems.push(`${t.wbs_code}: ${linkError}`);
            continue;
          }
          patch.predecessors = v.trim() || null;
        } else {
          patch[f] = v.trim() === "" ? null : v.trim();
        }
      }

      // A start after its own finish is not a schedule, and the CPM engine
      // will take it literally rather than reject it.
      const s = patch.start_date ?? t.start_date;
      const e = patch.end_date ?? t.end_date;
      if (typeof s === "string" && typeof e === "string" && s > e) {
        problems.push(`${t.wbs_code}: start ${s} is after finish ${e}.`);
      }

      if (Object.keys(patch).length > 1) patches.push(patch);
    }

    // Dragged bars save in the same gesture as typed cells. They are the same
    // edit made two ways, and two separate Save buttons is how you end up with
    // half a change written.
    for (const [id, v] of Array.from(barMoves.entries())) {
      const t = byId.get(id);
      if (!t) continue;
      const existing = patches.find((p) => p.id === id);
      const target = existing ?? ({ id } as TaskPatch);
      target.start_date = v.start;
      target.end_date = v.end;
      target.duration_days = durationFromDates(
        { start_date: v.start, end_date: v.end, is_milestone: t.is_milestone },
        calendar,
      );
      if (!existing) patches.push(target);
    }

    if (problems.length) {
      setMsg({ tone: "bad", text: `Nothing saved. ${problems.join(" ")}` });
      return;
    }
    if (!patches.length) { discard(); return; }

    setBusy(true);
    const res = await bulkUpdateScheduleTasks(projectId, patches);
    setBusy(false);
    if (!res.ok) { setMsg({ tone: "bad", text: res.error }); return; }
    setDraft({});
    setBarMoves(new Map());
    setMsg({
      tone: "good",
      text: `${res.count} task${res.count === 1 ? "" : "s"} saved. Float and the projection have been recalculated. The baseline is untouched, so the variance is still visible.`,
    });
    startTransition(() => router.refresh());
  }

  // ---- bulk edits ---------------------------------------------------------
  function bulkSet(f: Field, v: string) {
    if (!selected.size) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const id of Array.from(selected)) next[id] = { ...(next[id] ?? {}), [f]: v };
      return next;
    });
    setMsg({
      tone: "warn",
      text: `${selected.size} row${selected.size === 1 ? "" : "s"} changed but not yet saved.`,
    });
  }

  function bulkShift() {
    const days = Number(shiftBy);
    if (!Number.isFinite(days) || days === 0 || !selected.size) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const id of Array.from(selected)) {
        const t = byId.get(id);
        if (!t) continue;
        const cur = {
          start_date: next[id]?.start_date ?? t.start_date,
          end_date: next[id]?.end_date ?? t.end_date,
        };
        const moved = shiftDates(cur, days, calendar);
        if (!moved) continue;
        next[id] = {
          ...(next[id] ?? {}),
          start_date: moved.start_date ?? "",
          end_date: moved.end_date ?? "",
        };
      }
      return next;
    });
    setMsg({
      tone: "warn",
      text: `${selected.size} row${selected.size === 1 ? "" : "s"} moved ${Math.abs(days)} working day${Math.abs(days) === 1 ? "" : "s"} ${days > 0 ? "later" : "earlier"}, not yet saved. Weekends, holidays and calendar exceptions were skipped.`,
    });
  }

  // ---- structural edits ---------------------------------------------------
  async function runStructure(plan: StructurePlan, label: string) {
    if (!plan.ok) { setMsg({ tone: "bad", text: plan.error ?? "Cannot do that." }); return; }
    if (!plan.renames.length && !plan.sortUpdates.length) {
      setMsg({ tone: "warn", text: "Nothing to move." });
      return;
    }
    setBusy(true);
    const res = await applyStructurePlan(projectId, plan);
    setBusy(false);
    if (!res.ok) { setMsg({ tone: "bad", text: res.error }); return; }
    setMsg({
      tone: "good",
      text: [
        label,
        plan.renames.length
          ? `${plan.renames.length} code${plan.renames.length === 1 ? "" : "s"} renumbered.`
          : "",
        ...plan.warnings,
      ].filter(Boolean).join(" "),
    });
    startTransition(() => router.refresh());
  }

  const structureBlocked = dirtyCount > 0 || barMoves.size > 0;

  function structure(kind: "indent" | "outdent" | "up" | "down") {
    if (structureBlocked) {
      setMsg({
        tone: "warn",
        text: "Save or discard your edits first - moving a task renumbers WBS codes and the two would fight.",
      });
      return;
    }
    const all = allTasks.map(asEdit);
    const codes = Array.from(selected).map((id) => byId.get(id)?.wbs_code).filter(Boolean) as string[];
    if (!codes.length) { setMsg({ tone: "warn", text: "Select a row first." }); return; }

    if (kind === "indent") runStructure(planIndent(all, codes), "Indented.");
    else if (kind === "outdent") runStructure(planOutdent(all, codes), "Outdented.");
    else runStructure(planMove(all, codes, kind === "up" ? "up" : "down"), "Moved.");
  }

  function onDragStart(e: React.DragEvent, t: ScheduleTaskRow) {
    if (structureBlocked) {
      e.preventDefault();
      setMsg({
        tone: "warn",
        text: "Save or discard your edits first - reordering can renumber WBS codes and the two would fight.",
      });
      return;
    }
    const codes =
      selected.has(t.id) && selected.size > 1
        ? rows.filter((r) => selected.has(r.id)).map((r) => r.wbs_code)
        : [t.wbs_code];
    setDragging(codes);
    setMsg(null);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", codes.join(","));
  }

  function onDragOverRow(e: React.DragEvent, t: ScheduleTaskRow) {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDropAt({ wbs: t.wbs_code, position: before ? "before" : "after" });
  }

  function onDropRow(e: React.DragEvent) {
    e.preventDefault();
    const moving = dragging;
    const at = dropAt;
    setDragging(null);
    setDropAt(null);
    if (!moving || !at) return;

    const plan = planDrop(allTasks.map(asEdit), moving, at.wbs, at.position);
    if (!plan.ok) { setMsg({ tone: "bad", text: plan.error ?? "Cannot drop there." }); return; }
    if (!plan.sortUpdates.length && !plan.renames.length) return;
    if (plan.reparents) {
      setPendingDrop({ plan, parent: parentCodeOf(at.wbs) });
      return;
    }
    runStructure(plan, "Reordered.");
  }

  async function askDelete() {
    const codes = Array.from(selected).map((id) => byId.get(id)?.wbs_code).filter(Boolean) as string[];
    if (!codes.length) return;
    setConfirmDelete(null);
    setBusy(true);
    const res = await describeTaskDeletion(projectId, codes);
    setBusy(false);
    setConfirmDelete(res);
  }

  async function doDelete() {
    setBusy(true);
    const res = await deleteScheduleTasks(projectId, Array.from(selected));
    setBusy(false);
    setConfirmDelete(null);
    if (!res.ok) { setMsg({ tone: "bad", text: res.error }); return; }
    setSelected(new Set());
    setMsg({
      tone: "good",
      text: `${res.count} task${res.count === 1 ? "" : "s"} deleted. Predecessor references to them were removed so nothing is left free-floating.`,
    });
    startTransition(() => router.refresh());
  }

  // ---- bar dragging -------------------------------------------------------
  useEffect(() => {
    if (!barDrag) return;
    const onMove = (e: MouseEvent) => {
      const delta = Math.round((e.clientX - barDrag.startX) / geo.dayPx);
      if (barDrag.mode === "move") {
        const dur = durationInWorkingDays(barDrag.origStart, barDrag.origEnd, calendar);
        const rawStart = toIso(parseIso(barDrag.origStart) + delta * DAY_MS);
        const start = snapForward(rawStart, calendar);
        setGhost({ id: barDrag.id, start, end: addWorkingDays(start, dur, calendar) });
      } else {
        const rawEnd = toIso(parseIso(barDrag.origEnd) + delta * DAY_MS);
        let end = snapBack(rawEnd, calendar);
        if (parseIso(end) < parseIso(barDrag.origStart)) end = snapForward(barDrag.origStart, calendar);
        setGhost({ id: barDrag.id, start: barDrag.origStart, end });
      }
    };
    const onUp = () => {
      setGhost((g) => {
        if (g && (g.start !== barDrag.origStart || g.end !== barDrag.origEnd)) {
          setBarMoves((prev) => {
            const next = new Map(prev);
            next.set(g.id, { start: g.start, end: g.end });
            return next;
          });
        }
        return null;
      });
      setBarDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [barDrag, geo.dayPx, calendar]);

  function beginBarDrag(e: React.MouseEvent, t: ScheduleTaskRow, mode: "move" | "resize") {
    const d = barDatesOf(t);
    if (!d.start || !d.end) return;
    e.preventDefault();
    e.stopPropagation();
    setBarDrag({ id: t.id, mode, startX: e.clientX, origStart: d.start, origEnd: d.end });
  }

  // ---- splitter -----------------------------------------------------------
  const splitDrag = useRef<{ startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!splitDrag.current) return;
      const w = splitDrag.current.startW + (e.clientX - splitDrag.current.startX);
      setGridWidth(Math.max(240, Math.min(1100, w)));
    };
    const onUp = () => { splitDrag.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // ---- forecast delta -----------------------------------------------------
  // What the pending edit would do, computed rather than promised. This is the
  // whole reason the draft is recalculated: an edit whose effect you cannot see
  // is an edit you have to save to evaluate.
  const forecastDelta = useMemo(() => {
    if (!dirtyCount && !barMoves.size) return null;
    const before = cpm.projectedFinish;
    const after = previewCpm.projectedFinish;
    if (!before || !after) return null;
    const days = workingDaysBetween(before, after, calendar);
    return { before, after, days };
  }, [dirtyCount, barMoves.size, cpm, previewCpm, calendar]);

  const shownColumns = useMemo(
    () =>
      ALL_COLUMNS.filter(
        (c) => columns.includes(c.key) && (c.key !== "variance" || anyBaseline),
      ),
    [columns, anyBaseline],
  );
  const gridInnerWidth = shownColumns.reduce((n, c) => n + c.width, 0) + 60;

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const suggestedWbs = useMemo(() => {
    const all = allTasks.map(asEdit);
    const anchor = Array.from(selected).map((id) => byId.get(id)).filter(Boolean)[0];
    if (anchor) {
      const parent = anchor.wbs_code.includes(".")
        ? anchor.wbs_code.slice(0, anchor.wbs_code.lastIndexOf("."))
        : null;
      return nextChildCode(all, parent);
    }
    return nextTopLevelCode(all);
  }, [allTasks, selected, byId]);

  const counts = useMemo(() => {
    let critical = 0, nearCritical = 0, slipping = 0, blocked = 0;
    for (const t of tasks) {
      const c = cpm.byWbs.get(t.wbs_code);
      if (c?.critical) critical++;
      if (c?.nearCritical) nearCritical++;
      if (c && c.slipDays > 0) slipping++;
      if (constraintState.get(t.wbs_code)?.open) blocked++;
    }
    return { total: tasks.length, critical, nearCritical, slipping, blocked };
  }, [tasks, cpm, constraintState]);

  // A find that jumps to the first match, expanding whatever hides it.
  function jumpTo(code: string) {
    setCollapsed((prev) => revealTask(prev, code));
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-wbs="${CSS.escape(code)}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  return (
    <div className="space-y-3">
      {/* ---- view controls ------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2.5">
        <div className="flex items-center gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Outline</span>
          <div className="flex items-center gap-0.5 rounded-md border p-0.5">
            {Array.from({ length: Math.min(maxLevel, 5) }, (_, i) => i + 1).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setCollapsed(collapseToLevel(allRows, lvl))}
                className="rounded px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                title={`Show ${lvl} level${lvl === 1 ? "" : "s"} of the outline`}
              >
                L{lvl}
              </button>
            ))}
            <button
              onClick={() => setCollapsed(new Set())}
              className="rounded px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted"
              title="Expand everything"
            >
              All
            </button>
          </div>
        </div>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && rows.length) jumpTo(rows[0].wbs_code);
          }}
          placeholder="Find task or code"
          className="h-8 w-44"
        />

        <span className="mx-1 h-6 w-px bg-border" />

        <div className="flex items-center gap-0.5 rounded-md border p-0.5">
          {ZOOMS.map((z, i) => (
            <button
              key={z.label}
              onClick={() => setZoom(i)}
              className={cn(
                "rounded px-2 py-0.5 text-xs font-medium",
                zoom === i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {z.label}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="h-8" onClick={() => scrollToAsOf("smooth")}>
          {dataDate !== today ? "Data date" : "Today"}
        </Button>

        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setShowColumnMenu((v) => !v)}
          >
            Columns
          </Button>
          {showColumnMenu && (
            <div className="absolute left-0 top-9 z-40 w-52 rounded-md border bg-popover p-2 shadow-md">
              {ALL_COLUMNS.map((c) => (
                <label key={c.key} className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={columns.includes(c.key)}
                    disabled={c.key === "task"}
                    onChange={(e) =>
                      setColumns((prev) =>
                        e.target.checked
                          ? ALL_COLUMNS.filter((x) => prev.includes(x.key) || x.key === c.key).map((x) => x.key)
                          : prev.filter((k) => k !== c.key),
                      )
                    }
                  />
                  {c.label}
                  {c.derived && <span className="ml-auto text-[10px] text-muted-foreground">derived</span>}
                </label>
              ))}
            </div>
          )}
        </div>

        <span className="mx-1 h-6 w-px bg-border" />

        {/* Counts as a line rather than five more cards. The forecast banner
            directly above already spends a row on headline numbers, and two
            banks of cards pushed the first task halfway down the screen. */}
        <span className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{rows.length}</span>
          {rows.length !== allRows.length && ` of ${allRows.length}`} rows
          {counts.critical > 0 && (
            <> &middot; <span className="font-medium text-destructive">{counts.critical}</span> critical</>
          )}
          {counts.nearCritical > 0 && (
            <> &middot; <span className="font-medium text-amber-700">{counts.nearCritical}</span> near</>
          )}
          {counts.slipping > 0 && (
            <> &middot; <span className="font-medium text-amber-700">{counts.slipping}</span> late</>
          )}
          {counts.blocked > 0 && (
            <> &middot; <span className="font-medium text-destructive">{counts.blocked}</span> blocked</>
          )}
        </span>
      </div>

      {/* ---- filters ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-2 text-sm">
        <select
          value={phaseFilter}
          onChange={(e) => setPhaseFilter(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">All phases</option>
          {phaseOptions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">All statuses</option>
          {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Check label="Critical" checked={criticalOnly} onChange={setCriticalOnly} />
        <Check label="Slipping" checked={slippingOnly} onChange={setSlippingOnly} />
        <Check label="Blocked" checked={blockedOnly} onChange={setBlockedOnly} />
        <Check label="Field-reported" checked={reportedOnly} onChange={setReportedOnly} />
        <Check label="Hide complete" checked={hideComplete} onChange={setHideComplete} />
        <Check label="Hide internal" checked={hideInternal} onChange={setHideInternal} />
        {anyFilter && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              setPhaseFilter(""); setStatusFilter(""); setHideComplete(false);
              setHideInternal(false); setReportedOnly(false); setCriticalOnly(false);
              setSlippingOnly(false); setBlockedOnly(false); setQuery("");
            }}
          >
            Clear filters
          </Button>
        )}
        <Legend />
      </div>

      {/* ---- edit actions -------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        <TaskEditDialog
          projectId={projectId}
          mode="create"
          suggestedWbs={suggestedWbs}
          phaseOptions={phaseOptions}
          statusOptions={statusOptions}
          allTasks={allTasks}
          phase1Available={phase1Available}
          calendar={calendar}
          trigger={<Button size="sm" className="h-8">Add task</Button>}
        />
        <span className="mx-1 h-6 w-px bg-border" />
        <span className="text-xs text-muted-foreground">
          {selected.size ? `${selected.size} selected` : "Tick rows to edit in bulk, move or delete them"}
        </span>
        {selected.size > 0 && (
          <>
        <Button variant="outline" size="sm" className="h-8" disabled={!selected.size || busy} onClick={() => structure("up")}>↑</Button>
        <Button variant="outline" size="sm" className="h-8" disabled={!selected.size || busy} onClick={() => structure("down")}>↓</Button>
        <Button variant="outline" size="sm" className="h-8" disabled={!selected.size || busy} onClick={() => structure("indent")}>→ Indent</Button>
        <Button variant="outline" size="sm" className="h-8" disabled={!selected.size || busy} onClick={() => structure("outdent")}>← Outdent</Button>
        <span className="mx-1 h-6 w-px bg-border" />
        <div className="flex items-center gap-1">
          <Input
            value={shiftBy}
            onChange={(e) => setShiftBy(e.target.value)}
            className="h-8 w-14"
            title="Working days. Negative pulls the work earlier."
          />
          <Button variant="outline" size="sm" className="h-8" disabled={!selected.size} onClick={bulkShift}>
            Shift
          </Button>
        </div>
        <select
          value=""
          disabled={!selected.size}
          onChange={(e) => e.target.value && bulkSet("assigned_to", e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">Set assigned...</option>
          {Array.from(new Set(allTasks.map((t) => t.assigned_to).filter(Boolean))).map((a) => (
            <option key={a as string} value={a as string}>{a as string}</option>
          ))}
        </select>
        <select
          value=""
          disabled={!selected.size}
          onChange={(e) => e.target.value && bulkSet("phase", e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">Set phase...</option>
          {phaseOptions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value=""
          disabled={!selected.size}
          onChange={(e) => e.target.value && bulkSet("status", e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">Set status...</option>
          {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-destructive hover:text-destructive"
          disabled={!selected.size || busy}
          onClick={askDelete}
        >
          Delete
        </Button>
          </>
        )}
      </div>

      {/* ---- unsaved bar --------------------------------------------------- */}
      {(dirtyCount > 0 || barMoves.size > 0) && (
        <div className="sticky top-2 z-40 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 shadow-sm">
          <span className="font-medium">
            {dirtyCount > 0 && `${dirtyCount} row${dirtyCount === 1 ? "" : "s"} edited`}
            {dirtyCount > 0 && barMoves.size > 0 && ", "}
            {barMoves.size > 0 && `${barMoves.size} bar${barMoves.size === 1 ? "" : "s"} moved`}
            {" "}and not yet saved
          </span>
          {forecastDelta ? (
            <span className="text-xs">
              Finish would move {shortDate(forecastDelta.before)} &rarr;{" "}
              <span className="font-semibold">{shortDate(forecastDelta.after)}</span>
              {forecastDelta.days !== 0 && (
                <> ({forecastDelta.days > 0 ? "+" : ""}{forecastDelta.days} working days)</>
              )}
            </span>
          ) : (
            <span className="text-xs">The finish date does not move.</span>
          )}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={discard} disabled={busy}>Discard</Button>
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      {msg && (
        <div className={cn(
          "rounded-md border p-3 text-sm",
          msg.tone === "bad" && "border-destructive/40 bg-destructive/10 text-destructive",
          msg.tone === "warn" && "border-amber-300 bg-amber-50 text-amber-900",
          msg.tone === "good" && "border-emerald-300 bg-emerald-50 text-emerald-900",
        )}>
          {msg.text}
        </div>
      )}

      {pendingDrop && (
        <div className="space-y-2 rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900">
          <p className="font-medium">Move under {pendingDrop.parent ?? "the top level"}?</p>
          <p className="text-xs">
            This drop changes the parent, not just the order, so the moved branch
            is renumbered. Dropping between rows that already share its parent
            would only change the order and rename nothing.
          </p>
          <ul className="space-y-0.5 font-mono text-xs">
            {pendingDrop.plan.renames.slice(0, 12).map((r) => (
              <li key={r.from}>{r.from} &rarr; {r.to}</li>
            ))}
            {pendingDrop.plan.renames.length > 12 && (
              <li>...and {pendingDrop.plan.renames.length - 12} more</li>
            )}
          </ul>
          {pendingDrop.plan.predecessorRewrites.length > 0 && (
            <p className="text-xs">
              {pendingDrop.plan.predecessorRewrites.length} predecessor reference
              {pendingDrop.plan.predecessorRewrites.length === 1 ? "" : "s"} will be repointed to follow it.
            </p>
          )}
          <p className="text-xs">
            Billing lines and cost codes hold WBS codes as plain text and will not follow this rename.
          </p>
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                const p = pendingDrop.plan;
                setPendingDrop(null);
                runStructure(p, "Moved and renumbered.");
              }}
            >
              {busy ? "Moving..." : "Move and renumber"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingDrop(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">
            Delete {selected.size} task{selected.size === 1 ? "" : "s"}?
          </p>
          {confirmDelete.ok ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {confirmDelete.children > 0 && (
                <li className="text-destructive">
                  {confirmDelete.children} subtask{confirmDelete.children === 1 ? "" : "s"} sit
                  beneath the selection and are NOT included. They would be orphaned - select them
                  too, or outdent them first.
                </li>
              )}
              <li>{confirmDelete.dprUpdates} field-report task update{confirmDelete.dprUpdates === 1 ? "" : "s"} destroyed.</li>
              <li>{confirmDelete.inspections} inspection{confirmDelete.inspections === 1 ? "" : "s"} lose their WBS link and stop feeding progress.</li>
              <li>
                {confirmDelete.successors.length
                  ? `${confirmDelete.successors.length} successor${confirmDelete.successors.length === 1 ? "" : "s"} (${confirmDelete.successors.slice(0, 8).map((s) => s.wbs_code).join(", ")}${confirmDelete.successors.length > 8 ? ", ..." : ""}) have the reference removed.`
                  : "Nothing depends on the selection."}
              </li>
              <li>Billing lines and cost codes hold WBS codes as plain text and will not be updated.</li>
            </ul>
          ) : (
            <p className="text-xs text-destructive">{confirmDelete.error}</p>
          )}
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="destructive" onClick={doDelete} disabled={busy}>
              {busy ? "Deleting..." : "Delete"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>Keep them</Button>
          </div>
        </div>
      )}

      {/* ---- the split ----------------------------------------------------- */}
      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <div
          ref={scrollerRef}
          className="flex max-h-[calc(100vh-11rem)] min-h-[28rem] overflow-y-auto"
        >
          {/* Grid pane */}
          <div className="shrink-0 overflow-x-auto" style={{ width: gridWidth }}>
            <div style={{ width: Math.max(gridInnerWidth, gridWidth) }}>
              <div
                className="sticky top-0 z-30 flex items-center border-b bg-muted/60 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur"
                style={{ height: HEADER_H }}
              >
                <div className="flex w-[60px] shrink-0 items-center gap-1 px-1.5">
                  <span className="w-3" />
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                    }
                    title="Select all visible rows"
                  />
                </div>
                {shownColumns.map((c) => (
                  <div
                    key={c.key}
                    className={cn("shrink-0 px-1.5", c.derived && "text-muted-foreground/70")}
                    style={{ width: c.width }}
                    title={c.title}
                  >
                    {c.label}
                  </div>
                ))}
              </div>

              {rows.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                  {allRows.length === 0
                    ? "No tasks in this scope yet. Use Add task, or Import rows to paste a sheet."
                    : "No tasks match the current filters."}
                </div>
              ) : (
                rows.map((t, r) => (
                  <GridRow
                    key={t.id}
                    t={t}
                    r={r}
                    columns={shownColumns}
                    cpm={previewCpm.byWbs.get(t.wbs_code)}
                    progress={progress.get(t.wbs_code) ?? { kind: "none" }}
                    isSummary={summaries.has(t.wbs_code)}
                    collapsed={collapsed.has(t.wbs_code)}
                    onToggleCollapse={() =>
                      setCollapsed((prev) => toggleBranch(prev, t.wbs_code, allRows))
                    }
                    selected={selected.has(t.id)}
                    onSelect={(on) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (on) next.add(t.id); else next.delete(t.id);
                        return next;
                      })
                    }
                    valueOf={valueOf}
                    isDirty={isDirty}
                    setCell={setCell}
                    onCellKeyDown={onCellKeyDown}
                    setCellRef={setCellRef}
                    statusOptions={statusOptions}
                    calendar={calendar}
                    constraint={constraintState.get(t.wbs_code)}
                    dragging={dragging?.includes(t.wbs_code) ?? false}
                    dropAt={dropAt?.wbs === t.wbs_code ? dropAt.position : null}
                    onDragStart={(e) => onDragStart(e, t)}
                    onDragEnd={() => { setDragging(null); setDropAt(null); }}
                    onDragOver={(e) => onDragOverRow(e, t)}
                    onDrop={onDropRow}
                    projectId={projectId}
                    phaseOptions={phaseOptions}
                    allTasks={allTasks}
                    phase1Available={phase1Available}
                  />
                ))
              )}
            </div>
          </div>

          {/* Splitter */}
          <div
            onMouseDown={(e) => {
              splitDrag.current = { startX: e.clientX, startW: gridWidth };
              e.preventDefault();
            }}
            className="w-1.5 shrink-0 cursor-col-resize border-x bg-muted/40 hover:bg-primary/40"
            title="Drag to resize the grid"
          />

          {/* Timeline pane */}
          <div ref={timelineRef} className="flex-1 overflow-x-auto">
            <div className="relative" style={{ width: geo.width }}>
              <TimelineHeader geo={geo} />
              <div className={cn("relative", barDrag && "select-none")}>
                <TimelineGrid geo={geo} today={today} dataDate={dataDate} />
                {rows.map((t) => {
                  const d = barDatesOf(t);
                  const c = previewCpm.byWbs.get(t.wbs_code);
                  const moved =
                    barMoves.has(t.id) ||
                    ghost?.id === t.id ||
                    draft[t.id]?.start_date !== undefined ||
                    draft[t.id]?.end_date !== undefined;
                  return (
                    <div
                      key={t.id}
                      data-bar-wbs={t.wbs_code}
                      className="relative border-b border-border/40"
                      style={{ height: ROW_H }}
                    >
                      <BarRow
                        task={t}
                        cpm={c}
                        geo={geo}
                        start={d.start}
                        end={d.end}
                        moved={moved}
                        editable
                        collapsed={collapsed.has(t.wbs_code)}
                        onBeginDrag={(e, mode) => beginBarDrag(e, t, mode)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <datalist id="phase-options">
        {phaseOptions.map((p) => <option key={p} value={p} />)}
      </datalist>

      <p className="text-xs text-muted-foreground">
        The grid and the bars are the same rows: edit a date on the left and the
        bar moves, drag a bar and the cells follow. Nothing is written until you
        save, and the forecast above the grid is recalculated over the pending
        edit, so what it says is what saving would do. Progress is not editable
        here - it comes from approved field reports, and a schedule you can type
        a percentage into is a schedule nobody believes. Dragging changes the
        planned dates only: it does not touch the baseline, so the variance
        stays visible, and it does not move successors, which the projection
        does on its own. Summary rows have no dates of their own and cannot be
        dragged. Indent and outdent renumber the moved branch only, leaving a
        gap in the sibling numbering on purpose, because a WBS code is an
        identifier other records point at and row order is kept separately.
      </p>
    </div>
  );
}

// ============================================================================
// One row of the grid
// ============================================================================

type GridRowProps = {
  t: ScheduleTaskRow;
  r: number;
  columns: Column[];
  cpm: ReturnType<CpmOutput["byWbs"]["get"]>;
  progress: Progress;
  isSummary: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  selected: boolean;
  onSelect: (on: boolean) => void;
  valueOf: (t: ScheduleTaskRow, f: Field) => string;
  isDirty: (t: ScheduleTaskRow, f: Field) => boolean;
  setCell: (id: string, f: Field, v: string) => void;
  onCellKeyDown: (e: React.KeyboardEvent, r: number, c: number, t: ScheduleTaskRow, f: Field) => void;
  setCellRef: (k: string, el: HTMLElement | null) => void;
  statusOptions: string[];
  calendar: CalendarLike;
  constraint: TaskConstraintState | undefined;
  dragging: boolean;
  dropAt: "before" | "after" | null;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  projectId: string;
  phaseOptions: string[];
  allTasks: ScheduleTaskRow[];
  phase1Available: boolean;
};

function GridRow({
  t, r, columns, cpm: c, progress: p, isSummary, collapsed, onToggleCollapse,
  selected, onSelect, valueOf, isDirty, setCell, onCellKeyDown, setCellRef,
  statusOptions, calendar, constraint, dragging, dropAt,
  onDragStart, onDragEnd, onDragOver, onDrop,
  projectId, phaseOptions, allTasks, phase1Available,
}: GridRowProps) {
  const indent = Math.max(0, (t.level_code ?? 1) - 1) * 10;
  const rowDirty = columns.some((col) => {
    const f = FIELD_OF[col.key];
    return f ? isDirty(t, f) : false;
  });
  const variance =
    t.baseline_end && t.end_date
      ? workingDaysBetween(t.baseline_end, t.end_date, calendar)
      : null;

  // Column index for keyboard navigation counts only editable columns, so
  // arrowing right from Start reaches Finish rather than stopping on Projected.
  let editableIndex = -1;

  return (
    <div
      data-wbs={t.wbs_code}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "flex items-center border-b text-sm",
        selected && "bg-blue-50/60",
        rowDirty && "bg-amber-50/60",
        !selected && !rowDirty && c?.critical && "bg-destructive/5",
        !selected && !rowDirty && !c?.critical && c?.nearCritical && "bg-amber-50/40",
        dragging && "opacity-40",
      )}
      style={{
        height: ROW_H,
        boxShadow:
          dropAt === "before" ? "inset 0 2px 0 0 #2563eb"
            : dropAt === "after" ? "inset 0 -2px 0 0 #2563eb"
            : undefined,
      }}
    >
      <div className="flex w-[60px] shrink-0 items-center gap-1 px-1.5">
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="cursor-grab text-xs text-muted-foreground active:cursor-grabbing"
          title="Drag to reorder"
        >
          ⠿
        </span>
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
      </div>

      {columns.map((col) => {
        const f = FIELD_OF[col.key];
        if (f) editableIndex++;
        const ci = editableIndex;
        return (
          <div key={col.key} className="shrink-0 px-1" style={{ width: col.width }}>
            {renderCell(col.key)}
          </div>
        );

        function renderCell(k: ColumnKey) {
          switch (k) {
            case "code":
              return (
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {t.wbs_code}
                </span>
              );

            case "task":
              return (
                <div className="flex items-center gap-1" style={{ paddingLeft: indent }}>
                  {isSummary ? (
                    <button
                      onClick={onToggleCollapse}
                      className="w-3.5 shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
                      title={collapsed ? "Expand" : "Collapse"}
                    >
                      {collapsed ? "▶" : "▼"}
                    </button>
                  ) : (
                    <span className="w-3.5 shrink-0" />
                  )}
                  {c?.isMilestone && (
                    <span className="shrink-0 text-[10px] text-foreground/70" title="Milestone">◆</span>
                  )}
                  <input
                    className={cn(
                      cellCls(isDirty(t, "task_name")),
                      isSummary && "font-medium",
                    )}
                    value={valueOf(t, "task_name")}
                    onChange={(e) => setCell(t.id, "task_name", e.target.value)}
                    onKeyDown={(e) => onCellKeyDown(e, r, ci, t, "task_name")}
                    ref={(el) => setCellRef(`${r}:${ci}`, el)}
                  />
                  <RowBadges t={t} c={c} constraint={constraint} collapsed={collapsed} />
                </div>
              );

            case "assigned":
              return (
                <input
                  className={cellCls(isDirty(t, "assigned_to"))}
                  value={valueOf(t, "assigned_to")}
                  onChange={(e) => setCell(t.id, "assigned_to", e.target.value)}
                  onKeyDown={(e) => onCellKeyDown(e, r, ci, t, "assigned_to")}
                  ref={(el) => setCellRef(`${r}:${ci}`, el)}
                />
              );

            case "phase":
              return (
                <input
                  list="phase-options"
                  className={cellCls(isDirty(t, "phase"))}
                  value={valueOf(t, "phase")}
                  onChange={(e) => setCell(t.id, "phase", e.target.value)}
                  onKeyDown={(e) => onCellKeyDown(e, r, ci, t, "phase")}
                  ref={(el) => setCellRef(`${r}:${ci}`, el)}
                />
              );

            case "status":
              return (
                <select
                  className={cn(
                    cellCls(isDirty(t, "status")),
                    "text-xs",
                    STATUS_TONE[valueOf(t, "status")] ?? "",
                  )}
                  value={valueOf(t, "status")}
                  onChange={(e) => setCell(t.id, "status", e.target.value)}
                  onKeyDown={(e) => onCellKeyDown(e, r, ci, t, "status")}
                  ref={(el) => setCellRef(`${r}:${ci}`, el)}
                >
                  <option value="">-</option>
                  {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              );

            case "progress":
              return <ProgressCell progress={p} />;

            case "dur":
              return (
                <input
                  className={cn(cellCls(isDirty(t, "duration_days")), "tabular-nums")}
                  value={valueOf(t, "duration_days")}
                  onChange={(e) => setCell(t.id, "duration_days", e.target.value)}
                  onKeyDown={(e) => onCellKeyDown(e, r, ci, t, "duration_days")}
                  ref={(el) => setCellRef(`${r}:${ci}`, el)}
                />
              );

            case "start":
              return (
                <input
                  type="date"
                  className={cellCls(isDirty(t, "start_date"))}
                  value={valueOf(t, "start_date")}
                  onChange={(e) => setCell(t.id, "start_date", e.target.value)}
                  onKeyDown={(e) => onCellKeyDown(e, r, ci, t, "start_date")}
                  ref={(el) => setCellRef(`${r}:${ci}`, el)}
                />
              );

            case "finish":
              return (
                <input
                  type="date"
                  className={cellCls(isDirty(t, "end_date"))}
                  value={valueOf(t, "end_date")}
                  onChange={(e) => setCell(t.id, "end_date", e.target.value)}
                  onKeyDown={(e) => onCellKeyDown(e, r, ci, t, "end_date")}
                  ref={(el) => setCellRef(`${r}:${ci}`, el)}
                />
              );

            case "projected":
              if (!c) return <span className="text-xs text-muted-foreground">-</span>;
              return (
                <span className={cn("text-xs", c.slipDays > 0 && "font-medium text-amber-700")}>
                  {fmtDate(c.projectedEnd)}
                  {c.slipDays > 0 && <span className="ml-1 text-[10px]">+{c.slipDays}d</span>}
                </span>
              );

            case "float":
              if (!c) return <span className="text-xs text-muted-foreground">-</span>;
              return (
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    c.isolated ? "text-muted-foreground"
                      : c.totalFloat <= 0 ? "font-medium text-destructive"
                      : c.nearCritical ? "text-amber-700"
                      : "text-muted-foreground",
                  )}
                  title={
                    c.isolated
                      ? "No predecessor and no successor, so its float is measured against nothing."
                      : `${c.totalFloat} working days of total float - how far this can slip before the project finish moves.\n` +
                        `${c.freeFloat} of free float - how far it can slip before it moves a successor.`
                  }
                >
                  {c.isolated ? "-" : `${c.totalFloat}d`}
                </span>
              );

            case "variance":
              if (variance == null) return <span className="text-[10px] text-muted-foreground">no base</span>;
              return (
                <span className={cn(
                  "text-xs tabular-nums",
                  variance > 0 ? "font-medium text-destructive"
                    : variance < 0 ? "text-emerald-700"
                    : "text-muted-foreground",
                )}>
                  {variance > 0 ? `+${variance}d` : variance < 0 ? `${variance}d` : "on"}
                </span>
              );

            case "predecessors": {
              const linkCount = parsePredecessors(valueOf(t, "predecessors")).length;
              return (
                <input
                  className={cn(cellCls(isDirty(t, "predecessors")), "font-mono text-[11px]")}
                  value={valueOf(t, "predecessors")}
                  placeholder="5.1.1.2SS+3"
                  title={`${linkCount} link${linkCount === 1 ? "" : "s"}. WBS codes separated by commas, with FS, SS, FF or SF and a lag: 5.1.1.2SS+3`}
                  onChange={(e) => setCell(t.id, "predecessors", e.target.value)}
                  onKeyDown={(e) => onCellKeyDown(e, r, ci, t, "predecessors")}
                  ref={(el) => setCellRef(`${r}:${ci}`, el)}
                />
              );
            }
          }
        }
      })}

      <div className="shrink-0 px-1">
        <TaskEditDialog
          projectId={projectId}
          task={t}
          phaseOptions={phaseOptions}
          statusOptions={statusOptions}
          allTasks={allTasks}
          phase1Available={phase1Available}
          calendar={calendar}
          trigger={<Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]">Open</Button>}
        />
      </div>
    </div>
  );
}

const FIELD_OF: Partial<Record<ColumnKey, Field>> = {
  task: "task_name",
  assigned: "assigned_to",
  phase: "phase",
  status: "status",
  dur: "duration_days",
  start: "start_date",
  finish: "end_date",
  predecessors: "predecessors",
};

function RowBadges({
  t, c, constraint, collapsed,
}: {
  t: ScheduleTaskRow;
  c: ReturnType<CpmOutput["byWbs"]["get"]>;
  constraint: TaskConstraintState | undefined;
  collapsed: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {collapsed && (
        <span className="rounded bg-muted px-1 text-[9px] font-medium text-muted-foreground" title="Collapsed">
          &hellip;
        </span>
      )}
      {c?.critical && (
        <span className="rounded bg-destructive/10 px-1 text-[9px] font-medium text-destructive">CP</span>
      )}
      {!c?.critical && c?.nearCritical && (
        <span
          className="rounded bg-amber-100 px-1 text-[9px] font-medium text-amber-900"
          title={`${c.totalFloat} working days of float - this becomes critical next`}
        >
          NEAR
        </span>
      )}
      {c?.isolated && (
        <span
          className="rounded bg-muted px-1 text-[9px] font-medium text-muted-foreground"
          title="No predecessor and no successor. Its float is measured against itself, so it is neither critical nor safe - it is simply not connected to the job."
        >
          UNLINKED
        </span>
      )}
      {t.date_constraint_type && (
        <span
          className="rounded bg-blue-100 px-1 text-[9px] font-medium text-blue-900"
          title={`${t.date_constraint_type} ${t.date_constraint_date}`}
        >
          {t.date_constraint_type}
        </span>
      )}
      {c?.constraintViolation && (
        <span
          className="rounded bg-destructive/10 px-1 text-[9px] font-medium text-destructive"
          title={c.constraintViolation}
        >
          CONFLICT
        </span>
      )}
      {constraint && constraint.open > 0 && (
        <span
          className={cn(
            "rounded px-1 text-[9px] font-medium",
            constraint.overdue > 0 ? "bg-destructive/10 text-destructive" : "bg-amber-100 text-amber-900",
          )}
          title={
            constraint.overdue > 0
              ? `${constraint.open} open constraint${constraint.open === 1 ? "" : "s"}, ${constraint.overdue} past need-by`
              : `${constraint.open} open constraint${constraint.open === 1 ? "" : "s"}${constraint.nextNeedBy ? `, next due ${constraint.nextNeedBy}` : ""}`
          }
        >
          BLOCKED {constraint.open}
        </span>
      )}
    </span>
  );
}

function ProgressCell({ progress }: { progress: Progress }) {
  if (progress.kind === "none") {
    return <span className="text-[11px] text-muted-foreground">No report</span>;
  }
  const pct = Math.max(0, Math.min(100, progress.pct));
  const rolled = progress.kind === "rolled";
  return (
    <div className="flex items-center gap-1.5" title={
      rolled
        ? `Rolled up from ${progress.reported} of ${progress.leaves} leaf tasks, weighted by duration`
        : progress.source === "dpr"
          ? `From an approved field report${progress.at ? ` on ${fmtDate(progress.at.slice(0, 10))}` : ""}`
          : "Set manually rather than from a field report"
    }>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            rolled ? "bg-muted-foreground/50" : progress.source === "dpr" ? "bg-emerald-500" : "bg-amber-500",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right text-[11px] tabular-nums">{Math.round(pct)}%</span>
    </div>
  );
}

function cellCls(dirty: boolean): string {
  return cn(
    "h-6 w-full min-w-0 rounded border bg-transparent px-1 text-sm",
    "focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
    dirty ? "border-amber-400 bg-amber-50/80 font-medium" : "border-transparent hover:border-input",
  );
}

function Check({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
