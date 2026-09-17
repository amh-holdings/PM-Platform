"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

import { undoPayApplication } from "../pay-app-actions";

type Props = {
  projectId: string;
  payAppId: string;
  appNumber: string | null;
  entryCount: number;
};

// Two clicks, not one. Undoing deletes the pay application, and a button that
// does that on a single misclick is the same class of mistake it exists to fix.
// The confirm names the AFP and the count so the reader can check it is the one
// they meant before the second click.
export function UndoAfpButton({
  projectId,
  payAppId,
  appNumber,
  entryCount,
}: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function run() {
    setError(null);
    setBusy(true);
    const result = await undoPayApplication(payAppId, projectId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      setConfirming(false);
      return;
    }
    setConfirming(false);
    startTransition(() => router.refresh());
  }

  if (!confirming) {
    return (
      <div className="text-right">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setConfirming(true)}
        >
          Undo this AFP
        </Button>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="text-right">
      <p className="text-xs">
        Delete {appNumber ? `AFP ${appNumber}` : "this AFP"} and put its{" "}
        {entryCount} line{entryCount === 1 ? "" : "s"} back on this panel?
      </p>
      <div className="mt-1 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Keep it
        </Button>
        <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={run}>
          {busy ? "Undoing..." : "Yes, undo"}
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
