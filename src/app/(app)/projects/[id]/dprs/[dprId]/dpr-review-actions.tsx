"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { approveDpr, returnDpr } from "../../dpr-actions";

type Props = {
  dprId: string;
  projectId: string;
};

export function DprReviewActions({ dprId, projectId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "return" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [, startTransition] = useTransition();

  const onApprove = async () => {
    setBusy("approve");
    setError(null);
    setMsg(null);
    const res = await approveDpr(dprId, projectId, reviewNotes || undefined);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMsg(
      `Approved. Applied ${res.appliedTaskCount} task ${res.appliedTaskCount === 1 ? "update" : "updates"} to the schedule.`,
    );
    startTransition(() => router.refresh());
  };

  const onReturn = async () => {
    if (!reviewNotes.trim()) {
      setError("Add review notes explaining why the DPR is being returned.");
      return;
    }
    setBusy("return");
    setError(null);
    setMsg(null);
    const res = await returnDpr(dprId, projectId, reviewNotes);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMsg("DPR returned to the submitter.");
    startTransition(() => router.refresh());
  };

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <h3 className="text-sm font-semibold">Review</h3>
      <p className="text-xs text-muted-foreground">
        Approving applies the proposed task updates to the schedule. Returning
        sends the DPR back to the submitter with notes.
      </p>

      <div className="mt-3 space-y-2">
        <textarea
          className={cn(
            "h-16 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          value={reviewNotes}
          onChange={(e) => setReviewNotes(e.target.value)}
          placeholder="Optional notes (required for Return)"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        {msg && <p className="text-xs text-emerald-700">{msg}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={onReturn}
          >
            {busy === "return" ? "Returning..." : "Return for changes"}
          </Button>
          <Button type="button" size="sm" disabled={busy !== null} onClick={onApprove}>
            {busy === "approve" ? "Approving..." : "Approve and apply"}
          </Button>
        </div>
      </div>
    </section>
  );
}
