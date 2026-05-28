"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { updateLinkedTasks } from "./billing-actions";

type Props = {
  billingLineId: string;
  projectId: string;
  itemNumber: string;
  description: string;
  initialCodes: string[];
};

export function BillingLinkForm({
  billingLineId,
  projectId,
  itemNumber,
  description,
  initialCodes,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initialCodes.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {initialCodes.length === 0
          ? "Link schedule tasks"
          : `Edit links (${initialCodes.length})`}
      </button>
    );
  }

  const onSave = async () => {
    setSubmitting(true);
    setError(null);
    setUnknown([]);
    const res = await updateLinkedTasks(billingLineId, projectId, value);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setUnknown(res.unknownCodes);
    startTransition(() => {
      router.refresh();
      if (res.unknownCodes.length === 0) setOpen(false);
    });
  };

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="text-xs font-medium">
        Linked tasks for {itemNumber} - {description}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Enter schedule WBS codes (one per line or comma separated). Auto-suggest
        will use these tasks&apos; status to estimate billing for upcoming months.
      </p>
      <textarea
        className={cn(
          "mt-2 h-20 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. 1.1.2, 1.1.3"
      />
      {error && (
        <p className="mt-1 text-xs text-destructive">{error}</p>
      )}
      {unknown.length > 0 && (
        <p className="mt-1 text-xs text-amber-600">
          Saved, but these codes don&apos;t exist in this project&apos;s schedule:{" "}
          {unknown.join(", ")}
        </p>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={submitting}
          onClick={() => {
            setValue(initialCodes.join(", "));
            setOpen(false);
          }}
        >
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={submitting} onClick={onSave}>
          {submitting ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
