"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { createChangeOrder } from "../../change-orders-actions";

type Props = { projectId: string };

const STATUSES = ["draft", "submitted", "approved", "rejected"] as const;

// Last-edited tracking lets us recompute the third value when two are present.
type LastEdited = "cost" | "profitPct" | "billable" | null;

function toNumber(s: string): number | null {
  const n = Number(s.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function NewChangeOrderForm({ projectId }: Props) {
  const router = useRouter();
  const [coNumber, setCoNumber] = useState("");
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [profitPct, setProfitPct] = useState("10");
  const [billable, setBillable] = useState("");
  const [lastEdited, setLastEdited] = useState<LastEdited>("profitPct");
  const [scheduleDays, setScheduleDays] = useState("");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("approved");
  const [submittedAt, setSubmittedAt] = useState("");
  const [approvedAt, setApprovedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  // Auto-compute: whichever field wasn't last edited gets recomputed when
  // any of the three pricing fields changes. Cost + profit% -> billable
  // is the most common entry pattern (default).
  useEffect(() => {
    const c = toNumber(cost);
    const p = toNumber(profitPct);
    const b = toNumber(billable);

    if (lastEdited !== "billable" && c != null && p != null) {
      const computed = c * (1 + p / 100);
      const rounded = Math.round(computed * 100) / 100;
      if (Math.abs(rounded - (b ?? 0)) > 0.01) setBillable(String(rounded));
    } else if (lastEdited !== "cost" && b != null && p != null && p > -100) {
      const computed = b / (1 + p / 100);
      const rounded = Math.round(computed * 100) / 100;
      if (Math.abs(rounded - (c ?? 0)) > 0.01) setCost(String(rounded));
    } else if (lastEdited !== "profitPct" && c != null && c !== 0 && b != null) {
      const computed = ((b - c) / c) * 100;
      const rounded = Math.round(computed * 100) / 100;
      if (Math.abs(rounded - (p ?? 0)) > 0.01) setProfitPct(String(rounded));
    }
  }, [cost, profitPct, billable, lastEdited]);

  async function onSubmit() {
    setError(null);
    if (!coNumber.trim()) {
      setError("CO number is required");
      return;
    }
    const billableNum = toNumber(billable);
    if (billableNum == null || billableNum < 0) {
      setError("Billable value is required and must be >= 0");
      return;
    }
    const costNum = toNumber(cost);
    const profitPctNum = toNumber(profitPct);

    setSubmitting(true);
    const res = await createChangeOrder({
      projectId,
      coNumber: coNumber.trim(),
      description: description.trim() || null,
      coValue: billableNum,
      costAmount: costNum,
      profitPct: profitPctNum,
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
            placeholder="Equipment Storage (Racking + Transformer) and Power Factors SCADA cost increase."
          />
        </div>

        <div className="sm:col-span-2 rounded-md border bg-muted/30 p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">Pricing</h3>
            <p className="text-[10px] text-muted-foreground">
              Enter any two - the third auto-computes
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="co-cost">Cost (AHC)</Label>
              <Input
                id="co-cost"
                value={cost}
                onChange={(e) => {
                  setCost(e.target.value);
                  setLastEdited("cost");
                }}
                placeholder="e.g. 61325.76"
                inputMode="decimal"
                className="text-right"
              />
            </div>
            <div>
              <Label htmlFor="co-profit">Profit %</Label>
              <Input
                id="co-profit"
                value={profitPct}
                onChange={(e) => {
                  setProfitPct(e.target.value);
                  setLastEdited("profitPct");
                }}
                placeholder="e.g. 10"
                inputMode="decimal"
                className="text-right"
              />
            </div>
            <div>
              <Label htmlFor="co-billable">Billable (owner)</Label>
              <Input
                id="co-billable"
                value={billable}
                onChange={(e) => {
                  setBillable(e.target.value);
                  setLastEdited("billable");
                }}
                placeholder="auto"
                inputMode="decimal"
                className="text-right"
              />
            </div>
          </div>
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

      <div className="mt-4 rounded-md border border-dashed bg-background/40 p-3 text-xs text-muted-foreground">
        Tip: after saving, the detail page lets you add multiple SOV
        sub-lines (e.g. one line for storage, one for equipment cost
        increase). Each appears separately on the AFP G703.
      </div>
    </div>
  );
}
