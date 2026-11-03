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

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const NEXT: Record<string, { status: "submitted" | "approved" | "paid"; label: string; dateLabel: string }> = {
  draft: { status: "submitted", label: "Mark submitted", dateLabel: "Submitted on" },
  submitted: { status: "approved", label: "Mark approved", dateLabel: "Approved on" },
  approved: { status: "paid", label: "Mark paid", dateLabel: "Paid on" },
};

export function PayAppStatusActions({ payAppId, projectId, status }: Props) {
  const router = useRouter();
  const [onDate, setOnDate] = useState(localToday);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function transition(next: "submitted" | "approved" | "paid") {
    setBusy(true);
    setError(null);
    const res = await setPayApplicationStatus(payAppId, projectId, next, onDate);
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
        {NEXT[status] && (
          <>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              {NEXT[status].dateLabel}
              <input
                type="date"
                value={onDate}
                max={localToday()}
                onChange={(e) => setOnDate(e.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
              />
            </label>
            <Button
              type="button"
              size="sm"
              disabled={busy || !onDate}
              onClick={() => transition(NEXT[status].status)}
            >
              {NEXT[status].label}
            </Button>
          </>
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
