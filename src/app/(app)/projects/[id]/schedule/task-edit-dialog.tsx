"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { updateScheduleTask } from "../schedule-actions";

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
};

type Props = {
  projectId: string;
  task: TaskFormValues;
  phaseOptions: string[];
  statusOptions: string[];
  trigger: React.ReactNode;
};

export function TaskEditDialog({
  projectId,
  task,
  phaseOptions,
  statusOptions,
  trigger,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const handleSubmit = async (formData: FormData) => {
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
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="start_date">Start date</Label>
                  <Input id="start_date" name="start_date" type="date" defaultValue={task.start_date ?? ""} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="end_date">End date</Label>
                  <Input id="end_date" name="end_date" type="date" defaultValue={task.end_date ?? ""} />
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="predecessors">Predecessors</Label>
                  <Input id="predecessors" name="predecessors" defaultValue={task.predecessors ?? ""} placeholder="e.g. 1.1.2, 2.3.1" />
                </div>

                <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:gap-6">
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
