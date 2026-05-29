"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { createPayApplication } from "../../pay-app-actions";

type Props = {
  projectId: string;
  defaultAppNumber: string;
  defaultStart: string;
  defaultEnd: string;
  defaultRetainagePct: number;
};

export function NewPayAppForm({
  projectId,
  defaultAppNumber,
  defaultStart,
  defaultEnd,
  defaultRetainagePct,
}: Props) {
  const router = useRouter();
  const [appNumber, setAppNumber] = useState(defaultAppNumber);
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [retainagePct, setRetainagePct] = useState(String(defaultRetainagePct));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  async function onSubmit() {
    setError(null);
    if (!appNumber.trim()) {
      setError("App number is required");
      return;
    }
    setSubmitting(true);
    const res = await createPayApplication({
      projectId,
      appNumber,
      periodStart: start,
      periodEnd: end,
      retainagePct: Number(retainagePct) || 10,
      notes: notes || null,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => {
      router.push(`/projects/${projectId}/pay-apps/${res.payAppId}`);
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="app-number">Pay application number</Label>
            <Input
              id="app-number"
              value={appNumber}
              onChange={(e) => setAppNumber(e.target.value)}
              placeholder="AFP 10"
            />
          </div>
          <div>
            <Label htmlFor="retainage">Retainage %</Label>
            <Input
              id="retainage"
              type="number"
              step="0.01"
              value={retainagePct}
              onChange={(e) => setRetainagePct(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="period-start">Period start</Label>
            <Input
              id="period-start"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="period-end">Period end</Label>
            <Input
              id="period-end"
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <textarea
              id="notes"
              className={cn(
                "h-16 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        {error && (
          <p className="mt-2 text-xs text-destructive">{error}</p>
        )}
      </div>

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
          {submitting ? "Creating..." : "Create draft pay app"}
        </Button>
      </div>
    </div>
  );
}
