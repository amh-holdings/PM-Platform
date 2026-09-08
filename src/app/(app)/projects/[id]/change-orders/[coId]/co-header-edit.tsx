"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { updateCoFormFields, updateCoNumber } from "../../change-orders-actions";

type Props = {
  coId: string;
  projectId: string;
  coNumber: string;
  description: string | null;
  dateOfChangeOrder: string | null;
};

/**
 * The three things that identify a change order, edited in place in the page
 * header.
 *
 * The number is auto-assigned at creation and has to stay changeable, and the
 * description is what titles the CO's SOV line. Neither justified a form
 * section of its own.
 */
export function CoHeaderEdit({
  coId,
  projectId,
  coNumber,
  description,
  dateOfChangeOrder,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [num, setNum] = useState(coNumber);
  const [desc, setDesc] = useState(description ?? "");
  const [date, setDate] = useState(dateOfChangeOrder ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    setBusy(true);
    if (num.trim() !== coNumber) {
      const res = await updateCoNumber(coId, projectId, num);
      if (!res.ok) {
        setBusy(false);
        setError(res.error);
        return;
      }
    }
    const res = await updateCoFormFields(coId, projectId, {
      description: desc.trim() || null,
      dateOfChangeOrder: date || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Edit number, description or date
      </button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="grid gap-2 sm:grid-cols-12">
        <input
          value={num}
          onChange={(e) => setNum(e.target.value)}
          placeholder="CO-07"
          aria-label="CO number"
          className={cn(inputCls, "sm:col-span-2 font-mono")}
        />
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Equipment storage and SCADA cost increase"
          aria-label="Description"
          className={cn(inputCls, "sm:col-span-7")}
        />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Date of change order"
          className={cn(inputCls, "sm:col-span-3")}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-2 text-xs">
        <span className="mr-auto text-muted-foreground">
          The description titles this CO&apos;s line on the G703.
        </span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setNum(coNumber);
            setDesc(description ?? "");
            setDate(dateOfChangeOrder ?? "");
            setError(null);
          }}
          className="rounded border px-2 py-1 hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
