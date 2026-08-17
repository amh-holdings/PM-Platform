"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  DATE_CONSTRAINT_LABELS,
  DATE_CONSTRAINT_TYPES,
  HARD_CONSTRAINTS,
  type DateConstraintType,
} from "@/lib/schedule-cpm";
import { updateScheduleTask } from "../schedule-actions";
import {
  PredecessorEditor,
  hasLinkErrors,
  type LinkTask,
} from "./predecessor-editor";

export type TaskFormValues = {
  id: string;
  wbs_code: string;
  task_name: string;
  description: string | null;
  phase: string | null;
  assigned_to: string | null;
  status: string | null;
  duration_days: number | null;
  start_date: string | null;
  end_date: string | null;
  predecessors: string | null;
  is_at_risk: boolean | null;
  is_internal: boolean | null;
  non_ahc_delay: boolean | null;
  is_milestone?: boolean | null;
  date_constraint_type?: string | null;
  date_constraint_date?: string | null;
};

type Props = {
  projectId: string;
  task: TaskFormValues;
  phaseOptions: string[];
  statusOptions: string[];
  trigger: React.ReactNode;
  // Every task on the project, so predecessors are chosen from a list rather
  // than typed, and so cycles can be caught before the form is submitted.
  allTasks: LinkTask[];
  phase1Available: boolean;
};

export function TaskEditDialog({
  projectId,
  task,
  phaseOptions,
  statusOptions,
  trigger,
  allTasks,
  phase1Available,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();
  const [isMilestone, setIsMilestone] = useState(!!task.is_milestone);
  const [constraintType, setConstraintType] = useState(
    task.date_constraint_type ?? "",
  );

  const handleSubmit = async (formData: FormData) => {
    // Re-check the network here as well as in the editor. The editor shows the
    // problem; this is what stops a broken graph reaching the database.
    const linkError = hasLinkErrors(
      allTasks,
      task.wbs_code,
      formData.get("predecessors") as string | null,
    );
    if (linkError) {
      setError(linkError);
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await updateScheduleTask(task.id, projectId, formData);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  };

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-block">{trigger}</span>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Edit task</h3>
                <p className="text-xs text-muted-foreground font-mono">{task.wbs_code}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>

            <form action={handleSubmit} className="mt-4 space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="task_name">Task</Label>
                  <Input id="task_name" name="task_name" defaultValue={task.task_name} required />
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="description">Description</Label>
                  <Input id="description" name="description" defaultValue={task.description ?? ""} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="phase">Phase</Label>
                  <select
                    id="phase"
                    name="phase"
                    defaultValue={task.phase ?? ""}
                    className={cn(
                      "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                      "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    )}
                  >
                    <option value="">-</option>
                    {phaseOptions.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="status">Status</Label>
                  <select
                    id="status"
                    name="status"
                    defaultValue={task.status ?? ""}
                    className={cn(
                      "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                      "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    )}
                  >
                    <option value="">-</option>
                    {statusOptions.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="assigned_to">Assigned to</Label>
                  <Input id="assigned_to" name="assigned_to" defaultValue={task.assigned_to ?? ""} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="duration_days">Duration (days)</Label>
                  <Input
                    id="duration_days"
                    name="duration_days"
                    type="number"
                    min={0}
                    defaultValue={task.duration_days ?? ""}
                    disabled={isMilestone}
                  />
                  {isMilestone && (
                    <p className="text-[11px] text-muted-foreground">
                      A milestone has no duration.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="start_date">Start date</Label>
                  <Input id="start_date" name="start_date" type="date" defaultValue={task.start_date ?? ""} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="end_date">End date</Label>
                  <Input id="end_date" name="end_date" type="date" defaultValue={task.end_date ?? ""} />
                </div>

                <PredecessorEditor
                  name="predecessors"
                  currentWbs={task.wbs_code}
                  allTasks={allTasks}
                  defaultValue={task.predecessors}
                />

                {phase1Available && (
                  <div className="space-y-3 rounded-md border bg-muted/20 p-3 sm:col-span-2">
                    <div>
                      <Label htmlFor="date_constraint_type">Date constraint</Label>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        A start date is a plan and logic can push it. A constraint
                        cannot be pushed - it is the interconnection window, the
                        permit expiry, the date in the contract. Use it sparingly:
                        every one of these is a date the network stops calculating.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <select
                        id="date_constraint_type"
                        name="date_constraint_type"
                        value={constraintType}
                        onChange={(e) => setConstraintType(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="">None - driven by logic</option>
                        {DATE_CONSTRAINT_TYPES.map((c) => (
                          <option key={c} value={c}>
                            {DATE_CONSTRAINT_LABELS[c]}
                            {HARD_CONSTRAINTS.has(c) ? " (hard)" : ""}
                          </option>
                        ))}
                      </select>
                      <Input
                        name="date_constraint_date"
                        type="date"
                        defaultValue={task.date_constraint_date ?? ""}
                        disabled={!constraintType}
                        required={!!constraintType}
                      />
                    </div>
                    {constraintType &&
                      HARD_CONSTRAINTS.has(constraintType as DateConstraintType) && (
                        <p className="text-[11px] text-amber-700">
                          A hard constraint caps the late dates, so work that
                          cannot meet it shows negative float rather than
                          absorbing the problem quietly. That is the point, and
                          it is also why too many of them make the schedule stop
                          forecasting and start merely recording.
                        </p>
                      )}
                  </div>
                )}

                <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:gap-6">
                  {phase1Available && (
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="is_milestone"
                        checked={isMilestone}
                        onChange={(e) => setIsMilestone(e.target.checked)}
                      />
                      <span title="Marks an instant. Consumes no working days, so its start and finish are the same.">
                        Milestone
                      </span>
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="is_at_risk" defaultChecked={!!task.is_at_risk} />
                    <span>At risk</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="is_internal" defaultChecked={!!task.is_internal} />
                    <span>Internal</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="non_ahc_delay" defaultChecked={!!task.non_ahc_delay} />
                    <span>Non-AHC delay</span>
                  </label>
                </div>
              </div>

              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2 border-t pt-4">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Saving..." : "Save changes"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
