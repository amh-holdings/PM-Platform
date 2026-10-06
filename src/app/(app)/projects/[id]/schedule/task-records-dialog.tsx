"use client";

// Everything the platform knows about one schedule task, over the grid.
//
// The schedule could always tell you a task was 65% complete and on the
// critical path. It could never tell you why. The evidence - an approved
// inspection, the photographs the CM accepted it on, the report that pinned
// the percent - has pointed at `schedule_task_id` since those tables were
// built, and nothing on the schedule side ever read it back. Substantiating a
// billed percent meant walking the Inspections tab by hand.
//
// A popup rather than a page, deliberately. The grid keeps its scroll
// position, its scope filter and its collapsed branches, and the arrow keys
// walk down the schedule reading each task's records in turn - which is how a
// scope actually gets reviewed before a meeting, and the one thing a popup
// does better than a route.
//
// It READS. Nothing in here writes a percent, a date or a predecessor: those
// still belong to approved field reports and the edit dialog. The only writes
// are attaching and detaching a document, which touch the join table and
// nothing else.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DOCUMENT_CATEGORY_LABEL, type DocumentCategory } from "../documents-constants";
import {
  daysSinceReport,
  emptyEvidenceReason,
  taskRecordsAlert,
  type TaskPhoto,
  type TaskRecords,
} from "@/lib/schedule-task-records";
import {
  attachDocumentToTask,
  detachDocumentFromTask,
  getAttachableDocuments,
  getTaskRecords,
  type AttachableDocument,
} from "../schedule-task-records-actions";

type TabKey = "details" | "evidence" | "photos" | "reports" | "logic" | "documents";

const TABS: { key: TabKey; label: string }[] = [
  { key: "details", label: "Details" },
  { key: "evidence", label: "Evidence" },
  { key: "photos", label: "Photos" },
  { key: "reports", label: "Reports" },
  { key: "logic", label: "Logic & links" },
  { key: "documents", label: "Documents" },
];

export type RecordsDialogTask = {
  id: string;
  wbs_code: string;
  task_name: string;
  task_type: string | null;
  status: string | null;
  assigned_to: string | null;
  phase: string | null;
  duration_days: number | null;
  start_date: string | null;
  end_date: string | null;
  baseline_end?: string | null;
  pct_complete: number | null;
  status_source: string | null;
  last_report_date?: string | null;
  is_milestone?: boolean | null;
  isSummary: boolean;
  critical: boolean;
  totalFloat: number | null;
  freeFloat: number | null;
  isolated: boolean;
};

type Props = {
  projectId: string;
  task: RecordsDialogTask;
  dataDate: string;
  /** Row n of m, so the popup can say where you are in the scope. */
  position: { index: number; total: number };
  onClose: () => void;
  /** Null at the ends of the list, which disables the arrow. */
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  /**
   * The edit form, rendered as the Details tab.
   *
   * Passed in as a node rather than threaded through as a dozen props. The row
   * used to carry this as a separate "Open" button beside the Records badge,
   * which meant two controls a hand's width apart, neither label saying which
   * one had the photographs behind it. One control, one surface.
   */
  details: React.ReactNode;
  /**
   * Whether the grid's badge said this task has anything, known before the
   * records finish loading. It picks the opening tab: a row with evidence
   * opens on it, a row with none opens on Details, because landing on an empty
   * Evidence pane to be told there is nothing is a wasted click on the 130 of
   * 152 Sweet Springs rows that have no photographs yet.
   */
  hasAnyRecords?: boolean;
};

