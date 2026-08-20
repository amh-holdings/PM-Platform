"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";

import { recordSubBill } from "../../actions";

type Line = {
  item_number: string;
  section_name: string | null;
  description: string;
  scheduled_value: number;
  from_previous: number;
};

type Props = {
  projectId: string;
  subId: string;
  appNumber: number;
  retainagePct: number;
  paymentTermsDays: number | null;
  priorAppNumber: number | null;
  priorBilledToDate: number;
  lines: Line[];
};

export function BillEntryForm({
  projectId,
  subId,
  appNumber,
  retainagePct,
  paymentTermsDays,
  priorAppNumber,
  priorBilledToDate,
  lines,
}: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  // Live running total so the person entering the bill can see immediately
  // whether it foots to the sub's stated figure before they save.
  const enteredTotal = useMemo(
    () =>
      Object.values(amounts).reduce((s, v) => {
        const num = Number((v ?? "").replace(/[$,\s]/g, ""));
        return s + (Number.isFinite(num) ? num : 0);
      }, 0),
    [amounts],
  );
  const retainage = Math.round(enteredTotal * (retainagePct / 100) * 100) / 100;

  let lastSection: string | null = null;

  return (
    <form
      action={(fd) => {
        setError(null);
        startTransition(async () => {
          const res = await recordSubBill(projectId, subId, fd);
          if (!res.ok) setError(res.error);
          else router.push(`/projects/${projectId}/sub-billing/${subId}/${res.id}`);
        });
      }}
      className="space-y-5"
    >
      <input type="hidden" name="app_number" value={appNumber} />

      {/* ------------------------------ Header ------------------------------ */}
      <section className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-3">
        <Field label="Application date" name="app_date" type="date" />
        <Field label="Period start (leave blank if billed through a date)" name="period_start" type="date" />
        <Field label="Period end" name="period_end" type="date" required />
        <Field label="Invoice number" name="invoice_number" />
        <Field label="Invoice date" name="invoice_date" type="date" />
        <Field
          label="Invoice total (as stated)"
          name="invoice_total"
          placeholder="Checked against the line total"
        />
        <Field label="Retainage %" name="retainage_pct" defaultValue={String(retainagePct)} />
        <Field
          label="Payment terms (days, as stated on the bill)"
          name="payment_terms_days"
          defaultValue={paymentTermsDays != null ? String(paymentTermsDays) : ""}
        />
        <Field label="Due date" name="due_date" type="date" />
      </section>

      {/* ------------------------------- Lines ------------------------------ */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Billed this period, by line</h3>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2 text-right">Scheduled value</th>
                <th className="px-3 py-2 text-right">
                  From previous{priorAppNumber ? ` (app ${priorAppNumber})` : ""}
                </th>
                <th className="px-3 py-2 text-right">This period</th>
                <th className="px-3 py-2 text-right">Stored materials</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((l) => {
                const showSection = l.section_name !== lastSection;
                lastSection = l.section_name;
                return (
                  <>
                    {showSection && l.section_name && (
                      <tr key={`s-${l.item_number}`} className="bg-muted/30">
                        <td colSpan={6} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide">
                          {l.section_name}
                        </td>
                      </tr>
                    )}
                    <tr key={l.item_number}>
                      <td className="px-3 py-1.5 tabular-nums">{l.item_number}</td>
                      <td className="px-3 py-1.5">{l.description}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatCurrency(l.scheduled_value)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                        {l.from_previous > 0 ? formatCurrency(l.from_previous) : "-"}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          name={`this_period__${l.item_number}`}
                          inputMode="decimal"
                          placeholder="0.00"
                          value={amounts[l.item_number] ?? ""}
                          onChange={(e) =>
                            setAmounts((a) => ({ ...a, [l.item_number]: e.target.value }))
                          }
                          className="w-32 rounded-md border bg-background px-2 py-1 text-right text-sm"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          name={`stored__${l.item_number}`}
                          inputMode="decimal"
                          placeholder="0.00"
                          className="w-28 rounded-md border bg-background px-2 py-1 text-right text-sm"
                        />
                      </td>
                    </tr>
                  </>
                );
              })}
            </tbody>
            <tfoot className="border-t-2 bg-muted/30 font-medium">
              <tr>
                <td className="px-3 py-2" colSpan={4}>
                  Entered total
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(enteredTotal)}</td>
                <td />
              </tr>
              <tr>
                <td className="px-3 py-2 text-muted-foreground" colSpan={4}>
                  Less {retainagePct}% retainage, expected amount due
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatCurrency(enteredTotal - retainage)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* ---------------- The sub's own stated totals + waiver -------------- */}
      <section className="space-y-3 rounded-md border bg-card p-4">
        <div>
          <h3 className="text-sm font-semibold">What their form says</h3>
          <p className="text-xs text-muted-foreground">
            Copy their bottom-line figures here. Anything that disagrees with
            the numbers above becomes a failed check rather than silently
            replacing ours.
            {priorAppNumber &&
              ` Application ${priorAppNumber} ended at ${formatCurrency(priorBilledToDate)} billed to date.`}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Total this period" name="billed_this_period" />
          <Field label="Total completed to date" name="billed_to_date" />
          <Field label="Previous billings" name="billed_previous" />
          <Field label="Retainage this period" name="retainage_this_period" />
          <Field label="Retainage held to date" name="retainage_to_date" />
          <Field label="Amount due this period" name="amount_due" />
        </div>

        <div className="space-y-2 border-t pt-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="lien_waiver_received" />
            Conditional lien waiver received
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Waiver amount" name="lien_waiver_amount" />
            <Field label="Waiver through date" name="lien_waiver_through_date" type="date" />
          </div>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-medium">Notes</span>
          <textarea
            name="notes"
            rows={2}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            placeholder="Source document, anything unusual about this bill"
          />
        </label>
      </section>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving and checking..." : "Save and run checks"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Saving runs every check and the field verification immediately.
        </span>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
      />
    </label>
  );
}
