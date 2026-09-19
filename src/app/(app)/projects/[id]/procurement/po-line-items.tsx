"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

export type PoLineItemValue = {
  id?: string;
  item_number: string;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  is_freight: boolean;
  notes: string;
};

export function emptyLineItem(is_freight = false): PoLineItemValue {
  return {
    item_number: "",
    description: "",
    quantity: "1",
    unit: "",
    unit_price: "",
    is_freight,
    notes: "",
  };
}

export function lineAmount(item: PoLineItemValue): number {
  const qty = Number(item.quantity);
  const price = Number(item.unit_price);
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return 0;
  return Math.round(qty * price * 100) / 100;
}

/** A row the user has actually filled in - blank rows are dropped on save. */
export function isRealLineItem(item: PoLineItemValue): boolean {
  return item.description.trim().length > 0 || lineAmount(item) !== 0;
}

export function summarizeLineItems(items: PoLineItemValue[]) {
  const real = items.filter(isRealLineItem);
  const freight = real
    .filter((i) => i.is_freight)
    .reduce((s, i) => s + lineAmount(i), 0);
  const total = real.reduce((s, i) => s + lineAmount(i), 0);
  return {
    count: real.length,
    freight: Math.round(freight * 100) / 100,
    total: Math.round(total * 100) / 100,
    depositBasis: Math.round((total - freight) * 100) / 100,
  };
}

type Props = {
  items: PoLineItemValue[];
  onChange: (items: PoLineItemValue[]) => void;
  disabled?: boolean;
};

/**
 * Itemized PO body. Every line is priced; lines flagged "Freight" roll into
 * freight_value and are carved out of the deposit basis, because vendors
 * quote deposits against equipment and bill shipping on delivery.
 */
export function PoLineItems({ items, onChange, disabled }: Props) {
  const [showNotes, setShowNotes] = useState(false);
  const totals = useMemo(() => summarizeLineItems(items), [items]);

  function patch(index: number, next: Partial<PoLineItemValue>) {
    onChange(items.map((it, i) => (i === index ? { ...it, ...next } : it)));
  }
  function addRow(is_freight = false) {
    onChange([...items, emptyLineItem(is_freight)]);
  }
  function removeRow(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }
  function moveRow(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  const hasFreight = items.some((i) => i.is_freight && isRealLineItem(i));

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b p-3">
        <div>
          <h3 className="text-sm font-semibold">Line items</h3>
          <p className="text-[10px] text-muted-foreground">
            One row per item on the vendor quote. Flag shipping rows as
            Freight - freight is excluded from the deposit basis, so a 30%
            deposit is charged on equipment only.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-[10px]"
          onClick={() => setShowNotes((v) => !v)}
        >
          {showNotes ? "Hide notes" : "Show notes"}
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-muted-foreground">
            <tr className="border-b">
              <th className="w-20 px-2 py-2 text-left font-medium">Item #</th>
              <th className="px-2 py-2 text-left font-medium">Description *</th>
              <th className="w-20 px-2 py-2 text-right font-medium">Qty</th>
              <th className="w-20 px-2 py-2 text-left font-medium">Unit</th>
              <th className="w-28 px-2 py-2 text-right font-medium">Unit price</th>
              <th className="w-28 px-2 py-2 text-right font-medium">Amount</th>
              <th className="w-20 px-2 py-2 text-center font-medium">Freight</th>
              <th className="w-24 px-2 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr
                key={index}
                className={cn(
                  "border-b last:border-0 align-top",
                  item.is_freight && "bg-blue-500/5",
                )}
              >
                <td className="px-2 py-1.5">
                  <Input
                    value={item.item_number}
                    onChange={(e) => patch(index, { item_number: e.target.value })}
                    disabled={disabled}
                    className="h-8 text-xs"
                    placeholder={String(index + 1)}
                    aria-label={`Line ${index + 1} item number`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    value={item.description}
                    onChange={(e) => patch(index, { description: e.target.value })}
                    disabled={disabled}
                    className="h-8 text-xs"
                    placeholder={
                      item.is_freight
                        ? "e.g. Freight to site - 2 flatbeds"
                        : "e.g. SMA SHP-150 inverter"
                    }
                    aria-label={`Line ${index + 1} description`}
                  />
                  {showNotes && (
                    <Input
                      value={item.notes}
                      onChange={(e) => patch(index, { notes: e.target.value })}
                      disabled={disabled}
                      className="mt-1 h-7 text-[10px]"
                      placeholder="Notes (optional)"
                      aria-label={`Line ${index + 1} notes`}
                    />
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    type="number"
                    step="0.0001"
                    value={item.quantity}
                    onChange={(e) => patch(index, { quantity: e.target.value })}
                    disabled={disabled}
                    className="h-8 text-right text-xs"
                    aria-label={`Line ${index + 1} quantity`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    value={item.unit}
                    onChange={(e) => patch(index, { unit: e.target.value })}
                    disabled={disabled}
                    className="h-8 text-xs"
                    placeholder="ea"
                    aria-label={`Line ${index + 1} unit`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    type="number"
                    step="0.01"
                    value={item.unit_price}
                    onChange={(e) => patch(index, { unit_price: e.target.value })}
                    disabled={disabled}
                    className="h-8 text-right text-xs"
                    aria-label={`Line ${index + 1} unit price`}
                  />
                </td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">
                  {formatCurrency(lineAmount(item))}
                </td>
                <td className="px-2 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={item.is_freight}
                    onChange={(e) => patch(index, { is_freight: e.target.checked })}
                    disabled={disabled}
                    className="h-3.5 w-3.5 accent-blue-600"
                    aria-label={`Line ${index + 1} is freight`}
                  />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <div className="flex justify-end gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-1.5 text-[10px]"
                      disabled={disabled || index === 0}
                      onClick={() => moveRow(index, -1)}
                      aria-label={`Move line ${index + 1} up`}
                    >
                      &uarr;
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-1.5 text-[10px]"
                      disabled={disabled || index === items.length - 1}
                      onClick={() => moveRow(index, 1)}
                      aria-label={`Move line ${index + 1} down`}
                    >
                      &darr;
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-1.5 text-[10px]"
                      disabled={disabled}
                      onClick={() => removeRow(index)}
                      aria-label={`Remove line ${index + 1}`}
                    >
                      &times;
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-4 text-center text-muted-foreground">
                  No line items yet. Add the equipment lines, then add a
                  freight line for shipping.
                </td>
              </tr>
            )}
          </tbody>
          {totals.count > 0 && (
            <tfoot className="border-t bg-muted/20 font-medium">
              <tr>
                <td colSpan={5} className="px-2 py-1.5 text-right">
                  Equipment subtotal (deposit basis)
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                  {formatCurrency(totals.depositBasis)}
                </td>
                <td colSpan={2} />
              </tr>
              <tr>
                <td colSpan={5} className="px-2 py-1.5 text-right text-muted-foreground">
                  Freight / shipping (no deposit)
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {formatCurrency(totals.freight)}
                </td>
                <td colSpan={2} />
              </tr>
              <tr className="border-t">
                <td colSpan={5} className="px-2 py-1.5 text-right">
                  Total PO value
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                  {formatCurrency(totals.total)}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t bg-muted/20 px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => addRow(false)}
        >
          Add line item
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || hasFreight}
          onClick={() => addRow(true)}
        >
          Add freight line
        </Button>
        {hasFreight && (
          <span className="text-[10px] text-muted-foreground">
            Freight line added - tick Freight on any other row to split it.
          </span>
        )}
      </div>
    </section>
  );
}
