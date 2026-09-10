"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { createSovLine, importSovLines } from "../actions";

type Props = { projectId: string; subcontractorId: string; hasLines: boolean };

const PLACEHOLDER = `1.01\tMobilization\t45,000.00
1.02\tPile installation\t312,500.00
1.03\tTracker assembly\t688,400.00`;

const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";

export function SovEditor({ projectId, subcontractorId, hasLines }: Props) {
  const [mode, setMode] = useState<"none" | "line" | "paste">(hasLines ? "none" : "paste");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setError(null);
    setResult(null);
    setSkipped([]);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === "line" ? "secondary" : "outline"}
          onClick={() => {
            reset();
            setMode((m) => (m === "line" ? "none" : "line"));
          }}
        >
          {mode === "line" ? "Cancel" : "Add a line"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "paste" ? "secondary" : "outline"}
          onClick={() => {
            reset();
            setMode((m) => (m === "paste" ? "none" : "paste"));
          }}
        >
          {mode === "paste" ? "Cancel" : hasLines ? "Paste more lines" : "Paste the SOV"}
        </Button>
      </div>

      {mode === "line" && (
        <form
          key="line"
          action={(fd) => {
            reset();
            startTransition(async () => {
              const res = await createSovLine(projectId, subcontractorId, fd);
              if (!res.ok) setError(res.error);
              else {
                setResult("Line added.");
                setMode("none");
              }
            });
          }}
          className="space-y-3 rounded-md border bg-card p-4"
        >
          <div className="grid gap-3 md:grid-cols-4">
            <label className="block space-y-1">
              <span className="text-xs font-medium">Item number</span>
              <input name="item_number" required placeholder="1.01" className={field} />
            </label>
            <label className="block space-y-1 md:col-span-2">
              <span className="text-xs font-medium">Description</span>
              <input name="description" required placeholder="As printed on the SOV" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Scheduled value</span>
              <input name="scheduled_value" required inputMode="decimal" placeholder="45,000.00" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Section</span>
              <input name="section_name" placeholder="Optional" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Quantity</span>
              <input name="quantity" inputMode="decimal" placeholder="Unit-price lines only" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Unit</span>
              <input name="unit" placeholder="ea, lf, kW" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Change order ref</span>
              <input name="change_order_ref" placeholder="CO-04" className={field} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="is_change_order" />
            This line came in on a change order
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving..." : "Add line"}
          </Button>
          <p className="text-xs text-muted-foreground">
            A new line starts unmapped. Map it to schedule tasks or commodities from the
            table below so bills against it can be verified.
          </p>
        </form>
      )}

      {mode === "paste" && (
        <form
          key="paste"
          action={(fd) => {
            reset();
            startTransition(async () => {
              const res = await importSovLines(projectId, subcontractorId, fd);
              if (!res.ok) setError(res.error);
              else {
                const parts = [];
                if (res.imported) parts.push(`${res.imported} line${res.imported === 1 ? "" : "s"} added`);
                if (res.updated) parts.push(`${res.updated} updated`);
                setResult(parts.length > 0 ? `${parts.join(", ")}.` : "Nothing changed.");
                setSkipped(res.skipped ?? []);
              }
            });
          }}
          className="space-y-3 rounded-md border bg-card p-4"
        >
          <label className="block space-y-1">
            <span className="text-xs font-medium">
              Paste the SOV range straight out of Excel
            </span>
            <textarea
              name="paste"
              rows={8}
              required
              placeholder={PLACEHOLDER}
              className={`${field} font-mono text-xs`}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Columns: item number, description, scheduled value, then optionally quantity,
            unit and unit cost. A header row is read if there is one, so column order does
            not have to match. Item numbers already on the SOV are updated in place and
            keep their evidence mapping. Total rows are ignored.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="is_change_order" />
              These are change order lines
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-xs font-medium">CO ref</span>
              <input name="change_order_ref" placeholder="CO-04" className="rounded-md border bg-background px-2 py-1 text-sm" />
            </label>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Reading..." : "Load these lines"}
          </Button>
        </form>
      )}

      {result && <p className="text-xs font-medium text-emerald-700">{result}</p>}
      {skipped.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-900">
            {skipped.length} row{skipped.length === 1 ? " was" : "s were"} not imported:
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
            {skipped.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
