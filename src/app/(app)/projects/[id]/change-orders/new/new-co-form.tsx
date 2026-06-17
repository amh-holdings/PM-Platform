"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { createChangeOrder } from "../../change-orders-actions";

type Props = { projectId: string };

const STATUSES = ["draft", "submitted", "approved", "rejected"] as const;

export function NewChangeOrderForm({ projectId }: Props) {
  const router = useRouter();
  const [coNumber, setCoNumber] = useState("");
  const [description, setDescription] = useState("");
  const [coValue, setCoValue] = useState("");
  const [scheduleDays, setScheduleDays] = useState("");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("approved");
  const [submittedAt, setSubmittedAt] = useState("");
  const [approvedAt, setApprovedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  async function onSubmit() {
    setError(null);
    if (!coNumber.trim()) {
      setError("CO number is required");
      return;
    }
    const value = Number(coValue.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(value) || value < 0) {
      setError("CO value must be a positive number");
      return;
    }
    setSubmitting(true);
    const res = await createChangeOrder({
      projectId,
      coNumber: coNumber.trim(),
      description: description.trim() || null,
      coValue: value,
      scheduleImpactDays: scheduleDays ? Number(scheduleDays) : null,
      status,
      submittedAt: submittedAt || null,
      approvedAt: approvedAt || null,
      notes: notes.trim() || null,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => {
      router.push(`/projects/${projectId}/change-orders/${res.coId}`);
    });
  }

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="co-number">CO number</Label>
          <Input
            id="co-number"
            value={coNumber}
            onChange={(e) => setCoNumber(e.target.value)}
            placeholder="CO-04"
          />
        </div>
        <div>
          <Label htmlFor="co-value">Billable value (owner) - includes profit</Label>
          <Input
            id="co-value"
            value={coValue}
            onChange={(e) => setCoValue(e.target.value)}
            placeholder="67458.34"
            inputMode="decimal"
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="co-description">Description</Label>
          <textarea
            id="co-description"
            className={cn(
              "h-20 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Equipment Storage (Racking + Transformer) and Power Factors SCADA cost increase. $61,325.76 cost + 10% profit = $67,458.34 billable."
          />
        </div>
        <div>
          <Label htmlFor="co-status">Status</Label>
          <select
            id="co-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm capitalize"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="schedule-days">Schedule impact (days)</Label>
          <Input
            id="schedule-days"
            type="number"
            value={scheduleDays}
            onChange={(e) => setScheduleDays(e.target.value)}
            placeholder="e.g. 14"
          />
        </div>
        <div>
          <Label htmlFor="submitted-at">Submitted</Label>
          <Input
            id="submitted-at"
            type="date"
            value={submittedAt}
            onChange={(e) => setSubmittedAt(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="approved-at">Approved</Label>
          <Input
            id="approved-at"
            type="date"
            value={approvedAt}
            onChange={(e) => setApprovedAt(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="co-notes">Notes</Label>
          <Input
            id="co-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={submitting} onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="button" disabled={submitting} onClick={onSubmit}>
          {submitting ? "Saving..." : "Save change order"}
        </Button>
      </div>
    </div>
  );
}
