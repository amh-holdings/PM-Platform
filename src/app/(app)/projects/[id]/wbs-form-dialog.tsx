"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { createWbsItem, updateWbsItem } from "./wbs-actions";

export type WbsFormValues = {
  id?: string;
  wbs_code: string;
  description: string;
  trade: string | null;
  subcontractor_id: string | null;
  contract_value: number | null;
  pct_complete_sub: number | null;
  pct_complete_ahc: number | null;
  retainage_pct: number | null;
  billed_to_date: number | null;
};

export type SubOption = {
  id: string;
  company_name: string;
};

type Props = {
  projectId: string;
  subs: SubOption[];
  initial?: WbsFormValues;
  trigger: React.ReactNode;
};

const EMPTY_VALUES: WbsFormValues = {
  wbs_code: "",
  description: "",
  trade: null,
  subcontractor_id: null,
  contract_value: null,
  pct_complete_sub: 0,
  pct_complete_ahc: 0,
  retainage_pct: 10,
  billed_to_date: 0,
};

export function WbsFormDialog({ projectId, subs, initial, trigger }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const values = initial ?? EMPTY_VALUES;
  const isEdit = Boolean(initial?.id);

  const handleSubmit = async (formData: FormData) => {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    const result = isEdit && initial?.id
      ? await updateWbsItem(initial.id, projectId, formData)
      : await createWbsItem(projectId, formData);
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
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-lg font-semibold">
                {isEdit ? "Edit WBS / SOV item" : "Add WBS / SOV item"}
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
              <div className="grid gap-4 sm:grid-cols-6">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="wbs_code">
                    WBS code <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="wbs_code"
                    name="wbs_code"
                    defaultValue={values.wbs_code}
                    required
                    placeholder="1.01"
                    aria-invalid={Boolean(fieldErrors.wbs_code)}
                  />
                  {fieldErrors.wbs_code && (
                    <p className="text-xs text-destructive">{fieldErrors.wbs_code}</p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-4">
                  <Label htmlFor="description">
                    Description <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="description"
                    name="description"
                    defaultValue={values.description}
                    required
                    placeholder="Engineering services (30% IFC)"
                    aria-invalid={Boolean(fieldErrors.description)}
                  />
                  {fieldErrors.description && (
                    <p className="text-xs text-destructive">{fieldErrors.description}</p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-3">
                  <Label htmlFor="trade">Trade</Label>
                  <Input
                    id="trade"
                    name="trade"
                    defaultValue={values.trade ?? ""}
                    placeholder="Electrical"
                  />
                </div>

                <div className="space-y-2 sm:col-span-3">
                  <Label htmlFor="subcontractor_id">Subcontractor</Label>
                  <select
                    id="subcontractor_id"
                    name="subcontractor_id"
                    defaultValue={values.subcontractor_id ?? ""}
                    className={cn(
                      "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                      "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    )}
                  >
                    <option value="">- (unassigned)</option>
                    {subs.map((s) => (
                      <option key={s.id} value={s.id}>{s.company_name}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2 sm:col-span-3">
                  <Label htmlFor="contract_value">Contract value (USD)</Label>
                  <Input
                    id="contract_value"
                    name="contract_value"
                    type="text"
                    inputMode="decimal"
                    defaultValue={values.contract_value ?? ""}
                    placeholder="22580"
                    aria-invalid={Boolean(fieldErrors.contract_value)}
                  />
                  {fieldErrors.contract_value && (
                    <p className="text-xs text-destructive">{fieldErrors.contract_value}</p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-3">
                  <Label htmlFor="billed_to_date">Billed to date (USD)</Label>
                  <Input
                    id="billed_to_date"
                    name="billed_to_date"
                    type="text"
                    inputMode="decimal"
                    defaultValue={values.billed_to_date ?? ""}
                    placeholder="0"
                    aria-invalid={Boolean(fieldErrors.billed_to_date)}
                  />
                  {fieldErrors.billed_to_date && (
                    <p className="text-xs text-destructive">{fieldErrors.billed_to_date}</p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="pct_complete_sub">Sub % complete</Label>
                  <Input
                    id="pct_complete_sub"
                    name="pct_complete_sub"
                    type="text"
                    inputMode="decimal"
                    defaultValue={values.pct_complete_sub ?? ""}
                    placeholder="0"
                    aria-invalid={Boolean(fieldErrors.pct_complete_sub)}
                  />
                  {fieldErrors.pct_complete_sub && (
                    <p className="text-xs text-destructive">{fieldErrors.pct_complete_sub}</p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="pct_complete_ahc">AHC % complete</Label>
                  <Input
                    id="pct_complete_ahc"
                    name="pct_complete_ahc"
                    type="text"
                    inputMode="decimal"
                    defaultValue={values.pct_complete_ahc ?? ""}
                    placeholder="0"
                    aria-invalid={Boolean(fieldErrors.pct_complete_ahc)}
                  />
                  {fieldErrors.pct_complete_ahc && (
                    <p className="text-xs text-destructive">{fieldErrors.pct_complete_ahc}</p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="retainage_pct">Retainage %</Label>
                  <Input
                    id="retainage_pct"
                    name="retainage_pct"
                    type="text"
                    inputMode="decimal"
                    defaultValue={values.retainage_pct ?? ""}
                    placeholder="10"
                    aria-invalid={Boolean(fieldErrors.retainage_pct)}
                  />
                  {fieldErrors.retainage_pct && (
                    <p className="text-xs text-destructive">{fieldErrors.retainage_pct}</p>
                  )}
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
                  {submitting ? "Saving..." : isEdit ? "Save changes" : "Add item"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
