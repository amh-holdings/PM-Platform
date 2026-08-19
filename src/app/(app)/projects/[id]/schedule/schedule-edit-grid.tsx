"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CalendarLike } from "@/lib/schedule-calendar";
import { parsePredecessors } from "@/lib/schedule-cpm";
import {
  nextChildCode,
  nextTopLevelCode,
  planIndent,
  planMove,
  planOutdent,
  scheduleOrder,
  shiftDates,
  type EditTask,
  type StructurePlan,
} from "@/lib/schedule-edit";
import {
  applyStructurePlan,
  bulkUpdateScheduleTasks,
  deleteScheduleTasks,
  describeTaskDeletion,
  type TaskPatch,
} from "../schedule-actions";
import { TaskEditDialog } from "./task-edit-dialog";
import { hasLinkErrors } from "./predecessor-editor";
import type { ScheduleTaskRow } from "./schedule-table";

// Fields the grid edits in place. Anything not here is either derived
// (float, projected dates), owned by another workflow (progress comes from
// approved field reports, baselines from the baseline action), or too
// structured for a cell (date constraints, the risk flags) and lives in the
// task dialog.
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

type Draft = Record<string, Partial<Record<Field, string>>>;

type Props = {
  projectId: string;
  tasks: ScheduleTaskRow[]; // scoped by the workspace filter
  allTasks: ScheduleTaskRow[]; // whole project, for link validation
  calendar: CalendarLike;
  phaseOptions: string[];
  statusOptions: string[];
  phase1Available: boolean;
};

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

