"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  createSubcontractor,
  updateSubcontractor,
} from "./subs-actions";
import {
  COI_STATUS_OPTIONS,
  TRADE_OPTIONS,
  W9_STATUS_OPTIONS,
} from "./subs-constants";

export type SubFormValues = {
  id?: string;
  company_name: string;
  trade: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contract_value: number | null;
  retainage_pct: number | null;
  coi_status: string | null;
  w9_status: string | null;
  payment_terms: string | null;
};

type Props = {
  projectId: string;
  initial?: SubFormValues;
  trigger: React.ReactNode;
};

const EMPTY_VALUES: SubFormValues = {
  company_name: "",
  trade: null,
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  contract_value: null,
  retainage_pct: 10,
  coi_status: "pending",
  w9_status: "pending",
  payment_terms: "Net 30",
};

export function SubFormDialog({ projectId, initial, trigger }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);

  const values = initial ?? EMPTY_VALUES;
  const isEdit = Boolean(initial?.id);

  const handleSubmit = async (formData: FormData) => {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    const result = isEdit && initial?.id
      ? await updateSubcontractor(initial.id, projectId, formData)
      : await createSubcontractor(projectId, formData);
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
                {isEdit ? "Edit subcontractor" : "Add subcontractor"}
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
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="company_name">
                    Company name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="company_name"
                    name="company_name"
                    defaultValue={values.company_name}
                    required
                    placeholder="ABC Electrical, LLC"
                    aria-invalid={Boolean(fieldErrors.company_name)}
                  />
                  {fieldErrors.company_name && (
                    <p className="text-xs text-destructive">{fieldErrors.company_name}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="trade">Trade</Label>
                  <select
                    id="trade"
                    name="trade"
                    defaultValue={values.trade ?? ""}
                    className={cn(
                      "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                      "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    )}
                  >
                    <option value="">-</option>
                    {TRADE_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="contract_value">Contract value (USD)</Label>
                  <Input
                    id="contract_value"
                    name="contract_value"
                    type="text"
                    inputMode="decimal"
                    defaultValue={values.contract_value ?? ""}
                    placeholder="250000"
                    aria-invalid={Boolean(fieldErrors.contract_value)}
                  />
                  {fieldErrors.contract_value && (
                    <p className="text-xs text-destructive">{fieldErrors.contract_value}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="contact_name">Contact name</Label>
                  <Input
                    id="contact_name"
                    name="contact_name"
                    defaultValue={values.contact_name ?? ""}
                    placeholder="Jane Smith"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="contact_phone">Contact phone</Label>
                  <Input
                    id="contact_phone"
                    name="contact_phone"
                    type="tel"
                    defaultValue={values.contact_phone ?? ""}
                    placeholder="(555) 123-4567"
                  />
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="contact_email">Contact email</Label>
                  <Input
                    id="contact_email"
                    name="contact_email"
                    type="email"
                    defaultValue={values.contact_email ?? ""}
                    placeholder="jane@example.com"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="coi_status">COI status</Label>
                  <select
                    id="coi_status"
                    name="coi_status"
                    defaultValue={values.coi_status ?? "pending"}
                    className={cn(
                      "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                      "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    )}
                  >
                    {COI_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="w9_status">W9 status</Label>
                  <select
                    id="w9_status"
                    name="w9_status"
                    defaultValue={values.w9_status ?? "pending"}
                    className={cn(
                      "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                      "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    )}
                  >
                    {W9_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
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

                <div className="space-y-2">
                  <Label htmlFor="payment_terms">Payment terms</Label>
                  <Input
                    id="payment_terms"
                    name="payment_terms"
                    defaultValue={values.payment_terms ?? "Net 30"}
                    placeholder="Net 30"
                  />
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
                  {submitting ? "Saving..." : isEdit ? "Save changes" : "Add subcontractor"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
