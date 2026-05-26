"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCostCode, updateCostCode } from "./cost-actions";

export type CostCodeFormValues = {
  id?: string;
  code: string;
  name: string;
  description: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  is_change_order: boolean;
};

type Props = {
  projectId: string;
  initial?: CostCodeFormValues;
  trigger: React.ReactNode;
};

const EMPTY: CostCodeFormValues = {
  code: "",
  name: "",
  description: null,
  estimated_cost: null,
  actual_cost: 0,
  is_change_order: false,
};

export function CostCodeFormDialog({ projectId, initial, trigger }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const values = initial ?? EMPTY;
  const isEdit = Boolean(initial?.id);

  const handleSubmit = async (formData: FormData) => {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    const result = isEdit && initial?.id
      ? await updateCostCode(initial.id, projectId, formData)
      : await createCostCode(projectId, formData);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      if (result.fieldErrors) setFieldErrors(result.fieldErrors);
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  };

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-block">{trigger}</span>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-lg font-semibold">
                {isEdit ? "Edit cost code" : "Add cost code"}
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>

            <form action={handleSubmit} className="mt-4 space-y-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="code">
                    Code <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="code"
                    name="code"
                    defaultValue={values.code}
                    required
                    placeholder="SSC A"
                    aria-invalid={Boolean(fieldErrors.code)}
                  />
                  {fieldErrors.code && (
                    <p className="text-xs text-destructive">{fieldErrors.code}</p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="name">
                    Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="name"
                    name="name"
                    defaultValue={values.name}
                    required
                    placeholder="AHC Labor"
                    aria-invalid={Boolean(fieldErrors.name)}
                  />
                  {fieldErrors.name && (
                    <p className="text-xs text-destructive">{fieldErrors.name}</p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-3">
                  <Label htmlFor="description">Description</Label>
                  <Input
                    id="description"
                    name="description"
                    defaultValue={values.description ?? ""}
                    placeholder="Optional - details about this cost category"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="estimated_cost">Estimated cost (USD)</Label>
                  <Input
                    id="estimated_cost"
                    name="estimated_cost"
                    type="text"
                    inputMode="decimal"
                    defaultValue={values.estimated_cost ?? ""}
                    placeholder="164500"
                    aria-invalid={Boolean(fieldErrors.estimated_cost)}
                  />
                  {fieldErrors.estimated_cost && (
                    <p className="text-xs text-destructive">{fieldErrors.estimated_cost}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="actual_cost">Actual cost (USD)</Label>
                  <Input
                    id="actual_cost"
                    name="actual_cost"
                    type="text"
                    inputMode="decimal"
                    defaultValue={values.actual_cost ?? "0"}
                    placeholder="0"
                    aria-invalid={Boolean(fieldErrors.actual_cost)}
                  />
                  {fieldErrors.actual_cost && (
                    <p className="text-xs text-destructive">{fieldErrors.actual_cost}</p>
                  )}
                </div>

                <div className="flex items-end gap-2 sm:col-span-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="is_change_order"
                      defaultChecked={values.is_change_order}
                    />
                    <span>Change order</span>
                  </label>
                </div>
              </div>

              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2 border-t pt-4">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Saving..." : isEdit ? "Save changes" : "Add cost code"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