export function ScheduleEditGrid({
  projectId,
  tasks,
  allTasks,
  calendar,
  phaseOptions,
  statusOptions,
  phase1Available,
}: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ tone: "good" | "bad" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<null | Awaited<
    ReturnType<typeof describeTaskDeletion>
  >>(null);
  const [shiftBy, setShiftBy] = useState("5");
  const [, startTransition] = useTransition();
  const cellRefs = useRef(new Map<string, HTMLElement>());

  const ordered = useMemo(() => scheduleOrder(tasks.map(asEdit)), [tasks]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const rows = useMemo(
    () => ordered.map((o) => byId.get(o.id)!).filter(Boolean),
    [ordered, byId],
  );

  const dirtyIds = Object.keys(draft).filter((id) =>
    Object.keys(draft[id] ?? {}).length > 0,
  );
  const dirtyCount = dirtyIds.length;

  const valueOf = useCallback(
    (t: ScheduleTaskRow, f: Field) => draft[t.id]?.[f] ?? raw(t, f),
    [draft],
  );

  const isDirty = (t: ScheduleTaskRow, f: Field) =>
    draft[t.id]?.[f] !== undefined && draft[t.id]?.[f] !== raw(t, f);

  function setCell(id: string, f: Field, v: string) {
    setDraft((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [f]: v } }));
  }

  function discard() {
    setDraft({});
    setMsg(null);
  }

  // ---- keyboard navigation -------------------------------------------------
  // A grid you have to click into cell by cell is a form with borders. Arrow
  // keys move between cells, Enter steps down the column, Escape puts the cell
  // back to what the database says.
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

  // ---- saving --------------------------------------------------------------
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

      // A start after its own finish is not a schedule, and the CPM engine will
      // take it literally rather than reject it.
      const s = patch.start_date ?? t.start_date;
      const e = patch.end_date ?? t.end_date;
      if (typeof s === "string" && typeof e === "string" && s > e) {
        problems.push(`${t.wbs_code}: start ${s} is after finish ${e}.`);
      }

      if (Object.keys(patch).length > 1) patches.push(patch);
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
    setMsg({
      tone: "good",
      text: `${res.count} task${res.count === 1 ? "" : "s"} saved. Float and the projection have been recalculated.`,
    });
    startTransition(() => router.refresh());
  }

  // ---- bulk edits ----------------------------------------------------------
  // These write into the draft rather than straight to the database, so a bulk
  // action lands in the same review-then-save gesture as a hand edit and
  // Discard undoes it.
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

  // ---- structural edits ----------------------------------------------------
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

  const structureBlocked = dirtyCount > 0;

  function structure(kind: "indent" | "outdent" | "up" | "down") {
    if (structureBlocked) {
      setMsg({
        tone: "warn",
        text: "Save or discard your cell edits first - moving a task renumbers WBS codes and the two would fight.",
      });
      return;
    }
    // Structural moves are computed against the whole project. Indenting under
    // a parent that the scope filter is hiding still has to work.
    const all = allTasks.map(asEdit);
    const codes = Array.from(selected).map((id) => byId.get(id)?.wbs_code).filter(Boolean) as string[];
    if (!codes.length) { setMsg({ tone: "warn", text: "Select a row first." }); return; }

    if (kind === "indent") runStructure(planIndent(all, codes), "Indented.");
    else if (kind === "outdent") runStructure(planOutdent(all, codes), "Outdented.");
    else runStructure(planMove(all, codes, kind === "up" ? "up" : "down"), "Moved.");
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

  return (
    <div className="space-y-3">
      {/* ---- toolbar --------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <TaskEditDialog
          projectId={projectId}
          mode="create"
          suggestedWbs={suggestedWbs}
          phaseOptions={phaseOptions}
          statusOptions={statusOptions}
          allTasks={allTasks}
          phase1Available={phase1Available}
          trigger={<Button size="sm">Add task</Button>}
        />

        <span className="mx-1 h-6 w-px bg-border" />

        <span className="text-xs text-muted-foreground">
          {selected.size ? `${selected.size} selected` : "Select rows to edit in bulk"}
        </span>

        <Button variant="outline" size="sm" disabled={!selected.size || busy} onClick={() => structure("up")}>
          ↑ Move up
        </Button>
        <Button variant="outline" size="sm" disabled={!selected.size || busy} onClick={() => structure("down")}>
          ↓ Move down
        </Button>
        <Button variant="outline" size="sm" disabled={!selected.size || busy} onClick={() => structure("indent")}>
          → Indent
        </Button>
        <Button variant="outline" size="sm" disabled={!selected.size || busy} onClick={() => structure("outdent")}>
          ← Outdent
        </Button>

        <span className="mx-1 h-6 w-px bg-border" />

        <div className="flex items-center gap-1">
          <Input
            value={shiftBy}
            onChange={(e) => setShiftBy(e.target.value)}
            className="h-8 w-16"
            title="Working days. Negative pulls the work earlier."
          />
          <Button variant="outline" size="sm" disabled={!selected.size} onClick={bulkShift}>
            Shift dates
          </Button>
        </div>

        <select
          value=""
          disabled={!selected.size}
          onChange={(e) => e.target.value && bulkSet("assigned_to", e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">Set assigned to...</option>
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
          className="text-destructive hover:text-destructive"
          disabled={!selected.size || busy}
          onClick={askDelete}
        >
          Delete
        </Button>
      </div>

      {/* ---- unsaved bar ------------------------------------------------ */}
      {dirtyCount > 0 && (
        <div className="sticky top-2 z-30 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 shadow-sm">
          <span className="font-medium">
            {dirtyCount} row{dirtyCount === 1 ? "" : "s"} changed and not yet saved
          </span>
          <span className="text-xs">
            Nothing is written until you save, so the forecast still shows the
            committed schedule.
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={discard} disabled={busy}>
              Discard
            </Button>
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? "Saving..." : `Save ${dirtyCount} row${dirtyCount === 1 ? "" : "s"}`}
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

      {confirmDelete && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">
            Delete {selected.size} task{selected.size === 1 ? "" : "s"}?
          </p>
          {confirmDelete.ok ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {confirmDelete.children > 0 && (
                <li className="text-destructive">
                  {confirmDelete.children} subtask
                  {confirmDelete.children === 1 ? "" : "s"} sit beneath the
                  selection and are NOT included. They would be orphaned - select
                  them too, or outdent them first.
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
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
              Keep them
            </Button>
          </div>
        </div>
      )}

      {/* ---- grid -------------------------------------------------------- */}
      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                  }
                  title="Select all visible rows"
                />
              </th>
              <th className="px-2 py-2 font-medium">Code</th>
              <th className="min-w-[16rem] px-2 py-2 font-medium">Task</th>
              <th className="px-2 py-2 font-medium">Assigned</th>
              <th className="px-2 py-2 font-medium">Phase</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="w-20 px-2 py-2 font-medium">Dur</th>
              <th className="px-2 py-2 font-medium">Start</th>
              <th className="px-2 py-2 font-medium">Finish</th>
              <th className="min-w-[12rem] px-2 py-2 font-medium">Predecessors</th>
              <th className="px-2 py-2 text-right font-medium">More</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No tasks in this scope yet. Use Add task, or Import rows to
                  paste a sheet.
                </td>
              </tr>
            ) : (
              rows.map((t, r) => {
                const indent = Math.max(0, (t.level_code ?? 1) - 1) * 12;
                const rowDirty = Object.keys(draft[t.id] ?? {}).some((f) =>
                  isDirty(t, f as Field),
                );
                const linkCount = parsePredecessors(valueOf(t, "predecessors")).length;

                return (
                  <tr
                    key={t.id}
                    className={cn(
                      "hover:bg-muted/20",
                      selected.has(t.id) && "bg-blue-50/60",
                      rowDirty && "bg-amber-50/60",
                    )}
                  >
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(t.id);
                            else next.delete(t.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-xs text-muted-foreground">
                      {t.wbs_code}
                    </td>

                    <td className="px-1 py-1">
                      <input
                        style={{ paddingLeft: 6 + indent }}
                        className={cellCls(isDirty(t, "task_name"))}
                        value={valueOf(t, "task_name")}
                        onChange={(e) => setCell(t.id, "task_name", e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r, 0, t, "task_name")}
                        ref={(el) => setCellRef(`${r}:0`, el)}
                      />
                    </td>

                    <td className="px-1 py-1">
                      <input
                        className={cellCls(isDirty(t, "assigned_to"))}
                        value={valueOf(t, "assigned_to")}
                        onChange={(e) => setCell(t.id, "assigned_to", e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r, 1, t, "assigned_to")}
                        ref={(el) => setCellRef(`${r}:1`, el)}
                      />
                    </td>

                    <td className="px-1 py-1">
                      <input
                        list="phase-options"
                        className={cellCls(isDirty(t, "phase"))}
                        value={valueOf(t, "phase")}
                        onChange={(e) => setCell(t.id, "phase", e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r, 2, t, "phase")}
                        ref={(el) => setCellRef(`${r}:2`, el)}
                      />
                    </td>

                    <td className="px-1 py-1">
                      <select
                        className={cellCls(isDirty(t, "status"))}
                        value={valueOf(t, "status")}
                        onChange={(e) => setCell(t.id, "status", e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r, 3, t, "status")}
                        ref={(el) => setCellRef(`${r}:3`, el)}
                      >
                        <option value="">-</option>
                        {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>

                    <td className="px-1 py-1">
                      <input
                        className={cn(cellCls(isDirty(t, "duration_days")), "tabular-nums")}
                        value={valueOf(t, "duration_days")}
                        onChange={(e) => setCell(t.id, "duration_days", e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r, 4, t, "duration_days")}
                        ref={(el) => setCellRef(`${r}:4`, el)}
                      />
                    </td>

                    <td className="px-1 py-1">
                      <input
                        type="date"
                        className={cellCls(isDirty(t, "start_date"))}
                        value={valueOf(t, "start_date")}
                        onChange={(e) => setCell(t.id, "start_date", e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r, 5, t, "start_date")}
                        ref={(el) => setCellRef(`${r}:5`, el)}
                      />
                    </td>

                    <td className="px-1 py-1">
                      <input
                        type="date"
                        className={cellCls(isDirty(t, "end_date"))}
                        value={valueOf(t, "end_date")}
                        onChange={(e) => setCell(t.id, "end_date", e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r, 6, t, "end_date")}
                        ref={(el) => setCellRef(`${r}:6`, el)}
                      />
                    </td>

                    <td className="px-1 py-1">
                      <input
                        className={cn(cellCls(isDirty(t, "predecessors")), "font-mono text-xs")}
                        value={valueOf(t, "predecessors")}
                        placeholder="5.1.1.2SS+3"
                        title={`${linkCount} link${linkCount === 1 ? "" : "s"}. Type WBS codes separated by commas, with FS, SS, FF or SF and a lag: 5.1.1.2SS+3`}
                        onChange={(e) => setCell(t.id, "predecessors", e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r, 7, t, "predecessors")}
                        ref={(el) => setCellRef(`${r}:7`, el)}
                      />
                    </td>

                    <td className="px-2 py-1 text-right">
                      <TaskEditDialog
                        projectId={projectId}
                        task={t}
                        phaseOptions={phaseOptions}
                        statusOptions={statusOptions}
                        allTasks={allTasks}
                        phase1Available={phase1Available}
                        trigger={<Button variant="ghost" size="sm">Open</Button>}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <datalist id="phase-options">
        {phaseOptions.map((p) => <option key={p} value={p} />)}
      </datalist>

      <p className="text-xs text-muted-foreground">
        Arrow keys and Enter move between cells; Escape puts a cell back. Bulk
        actions land in the same unsaved state as a typed edit, so Discard undoes
        them. Progress is not editable here - it comes from approved field
        reports, and a schedule you can type a percentage into is a schedule
        nobody believes. Indent and outdent renumber the moved branch only,
        leaving a gap in the sibling numbering on purpose: a WBS code is an
        identifier other records point at, and row order is kept separately.
      </p>
    </div>
  );
}

function cellCls(dirty: boolean): string {
  return cn(
    "h-8 w-full rounded border bg-transparent px-1.5 text-sm",
    "focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
    dirty ? "border-amber-400 bg-amber-50/80 font-medium" : "border-transparent hover:border-input",
  );
}
