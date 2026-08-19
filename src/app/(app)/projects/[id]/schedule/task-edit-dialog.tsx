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
import {
  createScheduleTask,
  deleteScheduleTasks,
  describeTaskDeletion,
  updateScheduleTask,
} from "../schedule-actions";
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

const BLANK: TaskFormValues = {
  id: "",
  wbs_code: "",
  task_name: "",
  description: null,
  phase: null,
  assigned_to: null,
  status: "Not Started",
  duration_days: null,
  start_date: null,
  end_date: null,
  predecessors: null,
  is_at_risk: false,
  is_internal: false,
  non_ahc_delay: false,
  is_milestone: false,
  date_constraint_type: null,
  date_constraint_date: null,
};

type DeleteImpact = Awaited<ReturnType<typeof describeTaskDeletion>>;

type Props = {
  projectId: string;
  // Omitted when adding. The form is the same either way - a new task needs
  // every field an existing one has, and having two of these drift apart is
  // how a field ends up settable in one place and not the other.
  task?: TaskFormValues;
  mode?: "edit" | "create";
  suggestedWbs?: string;
  phaseOptions: string[];
  statusOptions: string[];
  trigger: React.ReactNode;
  // Every task on the project, so predecessors are chosen from a list rather
  // than typed, and so cycles can be caught before the form is submitted.
  allTasks: LinkTask[];
  phase1Available: boolean;
  onDone?: () => void;
};

