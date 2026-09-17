"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/format";
import {
  extendedPrice,
  parseAmount,
  round2,
  type PoLineInput,
} from "@/lib/po-lines";

export type PoLineRow = PoLineInput & { key: string };

type Props = {
  rows: PoLineRow[];
  onChange: (rows: PoLineRow[]) => void;
  disabled?: boolean;
};

export function emptyRow(): PoLineRow {
  return {
    key: crypto.randomUUID(),
    description: "",
    quantity: "",
    unit: "",
    unitPrice: "",
  };
}

export function toRows(
  lines: {
    description: string;
    quantity: number | null;
    unit: string | null;
    unit_price: number | null;
  }[],
): PoLineRow[] {
  return lines.map((l) => ({
    key: crypto.randomUUID(),
    description: l.description ?? "",
    quantity: l.quantity == null ? "" : String(l.quantity),
    unit: l.unit ?? "",
    unitPrice: l.unit_price == null ? "" : String(l.unit_price),
  }));
}

/** What the server will compute, computed here so the form can show it live. */
export function rowsTotal(rows: PoLineRow[]): number {
  return round2(
    rows.reduce((sum, r) => {
      const ext = extendedPrice(parseAmount(r.quantity), parseAmount(r.unitPrice));
      return sum + (ext ?? 0);
    }, 0),
  );
}

export function hasAnyRow(rows: PoLineRow[]): boolean {
  return rows.some(
    (r) =>
      r.description.trim() || r.quantity.trim() || r.unit.trim() || r.unitPrice.trim(),
  );
}

export function PoLinesEditor({ rows, onChange, disabled }: Props) {
  const [showNotes, setShowNotes] = useState(false);

  const extensions = useMemo(
    () =>
      rows.map((r) =>
        extendedPrice(parseAmount(r.quantity), parseAmount(r.unitPrice)),
      ),
    [rows],
  );
  const total = useMemo(() => rowsTotal(rows), [rows]);
  const unpriced = extensions.filter((e) => e == null).length;
  const filled = hasAnyRow(rows);

  function patch(index: number, field: keyof PoLineInput, value: string) {
    onChange(rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Line items</h3>
          <p className="text-xs text-muted-foreground">
            Optional. When any line is priced, the PO total is the sum of the
            extended prices and the total field above stops accepting typing.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowNotes((v) => !v)}
        >
          {showNotes ? "Hide notes" : "Show notes"}
        </Button>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="w-8 pb-1 pr-2 font-medium">#</th>
              <th className="pb-1 pr-2 font-medium">Description</th>
              <th className="w-24 pb-1 pr-2 text-right font-medium">Qty</th>
              <th className="w-20 pb-1 pr-2 font-medium">Unit</th>
              <th className="w-32 pb-1 pr-2 text-right font-medium">Unit price</th>
              <th className="w-32 pb-1 pr-2 text-right font-medium">Extended</th>
              <th className="w-8 pb-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.key} className="align-top">
                <td className="py-1 pr-2 text-xs text-muted-foreground">{i + 1}</td>
                <td className="py-1 pr-2">
                  <Input
                    value={row.description}
                    disabled={disabled}
                    placeholder="e.g. SMA SHP-150 inverter"
                    onChange={(e) => patch(i, "description", e.target.value)}
                  />
                  {showNotes && (
                    <Input
                      value={row.notes ?? ""}
                      disabled={disabled}
                      placeholder="Notes"
                      className="mt-1 text-xs"
                      onChange={(e) => patch(i, "notes", e.target.value)}
                    />
                  )}
                </td>
                <td className="py-1 pr-2">
                  <Input
                    value={row.quantity}
                    disabled={disabled}
                    inputMode="decimal"
                    className="text-right"
                    onChange={(e) => patch(i, "quantity", e.target.value)}
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    value={row.unit}
                    disabled={disabled}
                    placeholder="ea"
                    onChange={(e) => patch(i, "unit", e.target.value)}
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    value={row.unitPrice}
                    disabled={disabled}
                    inputMode="decimal"
                    className="text-right"
                    onChange={(e) => patch(i, "unitPrice", e.target.value)}
                  />
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {extensions[i] == null ? (
                    <span className="text-xs text-muted-foreground">-</span>
                  ) : (
                    <span className="font-medium">
                      {formatCurrency(extensions[i] as number)}
                    </span>
                  )}
                </td>
                <td className="py-1 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Remove line ${i + 1}`}
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  >
                    x
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-3 text-xs text-muted-foreground">
                  No line items. The PO total stays whatever you type above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...rows, emptyRow()])}
        >
          Add line
        </Button>
        {filled && (
          <div className="text-right text-xs">
            {unpriced > 0 && (
              <div className="text-amber-600">
                {unpriced} line{unpriced === 1 ? "" : "s"} without a quantity and
                unit price - not counted in the total
              </div>
            )}
            <div className="text-muted-foreground">PO total from lines</div>
            <div className="text-base font-semibold tabular-nums">
              {formatCurrency(total)}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
