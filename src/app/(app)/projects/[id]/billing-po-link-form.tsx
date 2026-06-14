"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

import { updateBillingLineProcurementLinks } from "./billing-actions";

export type PoOption = {
  id: string;
  poNumber: string | null;
  vendorName: string;
  totalValue: number;
  status: string | null;
};

type Props = {
  billingLineId: string;
  projectId: string;
  itemNumber: string;
  description: string;
  initialPoIds: string[];
  availablePos: PoOption[];
};

// Inline UI to link a procurement-scope billing_line to one or more
// procurement_orders. Used on the /billing page next to (or in place of)
// the schedule WBS link form for procurement-typed lines.
export function BillingPoLinkForm({
  billingLineId,
  projectId,
  itemNumber,
  description,
  initialPoIds,
  availablePos,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialPoIds));
  const [open, setOpen] = useState(false);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSave() {
    setError(null);
    startSaving(async () => {
      const result = await updateBillingLineProcurementLinks(
        billingLineId,
        projectId,
        Array.from(selected),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  }

  const selectedTotal = availablePos
    .filter((p) => selected.has(p.id))
    .reduce((s, p) => s + p.totalValue, 0);

  const selectedPos = availablePos.filter((p) => selected.has(p.id));

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {selectedPos.length === 0 ? (
          <span className="text-[10px] italic text-muted-foreground">
            No POs linked
          </span>
        ) : (
          selectedPos.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-700"
              title={`${p.vendorName} - ${formatCurrency(p.totalValue)}`}
            >
              {p.poNumber ?? "(no#)"}
            </span>
          ))
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
        >
          {open ? "Close" : selectedPos.length > 0 ? "Edit" : "Link POs"}
        </button>
      </div>

      {open && (
        <div className="mt-1 rounded-md border bg-card p-2 shadow-sm">
          <div className="mb-1 text-[10px] font-medium text-muted-foreground">
            Link POs to {itemNumber} - {description}
          </div>
          <div className="max-h-48 overflow-y-auto">
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="w-6 py-1 text-left font-medium"></th>
                  <th className="py-1 pr-1 text-left font-medium">PO #</th>
                  <th className="py-1 pr-1 text-left font-medium">Vendor</th>
                  <th className="py-1 pr-1 text-right font-medium">Total</th>
                  <th className="py-1 pr-1 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {availablePos.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-2 text-center text-muted-foreground">
                      No procurement orders on this project yet.
                    </td>
                  </tr>
                )}
                {availablePos.map((p) => {
                  const isChecked = selected.has(p.id);
                  return (
                    <tr
                      key={p.id}
                      className={cn(
                        "border-b last:border-0 cursor-pointer hover:bg-muted/50",
                        isChecked && "bg-blue-500/5",
                        p.status === "cancelled" && "opacity-60",
                      )}
                      onClick={() => toggle(p.id)}
                    >
                      <td className="py-1">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggle(p.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-3 w-3"
                        />
                      </td>
                      <td className="py-1 pr-1 font-mono">{p.poNumber ?? "-"}</td>
                      <td className="py-1 pr-1">{p.vendorName}</td>
                      <td className="py-1 pr-1 text-right">
                        {formatCurrency(p.totalValue)}
                      </td>
                      <td className="py-1 pr-1 text-muted-foreground">
                        {p.status ?? "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex items-center justify-between">
            <div className="text-[10px] text-muted-foreground">
              {selected.size} selected, {formatCurrency(selectedTotal)} total
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSelected(new Set(initialPoIds));
                  setOpen(false);
                }}
                disabled={saving}
                className="h-6 px-2 text-[10px]"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving}
                className="h-6 px-2 text-[10px]"
              >
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
          {error && <p className="mt-1 text-[10px] text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}
