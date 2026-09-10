"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createBillingLine,
  updateBillingLine,
} from "../billing-line-actions";

export type BillingLineFormValues = {
  id?: string;
  item_number: string;
  type: string | null;
  description: string;
  scheduled_value: number | null;
  sort_order: number | null;
  notes: string | null;
  /** Set when this line is owned by an approved change order. */
  coNumber?: string | null;
};

type Props = {
  projectId: string;
  initial?: BillingLineFormValues;
  /** Types already in use on this project, offered as an autocomplete. */
  knownTypes?: string[];
  trigger: React.ReactNode;
};

const EMPTY: BillingLineFormValues = {
  item_number: "",
  type: null,
  description: "",
  scheduled_value: null,
  sort_order: null,
  notes: null,
};

export function BillingLineDialog({
  projectId,
  initial,
  knownTypes = [],
  trigger,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const values = initial ?? EMPTY;
  const isEdit = Boolean(initial?.id);

  async function handleSubmit(formData: FormData) {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    const result =
      isEdit && initial?.id
        ? await updateBillingLine(initial.id, projectId, formData)
        : await createBillingLine(projectId, formData);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      if (result.fieldErrors) setFieldErrors(result.fieldErrors);
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  }

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-block">
        {trigger}
      </span>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">
                  {isEdit ? `Edit item ${values.item_number}` : "Add SOV line"}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  A line on the owner schedule of values. This is what the G703
                  bills against.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>

            {values.coNumber && (
              <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                This line belongs to change order{" "}
                <span className="font-medium">{values.coNumber}</span>. Its
                scheduled value normally comes from the CO - editing it here
                does not change the CO.
              </div>
            )}

            <form action={handleSubmit} className="mt-4 space-y-5">
              <div className="grid gap-4 sm:grid-cols-6">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="item_number">
                    Item number <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="item_number"
                    name="item_number"
                    defaultValue={values.item_number}
                    required
                    placeholder="6.02"
                    className="font-mono"
                    aria-invalid={Boolean(fieldErrors.item_number)}
                  />
                  {fieldErrors.item_number && (
                    <p className="text-xs text-destructive">
                      {fieldErrors.item_number}
                    </p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-4">
                  <Label htmlFor="type">Type</Label>
                  <Input
                    id="type"
                    name="type"
                    defaultValue={values.type ?? ""}
                    placeholder="Site Work"
                    list="billing-line-types"
                  />
                  <datalist id="billing-line-types">
                    {knownTypes.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </div>

                <div className="space-y-2 sm:col-span-6">
                  <Label htmlFor="description">
                    Description <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="description"
                    name="description"
                    defaultValue={values.description}
                    required
                    placeholder="Basin 1 excavation and haul"
                    aria-invalid={Boolean(fieldErrors.description)}
                  />
                  {fieldErrors.description && (
                    <p className="text-xs text-destructive">
                      {fieldErrors.description}
                    </p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-3">
                  <Label htmlFor="scheduled_value">Scheduled value (USD)</Label>
                  <Input
                    id="scheduled_value"
                    name="scheduled_value"
                    type="text"
                    inputMode="decimal"
                    defaultValue={values.scheduled_value ?? ""}
                    placeholder="85017.50"
                    aria-invalid={Boolean(fieldErrors.scheduled_value)}
                  />
                  {fieldErrors.scheduled_value ? (
                    <p className="text-xs text-destructive">
                      {fieldErrors.scheduled_value}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      $ and commas are fine. Wrap a deduct in parentheses.
                    </p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-3">
                  <Label htmlFor="sort_order">Sort order</Label>
                  <Input
                    id="sort_order"
                    name="sort_order"
                    type="text"
                    inputMode="numeric"
                    defaultValue={values.sort_order ?? ""}
                    placeholder={isEdit ? "" : "added at the end"}
                    aria-invalid={Boolean(fieldErrors.sort_order)}
                  />
                  {fieldErrors.sort_order ? (
                    <p className="text-xs text-destructive">
                      {fieldErrors.sort_order}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Where it sits on the G703. Leave blank to append.
                    </p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-6">
                  <Label htmlFor="notes">Notes</Label>
                  <Input
                    id="notes"
                    name="notes"
                    defaultValue={values.notes ?? ""}
                    placeholder="Optional - internal only, not printed on the G703"
                  />
                </div>
              </div>

              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2 border-t pt-4">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting
                    ? "Saving..."
                    : isEdit
                      ? "Save changes"
                      : "Add SOV line"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