export function TaskRecordsDialog({
  projectId,
  task,
  dataDate,
  position,
  onClose,
  onPrev,
  onNext,
  details,
  hasAnyRecords = false,
}: Props) {
  const openingTab: TabKey = hasAnyRecords ? "evidence" : "details";
  const [tab, setTab] = useState<TabKey>(openingTab);
  const [records, setRecords] = useState<TaskRecords | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getTaskRecords(projectId, task.id);
    if (!res.ok) {
      setError(res.error);
      setRecords(null);
    } else {
      setRecords(res.records);
    }
    setLoading(false);
  }, [projectId, task.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Moving to another task resets to Evidence. Keeping the tab across tasks
  // sounds helpful and is not: arrowing down a scope on the Documents tab
  // shows four empty panels in a row and reads as though nothing is attached
  // anywhere.
  useEffect(() => {
    setTab(openingTab);
    panelRef.current?.scrollTo({ top: 0 });
  }, [task.id, openingTab]);

  // Escape closes, arrows walk the scope. Arrows are ignored while focus is in
  // a text box, or filtering the document picker would jump to another task on
  // every keystroke.
  //
  // And both are ignored entirely while the Edit dialog is open on top of this
  // one. That dialog renders inside this subtree, so a window-level Escape
  // here would close THIS popup and take the edit form down with it, throwing
  // away whatever had been typed into it without asking. Whichever overlay is
  // on top owns the keyboard; this one steps back when something is above it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (rootRef.current?.querySelector(".fixed.inset-0")) return;
      const el = e.target as HTMLElement | null;
      const typing =
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (typing) return;
      if (e.key === "ArrowDown" && onNext) {
        e.preventDefault();
        onNext();
      }
      if (e.key === "ArrowUp" && onPrev) {
        e.preventDefault();
        onPrev();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNext, onPrev]);

  const counts: Record<TabKey, number> = {
    details: 0,
    evidence: records?.evidence.length ?? 0,
    photos: records?.photos.length ?? 0,
    reports: records?.pins.length ?? 0,
    logic:
      (records?.predecessors.length ?? 0) +
      (records?.successors.length ?? 0) +
      (records?.constraints.length ?? 0) +
      (records?.deliveries.length ?? 0),
    documents: records?.documents.length ?? 0,
  };

  const openConstraints =
    records?.constraints.filter((c) => c.status === "open").length ?? 0;

  const alert = taskRecordsAlert({
    taskType: task.task_type,
    status: task.status,
    isSummary: task.isSummary,
    predecessorCount: records?.predecessors.length ?? 0,
    successorCount: records?.successors.length ?? 0,
    lastReportDate: task.last_report_date,
    dataDate,
    openConstraints,
    critical: task.critical,
  });

  const stale = daysSinceReport(task.last_report_date, dataDate);

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${task.wbs_code} ${task.task_name}`}
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-background shadow-xl"
      >
        {/* ---- header, which does not scroll ---- */}
        <div className="shrink-0 border-b px-5 pt-4">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs text-muted-foreground">{task.wbs_code}</p>
              <h3 className="truncate text-lg font-semibold" title={task.task_name}>
                {task.is_milestone ? "◆ " : ""}
                {task.task_name}
              </h3>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Tag>{task.isSummary ? "Summary" : typeLabel(task.task_type)}</Tag>
                {task.status && (
                  <Tag
                    tone={
                      task.status === "Complete"
                        ? "good"
                        : task.status === "In Progress"
                          ? "warn"
                          : "flat"
                    }
                  >
                    {task.status}
                  </Tag>
                )}
                {task.critical && <Tag tone="bad">CRITICAL</Tag>}
                {task.isolated && <Tag>UNLINKED</Tag>}
                {openConstraints > 0 && <Tag tone="warn">BLOCKED</Tag>}
                {task.assigned_to && <Tag>{task.assigned_to}</Tag>}
                {task.phase && <Tag>{task.phase}</Tag>}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => onPrev?.()}
                disabled={!onPrev}
                className="h-7 w-7 rounded border text-xs text-muted-foreground hover:bg-muted disabled:opacity-30"
                title="Previous task (up arrow)"
              >
                ↑
              </button>
              <button
                onClick={() => onNext?.()}
                disabled={!onNext}
                className="h-7 w-7 rounded border text-xs text-muted-foreground hover:bg-muted disabled:opacity-30"
                title="Next task (down arrow)"
              >
                ↓
              </button>
              <button
                onClick={onClose}
                className="h-7 w-7 rounded border text-sm text-muted-foreground hover:bg-muted"
                aria-label="Close"
                title="Close (Esc)"
              >
                ×
              </button>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat k="Progress">
              {task.pct_complete == null ? (
                <span className="text-xs text-muted-foreground">No report</span>
              ) : (
                <>
                  {Math.round(Number(task.pct_complete))}%
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                    {task.status_source === "manual"
                      ? "typed"
                      : task.isSummary
                        ? "rolled up"
                        : "report"}
                  </span>
                </>
              )}
            </Stat>
            <Stat k="Duration">
              {task.duration_days ?? "-"}
              <span className="text-[10px] font-normal text-muted-foreground">d</span>
            </Stat>
            <Stat k="Start">{fmtDate(task.start_date)}</Stat>
            <Stat k="Finish">{fmtDate(task.end_date)}</Stat>
            <Stat k="Float t/f">
              {task.isolated
                ? "floats"
                : task.totalFloat == null
                  ? "-"
                  : `${task.totalFloat}/${task.freeFloat ?? 0}`}
            </Stat>
            <Stat k="Last report">
              {task.last_report_date ? (
                <span title={`${stale} days before the data date`}>
                  {fmtDate(task.last_report_date)}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">never</span>
              )}
            </Stat>
          </div>

          {alert && (
            <div
              className={cn(
                "mt-3 rounded-md border px-3 py-2 text-xs",
                alert.tone === "bad"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-amber-300 bg-amber-50 text-amber-900",
              )}
            >
              {alert.text}
            </div>
          )}

          <div className="mt-3 flex gap-1 overflow-x-auto" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "shrink-0 border-b-2 px-3 pb-2 pt-1.5 text-xs font-medium",
                  tab === t.key
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
                {/* The count is on the tab so an empty section can be seen
                    without opening it. Four empty tabs in a row is a fact
                    about the task, and it should not take four clicks. */}
                {!loading && counts[t.key] > 0 && (
                  <span
                    className={cn(
                      "ml-1.5 rounded-full px-1.5 text-[10px] font-semibold",
                      tab === t.key
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {counts[t.key]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* ---- body, which does ---- */}
        <div ref={panelRef} className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4">
          {loading && tab !== "details" && (
            <p className="text-sm text-muted-foreground">Loading records...</p>
          )}

          {error && tab !== "details" && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
              <button onClick={() => void load()} className="ml-2 underline">
                Try again
              </button>
            </div>
          )}

          {tab === "details" && (
            <div className="rounded-lg border bg-background p-4 shadow-sm">{details}</div>
          )}

          {!loading && !error && records && (
            <>
              {tab === "evidence" && <EvidencePane task={task} records={records} />}
              {tab === "photos" && <PhotosPane records={records} />}
              {tab === "reports" && <ReportsPane records={records} stale={stale} />}
              {tab === "logic" && <LogicPane records={records} />}
              {tab === "documents" && (
                <DocumentsPane
                  projectId={projectId}
                  taskId={task.id}
                  records={records}
                  onChanged={load}
                />
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-5 py-2.5">
          <span className="font-mono text-[11px] text-muted-foreground">
            Row {position.index + 1} of {position.total}
          </span>
          <span className="ml-auto" />
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Panes
// ===========================================================================

function EvidencePane({
  task,
  records,
}: {
  task: RecordsDialogTask;
  records: TaskRecords;
}) {
  const reason = emptyEvidenceReason({
    evidenceCount: records.evidence.length,
    taskType: task.task_type,
    isSummary: task.isSummary,
  });

  if (reason) return <Card><Empty>{reason}</Empty></Card>;

  return (
    <div className="space-y-3">
      {records.evidence.map((e) => (
        <Card key={e.id}>
          <div className="p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium">{e.title}</span>
              <Tag tone="good">APPROVED</Tag>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {fmtDate(e.reportDate ?? e.decidedAt)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
              {e.inspectionType && <span>{e.inspectionType}</span>}
              {e.quantity != null && (
                <span>
                  {Number(e.quantity).toLocaleString()} {e.unitOfMeasure ?? ""}
                </span>
              )}
              {e.pinnedPct != null && (
                <span className="font-medium text-emerald-700">
                  pinned {Math.round(Number(e.pinnedPct))}%
                </span>
              )}
              <Link href={e.href} className="underline hover:text-foreground">
                Open inspection
              </Link>
            </div>
            {e.notes && <p className="mt-2 text-xs text-muted-foreground">{e.notes}</p>}
            {e.decisionNotes && (
              <p className="mt-1 text-xs text-muted-foreground">
                Review note: {e.decisionNotes}
              </p>
            )}
            {e.photos.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {e.photos.map((p) => (
                  <Thumb key={p.id} photo={p} />
                ))}
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function PhotosPane({ records }: { records: TaskRecords }) {
  if (!records.photos.length) {
    return (
      <Card>
        <Empty>
          No photographs on this task. Pictures arrive with an approved
          inspection or the field report that pinned it, and neither has reached
          this row.
        </Empty>
      </Card>
    );
  }
  return (
    <Card>
      <CardHead
        title="All photos on this task"
        meta={`${records.photos.length} image${records.photos.length === 1 ? "" : "s"}`}
      />
      <div className="grid grid-cols-2 gap-2.5 p-3 sm:grid-cols-3 lg:grid-cols-4">
        {records.photos.map((p) => (
          <Thumb key={`${p.source}-${p.id}`} photo={p} large />
        ))}
      </div>
    </Card>
  );
}

function ReportsPane({ records, stale }: { records: TaskRecords; stale: number | null }) {
  if (!records.pins.length) {
    return <Card><Empty>No field report has ever pinned this task.</Empty></Card>;
  }
  const moved = records.pins.filter((p) => p.moved).length;
  return (
    <Card>
      <CardHead
        title="Field report history"
        meta={`${records.pins.length} pin${records.pins.length === 1 ? "" : "s"}, ${moved} moved the percent`}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2">Report date</th>
              <th className="px-3 py-2">Percent</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Note</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {records.pins.map((p) => (
              <tr key={p.id} className="border-b last:border-0">
                <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums">
                  {fmtDate(p.reportDate)}
                </td>
                <td
                  className={cn(
                    "whitespace-nowrap px-3 py-2 font-mono tabular-nums",
                    p.moved ? "font-medium text-emerald-700" : "text-muted-foreground",
                  )}
                >
                  {p.previousPct == null ? "-" : Math.round(Number(p.previousPct))}
                  {" → "}
                  {p.newPct == null ? "-" : Math.round(Number(p.newPct))}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                  {p.newStatus ?? "-"}
                </td>
                <td className="px-3 py-2">{p.notes ?? ""}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Link href={p.href} className="text-[11px] underline text-muted-foreground hover:text-foreground">
                    Report
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Reported repeatedly without moving is the quieter half of the
          under-billing in BACKLOG.md - Debris Removal was reported almost
          daily for a month and read 10% every time. The count above says it;
          this says why it matters. */}
      {records.pins.length >= 3 && moved < records.pins.length / 2 && (
        <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
          More than half of these reports did not move the percent. A task being
          reported is not the same as a task progressing, and only the ones that
          moved reach a pay application.
        </p>
      )}
      {stale != null && stale > 7 && (
        <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
          Last approved report was {stale} days before the data date.
        </p>
      )}
    </Card>
  );
}

function LogicPane({ records }: { records: TaskRecords }) {
  const nothing = !records.predecessors.length && !records.successors.length;
  return (
    <div className="space-y-3">
      <Card>
        <CardHead
          title="Logic"
          meta={`${records.predecessors.length} in, ${records.successors.length} out`}
        />
        {nothing ? (
          <Empty>
            Nothing drives this task and nothing waits on it, so the engine keeps
            it off the critical path and out of the project finish date. A slip
            here moves nothing and nothing moves it.
          </Empty>
        ) : (
          <>
            <SubHead>After - {records.predecessors.length}</SubHead>
            {records.predecessors.length ? (
              records.predecessors.map((l, i) => <LinkRow key={`p${i}`} link={l} />)
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">No predecessor.</p>
            )}
            <SubHead>Drives - {records.successors.length}</SubHead>
            {records.successors.length ? (
              records.successors.map((l, i) => <LinkRow key={`s${i}`} link={l} />)
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                No successor. Nothing in the schedule is waiting on this.
              </p>
            )}
          </>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHead title="Constraints" />
          {records.constraints.length ? (
            records.constraints.map((c) => (
              <div key={c.id} className="flex items-center gap-2 border-b px-3 py-2 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs" title={c.title}>{c.title}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {[c.category, c.owner, c.needBy ? `need by ${fmtDate(c.needBy)}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Tag tone={c.status === "open" ? "warn" : "good"}>
                  {c.status === "open" ? "OPEN" : "CLEARED"}
                </Tag>
              </div>
            ))
          ) : (
            <Empty>Nothing in the way.</Empty>
          )}
        </Card>

        <Card>
          <CardHead title="Procurement" />
          {records.deliveries.length ? (
            <>
              {records.deliveries.map((d) => (
                <div key={d.id} className="border-b px-3 py-2 last:border-0">
                  <div className="flex items-baseline gap-2">
                    <Link href={d.href} className="truncate text-xs underline">
                      {d.poNumber ?? d.vendor ?? "PO"}
                    </Link>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {d.deliveredDate
                        ? `delivered ${fmtDate(d.deliveredDate)}`
                        : d.promisedDate
                          ? `due ${fmtDate(d.promisedDate)}`
                          : "no date"}
                    </span>
                  </div>
                  {d.vendor && d.poNumber && (
                    <p className="font-mono text-[10px] text-muted-foreground">{d.vendor}</p>
                  )}
                </div>
              ))}
              <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
                Marking this row complete writes the delivery date onto the PO,
                and the pay application picks it up.
              </p>
            </>
          ) : (
            <Empty>No purchase order delivers this task.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}

function DocumentsPane({
  projectId,
  taskId,
  records,
  onChanged,
}: {
  projectId: string;
  taskId: string;
  records: TaskRecords;
  onChanged: () => Promise<void> | void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [picking, setPicking] = useState(false);
  const [options, setOptions] = useState<AttachableDocument[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!records.notes.documentsEnabled) {
    return (
      <Card>
        <Empty>
          <b className="font-medium text-foreground">Not enabled yet.</b> Attaching
          documents to a task needs migration 0069 applied. Everything else on
          this popup reads records that already exist and works without it.
        </Empty>
      </Card>
    );
  }

  async function openPicker() {
    setPicking(true);
    setErr(null);
    const res = await getAttachableDocuments(projectId, taskId);
    if (!res.ok) {
      setErr(res.error);
      setOptions([]);
      return;
    }
    setOptions(res.documents);
  }

  async function attach(documentId: string) {
    setBusy(true);
    setErr(null);
    const res = await attachDocumentToTask(projectId, taskId, documentId);
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    setPicking(false);
    setOptions(null);
    setQuery("");
    await onChanged();
    startTransition(() => router.refresh());
  }

  async function detach(linkId: string) {
    setBusy(true);
    setErr(null);
    const res = await detachDocumentFromTask(projectId, linkId);
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    await onChanged();
    startTransition(() => router.refresh());
  }

  const filtered = (options ?? []).filter((d) =>
    query.trim()
      ? d.fileName.toLowerCase().includes(query.trim().toLowerCase())
      : true,
  );

  return (
    <Card>
      <CardHead
        title="Documents on this task"
        meta={`${records.documents.length} attached`}
      />

      {records.documents.length ? (
        records.documents.map((d) => (
          <div key={d.linkId} className="flex items-center gap-2 border-b px-3 py-2 last:border-0">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs" title={d.fileName}>{d.fileName}</p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {[
                  DOCUMENT_CATEGORY_LABEL[d.category as DocumentCategory] ?? d.category,
                  d.uploadedAt ? fmtDate(d.uploadedAt.slice(0, 10)) : null,
                  d.sizeBytes ? formatBytes(d.sizeBytes) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <button
              onClick={() => void detach(d.linkId)}
              disabled={busy}
              className="shrink-0 text-[11px] text-muted-foreground underline hover:text-destructive disabled:opacity-40"
              title="Remove the link. The file stays in the document library."
            >
              Detach
            </button>
          </div>
        ))
      ) : (
        <Empty>Nothing attached yet.</Empty>
      )}

      {err && (
        <p className="border-t bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{err}</p>
      )}

      <div className="border-t p-3">
        {!picking ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void openPicker()}>
              Attach from library
            </Button>
            <Link
              href={`/projects/${projectId}/documents`}
              className="text-[11px] text-muted-foreground underline hover:text-foreground"
            >
              Upload a new document
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by file name"
                className="h-8 text-xs"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPicking(false);
                  setOptions(null);
                  setQuery("");
                }}
              >
                Cancel
              </Button>
            </div>
            {options === null ? (
              <p className="text-xs text-muted-foreground">Loading the library...</p>
            ) : filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {options.length === 0
                  ? "Every document in the library is already attached to this task."
                  : "Nothing matches that."}
              </p>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded border">
                {filtered.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => void attach(d.id)}
                    disabled={busy}
                    className="flex w-full items-center gap-2 border-b px-2.5 py-1.5 text-left last:border-0 hover:bg-muted disabled:opacity-40"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">{d.fileName}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {DOCUMENT_CATEGORY_LABEL[d.category as DocumentCategory] ?? d.category}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ===========================================================================
// Small shared pieces
// ===========================================================================

function Card({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-lg border bg-background shadow-sm">{children}</div>;
}

function CardHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b bg-muted/40 px-3 py-2">
      <h4 className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      {meta && <span className="ml-auto font-mono text-[10px] text-muted-foreground">{meta}</span>}
    </div>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b bg-muted/40 px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-xs text-muted-foreground">{children}</p>;
}

function LinkRow({
  link,
}: {
  link: TaskRecords["predecessors"][number];
}) {
  return (
    <div className="flex items-baseline gap-2 border-b px-3 py-2 text-xs last:border-0">
      <span className="shrink-0 rounded border bg-muted px-1 font-mono text-[9px] font-semibold text-muted-foreground">
        {link.type}
        {link.lag ? (link.lag > 0 ? `+${link.lag}` : link.lag) : ""}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{link.wbsCode}</span>
      <span className={cn("min-w-0 truncate", link.dangling && "text-amber-700")}>
        {link.taskName}
      </span>
      {link.dangling && (
        <span
          className="ml-auto shrink-0 font-mono text-[10px] text-amber-700"
          title="The engine discards a link it cannot resolve, which frees this task to start on day one."
        >
          does not resolve
        </span>
      )}
    </div>
  );
}

function Thumb({ photo, large = false }: { photo: TaskPhoto; large?: boolean }) {
  const body = (
    <>
      <span
        className={cn(
          "block overflow-hidden rounded-t bg-muted",
          large ? "h-28" : "h-16 w-24",
        )}
      >
        {photo.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo.url}
            alt={photo.caption ?? "Site photograph"}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[9px] text-muted-foreground">
            unavailable
          </span>
        )}
      </span>
      <span
        className={cn(
          "block border-t px-1.5 py-1 font-mono text-[9px] leading-tight text-muted-foreground",
          large ? "" : "w-24 truncate",
        )}
      >
        {photo.caption ? <span className="text-foreground">{photo.caption}</span> : null}
        {large && (
          <span className="mt-0.5 block">{photo.sourceLabel}</span>
        )}
      </span>
    </>
  );

  const cls = cn(
    "block overflow-hidden rounded border bg-background text-left hover:border-foreground/40",
    large ? "w-full" : "w-24",
  );

  if (!photo.href) return <span className={cls}>{body}</span>;
  return (
    <Link href={photo.href} className={cls} title={photo.caption ?? photo.sourceLabel}>
      {body}
    </Link>
  );
}

function Tag({
  children,
  tone = "flat",
}: {
  children: React.ReactNode;
  tone?: "flat" | "good" | "warn" | "bad";
}) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold",
        tone === "good" && "bg-emerald-50 text-emerald-700",
        tone === "warn" && "bg-amber-50 text-amber-800",
        tone === "bad" && "bg-destructive/10 text-destructive",
        tone === "flat" && "border bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function Stat({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="block font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
        {k}
      </span>
      <span className="font-mono text-sm tabular-nums">{children}</span>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso.slice(0, 10);
  return `${d} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

function typeLabel(t: string | null): string {
  if (!t) return "No type";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
