"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FinalizeGate } from "@/lib/field-report-status";
import { finalizeFieldReport, returnFieldReport } from "../../field-report-actions";

type Props = {
  projectId: string;
  dprId: string;
  gate: FinalizeGate;
};

// Report-level finalize, shown to the QA/QC approver once they have worked
// through the sub's pins. Approve requires every pin approved; Return requires
// every pin decided with at least one rejected (routes the report back to the
// sub to fix).
export function FinalizeReport({ projectId, dprId, gate }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "return" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [, startTransition] = useTransition();

  const onApprove = async () => {
    setBusy("approve");
    setError(null);
    setMsg(null);
    const res = await finalizeFieldReport(dprId, projectId, notes || undefined);
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setMsg("Report approved. It is now locked and marked complete.");
    startTransition(() => router.refresh());
  };

  const onReturn = async () => {
    if (!notes.trim())
      return setError("Add a note explaining what the sub needs to fix.");
    setBusy("return");
    setError(null);
    setMsg(null);
    const res = await returnFieldReport(dprId, projectId, notes);
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setMsg("Report returned to the subcontractor to fix.");
    startTransition(() => router.refresh());
  };

  const remaining = gate.totalSubPins - gate.decidedSubPins;

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Finalize report</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {gate.decidedSubPins} / {gate.totalSubPins} pins decided
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {gate.canApprove
          ? "Every work pin is approved - approve the report to complete it."
          : gate.canReturn
            ? "One or more pins are rejected - return the report so the sub can fix them."
            : `Review each work pin first. ${remaining} still need${remaining === 1 ? "s" : ""} a decision.`}
      </p>

      <div className="mt-3 space-y-2">
        <textarea
          className={cn(
            "h-16 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (required to Return, optional to Approve)"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        {msg && <p className="text-xs text-emerald-700">{msg}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null || !gate.canReturn}
            onClick={onReturn}
          >
            {busy === "return" ? "Returning..." : "Return to sub"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy !== null || !gate.canApprove}
            onClick={onApprove}
          >
            {busy === "approve" ? "Approving..." : "Approve report"}
          </Button>
        </div>
      </div>
    </section>
  );
}
