"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TaskEditDialog, type TaskFormValues } from "./task-edit-dialog";

type Task = TaskFormValues & {
  sort_order: number | null;
  level_code: number | null;
};

type Props = {
  projectId: string;
  tasks: Task[];
};

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
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
    timeZone: "UTC",
  });
}

export function ScheduleTable({ projectId, tasks }: Props) {
  const [phaseFilter, setPhaseFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [hideComplete, setHideComplete] = useState(true);
  const [hideInternal, setHideInternal] = useState(false);

  const phaseOptions = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.phase).filter(Boolean))) as string[],
    [tasks],
  );
  const statusOptions = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.status).filter(Boolean))) as string[],
    [tasks],
  );

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (statusFilter && t.status !== statusFilter) return false;
      if (hideComplete && t.status === "Complete") return false;
      if (hideInternal && t.is_internal) return false;
      return true;
    });
  }, [tasks, phaseFilter, statusFilter, hideComplete, hideInternal]);

  const counts = useMemo(() => {
    const total = tasks.length;
    const complete = tasks.filter((t) => t.status === "Complete").length;
    const inProgress = tasks.filter((t) => t.status === "In Progress").length;
    const atRisk = tasks.filter((t) => t.is_at_risk).length;
    return { total, complete, inProgress, atRisk };
  }, [tasks]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total" value={counts.total} />
        <Stat label="Complete" value={counts.complete} tone="emerald" />
        <Stat label="In progress" value={counts.inProgress} tone="blue" />
        <Stat label="At risk" value={counts.atRisk} tone="destructive" />
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">Phase</label>
          <select
            value={phaseFilter}
            onChange={(e) => setPhaseFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">All</option>
            {phaseOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">All</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hideComplete} onChange={(e) => setHideComplete(e.target.checked)} />
          Hide complete
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hideInternal} onChange={(e) => setHideInternal(e.target.checked)} />
          Hide internal
        </label>
        <span className="ml-auto text-xs text-muted-foreground">
          Showing {filtered.length} of {tasks.length}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-3 font-medium">Code</th>
              <th className="px-3 py-3 font-medium">Task</th>
              <th className="px-3 py-3 font-medium">Phase</th>
              <th className="px-3 py-3 font-medium">Assigned</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 font-medium">Start</th>
              <th className="px-3 py-3 font-medium">End</th>
              <th className="px-3 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No tasks match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((t) => {
                const indent = Math.max(0, (t.level_code ?? 1) - 1) * 16;
                return (
                  <tr key={t.id} className={cn("hover:bg-muted/30", t.is_at_risk && "bg-destructive/5")}>
                    <td className="px-3 py-2.5 font-mono text-xs">{t.wbs_code}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1" style={{ paddingLeft: indent }}>
                        <span className="font-medium">{t.task_name}</span>
                        {t.is_at_risk && (
                          <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                            At risk
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{t.phase ?? "-"}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{t.assigned_to ?? "-"}</td>
                    <td className="px-3 py-2.5">
                      {t.status ? (
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                            STATUS_TONE[t.status] ?? "bg-muted text-muted-foreground",
                          )}
                        >
                          {t.status}
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(t.start_date)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(t.end_date)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <TaskEditDialog
                        projectId={projectId}
                        task={t}
                        phaseOptions={phaseOptions}
                        statusOptions={statusOptions}
                        trigger={
                          <Button variant="ghost" size="sm">Edit</Button>
                        }
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "emerald" | "blue" | "destructive" }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3 shadow-sm">
      <div className={cn(
        "text-2xl font-semibold tabular-nums",
        tone === "emerald" && "text-emerald-700",
        tone === "blue" && "text-blue-700",
        tone === "destructive" && "text-destructive",
      )}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