export function TaskEditDialog({
  projectId,
  task,
  mode = "edit",
  suggestedWbs,
  phaseOptions,
  statusOptions,
  trigger,
  allTasks,
  phase1Available,
  onDone,
}: Props) {
  const creating = mode === "create";
  const values = task ?? { ...BLANK, wbs_code: suggestedWbs ?? "" };

  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();
  const [isMilestone, setIsMilestone] = useState(!!values.is_milestone);
  const [constraintType, setConstraintType] = useState(
    values.date_constraint_type ?? "",
  );
  // The predecessor editor needs to know which task it is editing so it can
  // exclude it from its own options and check for cycles. When creating, that
  // identity is whatever is currently typed in the WBS box.
  const [wbs, setWbs] = useState(values.wbs_code);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [impact, setImpact] = useState<DeleteImpact | null>(null);

  const handleSubmit = async (formData: FormData) => {
    // Re-check the network here as well as in the editor. The editor shows the
    // problem; this is what stops a broken graph reaching the database.
    const linkError = hasLinkErrors(
      allTasks,
      creating ? wbs : values.wbs_code,
      formData.get("predecessors") as string | null,
    );
    if (linkError) {
      setError(linkError);
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = creating
      ? await createScheduleTask(projectId, formData)
      : await updateScheduleTask(values.id, projectId, formData);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    onDone?.();
    startTransition(() => router.refresh());
  };

  async function openDeleteConfirm() {
    setConfirmingDelete(true);
    setImpact(null);
    const res = await describeTaskDeletion(projectId, [values.wbs_code]);
    setImpact(res);
  }

  async function doDelete() {
    setSubmitting(true);
    setError(null);
    const res = await deleteScheduleTasks(projectId, [values.id]);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpen(false);
    setConfirmingDelete(false);
    onDone?.();
    startTransition(() => router.refresh());
  }

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
                <h3 className="text-lg font-semibold">
                  {creating ? "Add task" : "Edit task"}
                </h3>
                <p className="text-xs text-muted-foreground font-mono">
                  {creating ? "New row" : values.wbs_code}
                </p>
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
                {creating && (
                  <div className="space-y-2">
                    <Label htmlFor="wbs_code">WBS code</Label>
                    <Input
                      id="wbs_code"
                      name="wbs_code"
                      value={wbs}
                      onChange={(e) => setWbs(e.target.value)}
                      placeholder="5.1.2.7"
                      required
                      className="font-mono"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      The hierarchy is read from this code - 5.1.2.7 sits under
                      5.1.2. Dotted numbers only.
                    </p>
                  </div>
                )}

                <div className={cn("space-y-2", creating ? "" : "sm:col-span-2")}>
                  <Label htmlFor="task_name">Task</Label>
                  <Input id="task_name" name="task_name" defaultValue={values.task_name} required />
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="description">Description</Label>
                  <Input id="description" name="description" defaultValue={values.description ?? ""} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="phase">Phase</Label>
                  <select
                    id="phase"
                    name="phase"
                    defaultValue={values.phase ?? ""}
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
                    defaultValue={values.status ?? ""}
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
                  <Input id="assigned_to" name="assigned_to" defaultValue={values.assigned_to ?? ""} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="duration_days">Duration (days)</Label>
                  <Input
                    id="duration_days"
                    name="duration_days"
                    type="number"
                    min={0}
                    defaultValue={values.duration_days ?? ""}
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
                  <Input id="start_date" name="start_date" type="date" defaultValue={values.start_date ?? ""} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="end_date">End date</Label>
                  <Input id="end_date" name="end_date" type="date" defaultValue={values.end_date ?? ""} />
                </div>

                <PredecessorEditor
                  name="predecessors"
                  currentWbs={creating ? wbs : values.wbs_code}
                  allTasks={allTasks}
                  defaultValue={values.predecessors}
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
                        defaultValue={values.date_constraint_date ?? ""}
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
                    <input type="checkbox" name="is_at_risk" defaultChecked={!!values.is_at_risk} />
                    <span>At risk</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="is_internal" defaultChecked={!!values.is_internal} />
                    <span>Internal</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="non_ahc_delay" defaultChecked={!!values.non_ahc_delay} />
                    <span>Non-AHC delay</span>
                  </label>
                </div>
              </div>

              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              {confirmingDelete && (
                <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                  <p className="font-medium text-destructive">
                    Delete {values.wbs_code} {values.task_name}?
                  </p>
                  {impact === null ? (
                    <p className="text-xs text-muted-foreground">
                      Checking what depends on it...
                    </p>
                  ) : impact.ok ? (
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {impact.children > 0 && (
                        <li className="text-destructive">
                          {impact.children} subtask
                          {impact.children === 1 ? "" : "s"} sit under this code and
                          are NOT deleted with it. They will be orphaned - delete or
                          outdent them first.
                        </li>
                      )}
                      <li>
                        {impact.dprUpdates} field-report task update
                        {impact.dprUpdates === 1 ? "" : "s"} will be destroyed.
                      </li>
                      <li>
                        {impact.inspections} inspection
                        {impact.inspections === 1 ? "" : "s"} will keep their record
                        but lose the WBS link, so they stop feeding progress.
                      </li>
                      <li>
                        {impact.successors.length
                          ? `${impact.successors.length} successor${impact.successors.length === 1 ? "" : "s"} (${impact.successors.map((s) => s.wbs_code).join(", ")}) will have this predecessor removed.`
                          : "Nothing depends on this task."}
                      </li>
                      <li>
                        Billing lines and cost codes hold WBS codes as plain text
                        and will not be updated. Check any that reference{" "}
                        {values.wbs_code}.
                      </li>
                    </ul>
                  ) : (
                    <p className="text-xs text-destructive">{impact.error}</p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={submitting || impact === null}
                      onClick={doDelete}
                    >
                      {submitting ? "Deleting..." : "Delete task"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingDelete(false)}
                    >
                      Keep it
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 border-t pt-4">
                {!creating && !confirmingDelete && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="mr-auto text-destructive hover:text-destructive"
                    onClick={openDeleteConfirm}
                    disabled={submitting}
                  >
                    Delete
                  </Button>
                )}
                <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting
                    ? creating ? "Adding..." : "Saving..."
                    : creating ? "Add task" : "Save changes"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
