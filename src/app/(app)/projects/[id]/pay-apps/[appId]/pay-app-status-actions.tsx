"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  deletePayApplication,
  setPayApplicationStatus,
} from "../../pay-app-actions";

type Props = {
  payAppId: string;
  projectId: string;
  status: string;
};

export function PayAppStatusActions({ payAppId, projectId, status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function transition(next: "submitted" | "approved" | "paid") {
    setBusy(true);
    setError(null);
    const res = await setPayApplicationStatus(payAppId, projectId, next);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  async function onDelete() {
    if (!confirm("Delete this pay application? Billing entries will be unstamped.")) {
      return;
    }
    setBusy(true);
    setError(null);
    const res = await deletePayApplication(payAppId, projectId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => router.push(`/projects/${projectId}/pay-apps`));
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => window.print()}
        >
          Print / PDF
        </Button>
        {status === "draft" && (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => transition("submitted")}
          >
            Mark submitted
          </Button>
        )}
        {status === "submitted" && (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => transition("approved")}
          >
            Mark approved
          </Button>
        )}
        {status === "approved" && (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => transition("paid")}
          >
            Mark paid
          </Button>
        )}
        {status === "draft" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onDelete}
          >
            Delete
          </Button>
        )}
      </div>
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}
