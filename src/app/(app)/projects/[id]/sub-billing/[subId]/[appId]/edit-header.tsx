"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { HEADER_FIELDS } from "@/lib/sub-bill-header-edit";

import { updateBillHeader } from "../../actions";

/**
 * Correct the header of a bill already entered, without re-keying its lines.
 *
 * Opens on the figures on file. Saving writes only what changed, notes each
 * change on the bill with who made it, and runs the checks again, so the
 * verdict above reflects the corrected header straight away.
 */
export function EditBillHeader({
  projectId,
  appId,
  values,
}: {
  projectId: string;
  appId: string;
  values: Record<string, string | number | boolean | null>;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(formData: FormData) {
    setSaving(true);
    setError(null);
    const res = await updateBillHeader(projectId, appId, formData);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Edit bill header
      </Button>
    );
  }

  const asText = (v: string | number | boolean | null | undefined) =>
    v == null || typeof v === "boolean" ? "" : String(v);

  return (
    <form action={save} className="space-y-3 rounded-md border p-4">
      <div>
        <h3 className="text-sm font-semibold">Edit bill header</h3>
        <p className="text-xs text-muted-foreground">
          The figures from the sub&apos;s G702. Lines are not changed here. Leave
          previous, this period or to date blank to use our line totals. Each
          change is noted on the bill and the checks run again.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {HEADER_FIELDS.map((f) =>
          f.kind === "bool" ? (
            <label key={f.key} className="flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                name={f.key}
                defaultChecked={values[f.key] === true}
              />
              {f.label}
            </label>
          ) : (
            <label key={f.key} className="block space-y-1">
              <span className="text-xs font-medium">
                {f.label}
                {f.key === "period_end" && <span className="text-destructive"> *</span>}
              </span>
              <input
                name={f.key}
                type={f.kind === "date" ? "date" : "text"}
                inputMode={f.kind === "money" || f.kind === "number" ? "decimal" : undefined}
                defaultValue={asText(values[f.key])}
                required={f.key === "period_end"}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
          ),
        )}
      </div>
      {error && (
        <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700">{error}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving..." : "Save and re-check"}
        </Button>
      </div>
    </form>
  );
}
