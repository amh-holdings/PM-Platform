"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { CalendarLike } from "@/lib/schedule-calendar";
import {
  CONSTRAINT_CATEGORIES,
  CONSTRAINT_CATEGORY_HINTS,
  CONSTRAINT_STATUS_LABELS,
  constraintsToText,
  isOpen,
  urgencyOf,
  type ConstraintSummary,
  type ScheduleConstraint,
} from "@/lib/schedule-constraints";
import {
  createConstraint,
  deleteConstraint,
  setConstraintStatus,
} from "../constraint-actions";

type TaskLite = { wbs_code: string; task_name: string };

type Props = {
  projectId: string;
  projectName: string;
  constraints: ScheduleConstraint[];
  available: boolean;
  dataDate: string;
  calendar: CalendarLike;
  tasks: TaskLite[];
  summary: ConstraintSummary;
};

function fmt(iso: string | null): string {
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

export function ScheduleConstraintsView({
  projectId,
  projectName,
  constraints,
  available,
  dataDate,
  calendar,
  tasks,
  summary,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showCleared, setShowCleared] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<ScheduleConstraint | null>(null);
  const [copied, setCopied] = useState(false);

  const taskNames = useMemo(
    () => new Map(tasks.map((t) => [t.wbs_code, t.task_name])),
    [tasks],
  );

  const visible = useMemo(() => {
    const rows = constraints.filter((c) => {
      if (!showCleared && !isOpen(c)) return false;
      if (categoryFilter && c.category !== categoryFilter) return false;
      return true;
    });
    // Open ones first, then by need-by. A constraint with no date sorts last -
    // it is the one nobody has committed to a date for, which is its own
    // problem but not this week's.
    return rows.sort((a, b) => {
      if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
      return (a.need_by ?? "9999-99-99").localeCompare(b.need_by ?? "9999-99-99");
    });
  }, [constraints, showCleared, categoryFilter]);

  async function copyList() {
    await navigator.clipboard.writeText(
      constraintsToText(constraints, projectName, dataDate, taskNames),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!available) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">Constraint log not enabled</p>
        <p className="mt-1 text-xs">
          Apply migration 0034 in the Supabase SQL editor. The log is where
          &ldquo;what is stopping this task&rdquo; gets an owner and a date
          instead of being remembered - the one piece the look-ahead has been
          missing to become a commitment rather than a broadcast.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Open" value={summary.open} />
        <Stat label="Past need-by" value={summary.overdue} tone="destructive" />
        <Stat label="Due within a week" value={summary.dueSoon} tone="amber" />
        <Stat label="Tasks blocked" value={summary.blockedTasks} tone="amber" />
        <Stat label="Cleared" value={summary.cleared} tone="emerald" />
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">
            Category
          </label>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">All</option>
            {summary.byCategory.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category} ({c.open} open)
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showCleared}
            onChange={(e) => setShowCleared(e.target.checked)}
          />
          Show cleared
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={copyList}>
            {copied ? "Copied" : "Copy open list"}
          </Button>
          <Button size="sm" onClick={() => { setAdding(true); setError(null); }}>
            Raise a constraint
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          {constraints.length === 0
            ? "Nothing logged yet. A constraint is anything that has to be true before a task can start - material on site, access granted, a permit in hand."
            : "Nothing matches the current filters."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-3 font-medium">Category</th>
                <th className="px-3 py-3 font-medium">Constraint</th>
                <th className="px-3 py-3 font-medium">Blocks</th>
                <th className="px-3 py-3 font-medium">Owner</th>
                <th className="px-3 py-3 font-medium">Need by</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((c) => {
                const { urgency, days } = urgencyOf(c, dataDate, calendar);
                return (
                  <tr
                    key={c.id}
                    className={cn(
                      "hover:bg-muted/30",
                      urgency === "overdue" && "bg-destructive/5",
                    )}
                  >
                    <td className="px-3 py-2.5">
                      <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                        {c.category}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{c.title}</div>
                      {c.description && (
                        <div className="text-xs text-muted-foreground">{c.description}</div>
                      )}
                      {c.resolution && (
                        <div className="text-xs text-emerald-700">
                          Resolved: {c.resolution}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {c.wbs_code ? (
                        <div className="text-xs">
                          <span className="font-mono text-muted-foreground">{c.wbs_code}</span>
                          {taskNames.get(c.wbs_code) && (
                            <div className="text-muted-foreground">
                              {taskNames.get(c.wbs_code)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">project-wide</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {c.owner ?? <span className="text-amber-700">unassigned</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {c.need_by ? (
                        <div>
                          <span
                            className={cn(
                              urgency === "overdue" && "font-medium text-destructive",
                              urgency === "due" && "font-medium text-amber-700",
                            )}
                          >
                            {fmt(c.need_by)}
                          </span>
                          {days != null && isOpen(c) && (
                            <div className="text-[11px] text-muted-foreground">
                              {urgency === "overdue"
                                ? `${Math.abs(days)}d past`
                                : `${days}d left`}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-amber-700">no date</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                          c.status === "cleared" && "bg-emerald-100 text-emerald-900",
                          c.status === "wont_clear" && "bg-destructive/10 text-destructive",
                          c.status === "in_progress" && "bg-blue-100 text-blue-900",
                          c.status === "open" && "bg-amber-100 text-amber-900",
                        )}
                      >
                        {CONSTRAINT_STATUS_LABELS[c.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        {c.status === "open" && (
                          <button
                            className="text-xs text-muted-foreground hover:text-foreground"
                            disabled={pending}
                            onClick={() =>
                              startTransition(async () => {
                                const r = await setConstraintStatus(
                                  projectId, c.id, "in_progress", null,
                                );
                                if (!r.ok) setError(r.error);
                                router.refresh();
                              })
                            }
                          >
                            Working
                          </button>
                        )}
                        {isOpen(c) && (
                          <button
                            className="text-xs font-medium text-emerald-700 hover:text-emerald-900"
                            onClick={() => { setClosing(c); setError(null); }}
                          >
                            Clear
                          </button>
                        )}
                        <button
                          className="text-xs text-muted-foreground hover:text-destructive"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              const r = await deleteConstraint(projectId, c.id);
                              if (!r.ok) setError(r.error);
                              router.refresh();
                            })
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Need-by is the date the constraint has to be <em>cleared</em>, which is
        upstream of the task start by whatever lead time the answer needs. A
        submittal approved the morning work is due to start is a submittal that
        was late.
      </p>

      {adding && (
        <AddDialog
          projectId={projectId}
          tasks={tasks}
          onClose={() => setAdding(false)}
          onError={setError}
        />
      )}

      {closing && (
        <CloseDialog
          projectId={projectId}
          constraint={closing}
          onClose={() => setClosing(null)}
          onError={setError}
        />
      )}
    </div>
  );
}

function AddDialog({
  projectId,
  tasks,
  onClose,
  onError,
}: {
  projectId: string;
  tasks: TaskLite[];
  onClose: () => void;
  onError: (m: string | null) => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [category, setCategory] = useState<string>("Material");

  return (
    <Modal title="Raise a constraint" onClose={onClose}>
      <form
        action={async (formData: FormData) => {
          setSubmitting(true);
          onError(null);
          const res = await createConstraint(projectId, formData);
          setSubmitting(false);
          if (!res.ok) { onError(res.error); return; }
          onClose();
          router.refresh();
        }}
        className="space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <select
              id="category"
              name="category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {CONSTRAINT_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              {CONSTRAINT_CATEGORY_HINTS[category as keyof typeof CONSTRAINT_CATEGORY_HINTS]}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="wbs_code">Blocks which task</Label>
            <select
              id="wbs_code"
              name="wbs_code"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Project-wide</option>
              {tasks.map((t) => (
                <option key={t.wbs_code} value={t.wbs_code}>
                  {t.wbs_code} {t.task_name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="title">What is in the way</Label>
            <Input
              id="title"
              name="title"
              required
              placeholder="RCP culvert pipe not delivered"
            />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="description">Detail</Label>
            <Input
              id="description"
              name="description"
              placeholder="Vendor confirmed 3-week lead, PO issued 12 Aug"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="owner">Owner</Label>
            <Input id="owner" name="owner" placeholder="Mark Wooley" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="need_by">Clear by</Label>
            <Input id="need_by" name="need_by" type="date" />
            <p className="text-[11px] text-muted-foreground">
              When it has to be resolved, not when the work starts.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving..." : "Raise it"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CloseDialog({
  projectId,
  constraint,
  onClose,
  onError,
}: {
  projectId: string;
  constraint: ScheduleConstraint;
  onClose: () => void;
  onError: (m: string | null) => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [resolution, setResolution] = useState("");
  const [status, setStatus] = useState<"cleared" | "wont_clear">("cleared");

  async function submit() {
    setSubmitting(true);
    onError(null);
    const res = await setConstraintStatus(projectId, constraint.id, status, resolution);
    setSubmitting(false);
    if (!res.ok) { onError(res.error); return; }
    onClose();
    router.refresh();
  }

  return (
    <Modal title="Close this constraint" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <div className="font-medium">{constraint.title}</div>
          <div className="text-xs text-muted-foreground">
            {constraint.category}
            {constraint.wbs_code ? ` - blocks ${constraint.wbs_code}` : ""}
          </div>
        </div>

        <div className="flex gap-2">
          {(
            [
              ["cleared", "Cleared"],
              ["wont_clear", "Will not clear"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setStatus(v)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm",
                status === v ? "border-foreground bg-muted font-medium" : "text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {status === "wont_clear" && (
          <p className="text-xs text-amber-700">
            This constraint is permanent, so the plan has to change instead.
            Re-sequence the work it blocks.
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor="resolution">How was it resolved</Label>
          <Input
            id="resolution"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder="Pipe delivered and accepted 22 Aug"
          />
          <p className="text-[11px] text-muted-foreground">
            Required. A constraint closed with no note is not a record of
            anything, and six weeks of these is what tells you what actually
            delays your jobs.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !resolution.trim()}>
            {submitting ? "Saving..." : "Close it"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber" | "destructive";
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3 shadow-sm">
      <div
        className={cn(
          "text-2xl font-semibold tabular-nums",
          tone === "emerald" && "text-emerald-700",
          tone === "amber" && value > 0 && "text-amber-700",
          tone === "destructive" && value > 0 && "text-destructive",
        )}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
