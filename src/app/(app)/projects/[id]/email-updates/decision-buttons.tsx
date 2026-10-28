"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

import { approveEmailUpdate, rejectEmailUpdate, undoEmailUpdate } from "./actions";

/**
 * Approve, reject or undo one email update. The server re-checks who may
 * decide and re-reads the record, so these buttons are a convenience, not the
 * gate.
 */
export function DecisionButtons({
  projectId,
  updateId,
  status,
  canApprove,
  blockedReason,
}: {
  projectId: string;
  updateId: string;
  status: string;
  /** False for a row that can only be dismissed, like an unmatched email. */
  canApprove: boolean;
  /** Set when this person cannot decide the row at all. */
  blockedReason: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(fn: () => Promise<{ ok: true; note?: string } | { ok: false; error: string }>) {
    setBusy(true);
    setMessage(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setMessage({ ok: false, text: res.error });
      return;
    }
    setRejecting(false);
    if (res.note) setMessage({ ok: true, text: res.note });
    startTransition(() => router.refresh());
  }

  if (blockedReason) {
    return <p className="text-xs text-muted-foreground">{blockedReason}</p>;
  }

  return (
    <div className="space-y-2">
      {status === "proposed" && !rejecting && (
        <div className="flex flex-wrap gap-2">
          {canApprove && (
            <Button size="sm" disabled={busy} onClick={() => run(() => approveEmailUpdate(projectId, updateId))}>
              Approve
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
            {canApprove ? "Reject" : "Dismiss"}
          </Button>
        </div>
      )}
      {status === "proposed" && rejecting && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="h-8 min-w-[12rem] flex-1 rounded-md border bg-background px-2 text-sm"
            placeholder="Why (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(() => rejectEmailUpdate(projectId, updateId, note))}
          >
            {canApprove ? "Reject" : "Dismiss"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </div>
      )}
      {status === "applied" && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => undoEmailUpdate(projectId, updateId))}>
          Undo
        </Button>
      )}
      {message && (
        <p className={message.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
