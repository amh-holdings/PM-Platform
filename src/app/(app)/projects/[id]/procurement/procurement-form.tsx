"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { createProcurementOrder, updateProcurementOrder } from "../procurement-actions";

export type ProcurementFormValues = {
  id?: string;
  vendor_name: string;
  po_number: string | null;
  description: string | null;
  total_value: number | null;
  ordered_date: string | null;
  expected_delivery_date: string | null;
  actual_delivery_date: string | null;
  status: string | null;
  payment_terms_summary: string | null;
  document_id: string | null;
  notes: string | null;
};

type Props = {
  projectId: string;
  mode: "create" | "edit";
  initial?: ProcurementFormValues;
  documents: { id: string; label: string }[];
};

const STATUS_OPTIONS = ["active", "delivered", "complete", "cancelled"];

const EMPTY: ProcurementFormValues = {
  vendor_name: "",
  po_number: null,
  description: null,
  total_value: null,
  ordered_date: null,
  expected_delivery_date: null,
  actual_delivery_date: null,
  status: "active",
  payment_terms_summary: null,
  document_id: null,
  notes: null,
};

export function ProcurementForm({ projectId, mode, initial, documents }: Props) {
  const router = useRouter();
  const values = initial ?? EMPTY;
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  async function action(formData: FormData) {
    setError(null);
    setSubmitting(true);
    const result =
      mode === "edit" && values.id
        ? await updateProcurementOrder(values.id, projectId, formData)
        : await createProcurementOrder(projectId, formData);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startTransition(() => {
      router.push(`/projects/${projectId}/procurement/${result.id}`);
    });
  }

  return (
    <form action={action} className="space-y-4">
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="vendor_name">Vendor name *</Label>
            <Input
              id="vendor_name"
              name="vendor_name"
              defaultValue={values.vendor_name}
              placeholder="e.g. SMA America"
              required
            />
          </div>
          <div>
            <Label htmlFor="po_number">PO number</Label>
            <Input id="po_number" name="po_number" defaultValue={values.po_number ?? ""} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              name="description"
              defaultValue={values.description ?? ""}
              placeholder="e.g. SMA SHP-150 inverters, 12 units"
            />
          </div>
          <div>
            <Label htmlFor="total_value">Total PO value</Label>
            <Input
              id="total_value"
              name="total_value"
              type="number"
              step="0.01"
              defaultValue={values.total_value ?? ""}
            />
          </div>
          <div>
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              name="status"
              defaultValue={values.status ?? "active"}
              className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ordered_date">Ordered date</Label>
            <Input
              id="ordered_date"
              name="ordered_date"
              type="date"
              defaultValue={values.ordered_date ?? ""}
            />
          </div>
          <div>
            <Label htmlFor="expected_delivery_date">Expected delivery</Label>
            <Input
              id="expected_delivery_date"
              name="expected_delivery_date"
              type="date"
              defaultValue={values.expected_delivery_date ?? ""}
            />
          </div>
          <div>
            <Label htmlFor="actual_delivery_date">Actual delivery</Label>
            <Input
              id="actual_delivery_date"
              name="actual_delivery_date"
              type="date"
              defaultValue={values.actual_delivery_date ?? ""}
            />
          </div>
          <div>
            <Label htmlFor="document_id">Linked contract document</Label>
            <select
              id="document_id"
              name="document_id"
              defaultValue={values.document_id ?? ""}
              className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">- none -</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Upload contracts on /documents with category &quot;subcontract&quot; to see them here.
            </p>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="payment_terms_summary">Payment terms (free-text summary)</Label>
            <Input
              id="payment_terms_summary"
              name="payment_terms_summary"
              defaultValue={values.payment_terms_summary ?? ""}
              placeholder="e.g. 10% PO, 80% delivery, 10% commissioning"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <textarea
              id="notes"
              name="notes"
              defaultValue={values.notes ?? ""}
              className={cn(
                "h-16 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            />
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </section>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          onClick={() => router.back()}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving..." : mode === "edit" ? "Save changes" : "Create PO"}
        </Button>
      </div>
    </form>
  );
}
