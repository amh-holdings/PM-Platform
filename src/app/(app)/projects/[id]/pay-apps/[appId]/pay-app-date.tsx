"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { formatDate } from "@/lib/format";
import { setPayApplicationDate } from "../../pay-app-actions";

/** "Submitted Oct 30, 2026" with a Change link that corrects the date in place. */
export function PayAppDate({
  payAppId,
  projectId,
  field,
  label,
  value,
}: {
  payAppId: string;
  projectId: string;
  field: "submitted_at" | "approved_at" | "paid_at";
  label: string;
  value: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [onDate, setOnDate] = useState(value.slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function save() {
    setBusy(true);
    setError(null);
    const res = await setPayApplicationDate(payAppId, projectId, field, onDate);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditing(false);
    startTransition(() => router.refresh());
  }

  if (!editing) {
    return (
      <div className="text-xs text-muted-foreground">
        {label} {formatDate(value)}{" "}
        <button type="button" className="underline-offset-2 hover:underline print:hidden" onClick={() => setEditing(true)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-0.5 print:hidden">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        <input
          type="date"
          value={onDate}
          onChange={(e) => setOnDate(e.target.value)}
          className="h-7 rounded-md border bg-background px-1 text-xs text-foreground"
        />
        <button type="button" disabled={busy || !onDate} className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="underline-offset-2 hover:underline" onClick={() => { setEditing(false); setError(null); }}>
          Cancel
        </button>
      </div>
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}
