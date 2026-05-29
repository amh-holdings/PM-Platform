"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { submitDpr } from "../../dpr-actions";

const STATUS_OPTIONS = [
  "Not Started",
  "In Progress",
  "Complete",
  "Awaiting",
  "Approved",
  "Rejected",
];

type Task = {
  id: string;
  wbsCode: string;
  taskName: string;
  phase: string | null;
  currentStatus: string | null;
  currentPct: number | null;
  endDate: string | null;
};

type Props = {
  projectId: string;
  tasks: Task[];
};

type TaskUpdate = {
  taskId: string;
  newStatus: string;
  newPct: string;
  installed: string;
  notes: string;
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function DprForm({ projectId, tasks }: Props) {
  const router = useRouter();
  const [reportDate, setReportDate] = useState(todayIso());
  const [narrative, setNarrative] = useState("");
  const [crewCount, setCrewCount] = useState("");
  const [hours, setHours] = useState("");
  const [weather, setWeather] = useState("");
  const [safetyIncident, setSafetyIncident] = useState(false);
  const [nearMiss, setNearMiss] = useState(false);
  const [safetyNarrative, setSafetyNarrative] = useState("");
  const [search, setSearch] = useState("");
  const [updates, setUpdates] = useState<Map<string, TaskUpdate>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.wbsCode.toLowerCase().includes(q) ||
        t.taskName.toLowerCase().includes(q) ||
        (t.phase ?? "").toLowerCase().includes(q),
    );
  }, [tasks, search]);

  function toggleTask(t: Task) {
    setUpdates((prev) => {
      const next = new Map(prev);
      if (next.has(t.id)) {
        next.delete(t.id);
      } else {
        next.set(t.id, {
          taskId: t.id,
          newStatus: t.currentStatus === "Complete" ? "Complete" : "In Progress",
          newPct: t.currentPct != null ? String(t.currentPct) : "",
          installed: "",
          notes: "",
        });
      }
      return next;
    });
  }

  function patchUpdate(taskId: string, patch: Partial<TaskUpdate>) {
    setUpdates((prev) => {
      const next = new Map(prev);
      const cur = next.get(taskId);
      if (!cur) return prev;
      next.set(taskId, { ...cur, ...patch });
      return next;
    });
  }

  async function onSubmit() {
    setError(null);
    if (!narrative.trim()) {
      setError("Work narrative is required");
      return;
    }
    if (updates.size === 0) {
      setError("Pick at least one schedule task that was worked on");
      return;
    }
    setSubmitting(true);
    const res = await submitDpr({
      projectId,
      reportDate,
      workNarrative: narrative,
      crewCount: crewCount ? Number(crewCount) : null,
      totalManHours: hours ? Number(hours) : null,
      weatherConditions: weather || null,
      safetyIncident,
      nearMiss,
      safetyNarrative: safetyNarrative || null,
      taskUpdates: Array.from(updates.values()).map((u) => ({
        scheduleTaskId: u.taskId,
        newStatus: u.newStatus || null,
        newPctComplete: u.newPct ? Number(u.newPct) : null,
        installedQuantity: u.installed ? Number(u.installed) : null,
        notes: u.notes || null,
      })),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => {
      router.push(`/projects/${projectId}/dprs/${res.dprId}`);
    });
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">Day details</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="dpr-date">Report date</Label>
            <Input
              id="dpr-date"
              type="date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="dpr-crew">Crew count</Label>
            <Input
              id="dpr-crew"
              type="number"
              value={crewCount}
              onChange={(e) => setCrewCount(e.target.value)}
              placeholder="e.g. 8"
            />
          </div>
          <div>
            <Label htmlFor="dpr-hours">Total man-hours</Label>
            <Input
              id="dpr-hours"
              type="number"
              step="0.25"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder="e.g. 64"
            />
          </div>
          <div className="sm:col-span-3">
            <Label htmlFor="dpr-weather">Weather</Label>
            <Input
              id="dpr-weather"
              value={weather}
              onChange={(e) => setWeather(e.target.value)}
              placeholder="e.g. Sunny 78F, light wind"
            />
          </div>
          <div className="sm:col-span-3">
            <Label htmlFor="dpr-narrative">Work narrative</Label>
            <textarea
              id="dpr-narrative"
              className={cn(
                "h-24 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
              placeholder="Crew installed 320 LF of trench, ran AC wire pulls to inverter pad..."
            />
          </div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">Safety</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={safetyIncident}
              onChange={(e) => setSafetyIncident(e.target.checked)}
            />
            Safety incident
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={nearMiss}
              onChange={(e) => setNearMiss(e.target.checked)}
            />
            Near miss
          </label>
          <div className="sm:col-span-3">
            <Label htmlFor="dpr-safety">Safety narrative</Label>
            <Input
              id="dpr-safety"
              value={safetyNarrative}
              onChange={(e) => setSafetyNarrative(e.target.value)}
              placeholder="Describe any incidents or hazards observed"
            />
          </div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              Schedule task updates ({updates.size} selected)
            </h3>
            <p className="text-xs text-muted-foreground">
              Pick tasks worked on today. Click each to add. On approval the
              schedule reflects these.
            </p>
          </div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search WBS or task name"
            className="max-w-xs"
          />
        </div>

        {updates.size > 0 && (
          <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-3">
            {Array.from(updates.values()).map((u) => {
              const t = tasks.find((x) => x.id === u.taskId);
              if (!t) return null;
              return (
                <div
                  key={u.taskId}
                  className="grid gap-2 rounded-md border bg-background p-2 sm:grid-cols-[1fr_140px_120px_120px_auto]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-mono">{t.wbsCode}</div>
                    <div className="truncate text-sm font-medium">{t.taskName}</div>
                    <div className="text-[10px] text-muted-foreground">
                      Current: {t.currentStatus ?? "-"} ({t.currentPct ?? "?"}%)
                    </div>
                  </div>
                  <div>
                    <Label htmlFor={`status-${t.id}`} className="text-[10px]">
                      New status
                    </Label>
                    <select
                      id={`status-${t.id}`}
                      value={u.newStatus}
                      onChange={(e) =>
                        patchUpdate(u.taskId, { newStatus: e.target.value })
                      }
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor={`pct-${t.id}`} className="text-[10px]">
                      % complete
                    </Label>
                    <Input
                      id={`pct-${t.id}`}
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={u.newPct}
                      onChange={(e) =>
                        patchUpdate(u.taskId, { newPct: e.target.value })
                      }
                      placeholder="0-100"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`qty-${t.id}`} className="text-[10px]">
                      Installed qty
                    </Label>
                    <Input
                      id={`qty-${t.id}`}
                      type="number"
                      step="0.001"
                      value={u.installed}
                      onChange={(e) =>
                        patchUpdate(u.taskId, { installed: e.target.value })
                      }
                      placeholder="(optional)"
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleTask(t)}
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="sm:col-span-5">
                    <Input
                      value={u.notes}
                      onChange={(e) =>
                        patchUpdate(u.taskId, { notes: e.target.value })
                      }
                      placeholder="Notes for this task (optional)"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-3 max-h-96 overflow-y-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr className="border-b">
                <th className="w-10 px-2 py-1.5"></th>
                <th className="px-2 py-1.5 text-left font-medium">WBS</th>
                <th className="px-2 py-1.5 text-left font-medium">Task</th>
                <th className="px-2 py-1.5 text-left font-medium">Phase</th>
                <th className="px-2 py-1.5 text-left font-medium">Status</th>
                <th className="px-2 py-1.5 text-right font-medium">End date</th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.slice(0, 200).map((t) => {
                const selected = updates.has(t.id);
                return (
                  <tr
                    key={t.id}
                    className={cn(
                      "border-b last:border-0 hover:bg-muted/30",
                      selected && "bg-emerald-500/5",
                    )}
                  >
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleTask(t)}
                      />
                    </td>
                    <td className="px-2 py-1.5 font-mono">{t.wbsCode}</td>
                    <td className="px-2 py-1.5">{t.taskName}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {t.phase ?? "-"}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {t.currentStatus ?? "-"}
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">
                      {t.endDate ?? "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredTasks.length > 200 && (
            <div className="border-t bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
              Showing first 200 of {filteredTasks.length} results. Narrow the
              search.
            </div>
          )}
        </div>
      </section>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          onClick={() => router.back()}
        >
          Cancel
        </Button>
        <Button type="button" disabled={submitting} onClick={onSubmit}>
          {submitting ? "Submitting..." : "Submit DPR"}
        </Button>
      </div>
    </div>
  );
}
