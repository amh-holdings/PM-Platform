"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { formatCurrency } from "@/lib/format";
import {
  derivedExtended,
  draftAsLines,
  extendedIsAuto,
  parseUnits,
  poTotals,
  unitsText,
  type DraftLine,
} from "@/lib/procurement-lines";

/**
 * The line-item table on the Add purchase order form.
 *
 * Zarina, after the editor shipped on the detail page: "nothings changed". She
 * asked for line items on the PO FORM and showed me the form. Putting them on
 * the detail page followed the milestone convention and answered a question
 * she had not asked.
 *
 * A new PO has no id, so nothing can be written as it is typed. The rows live
 * in state and post as JSON in a hidden field; the create action inserts them
 * once the order exists. The totals below add up as you go, so the value of
 * the order is visible before it is saved.
 */
export function PoDraftLines({
  name = "draft_lines",
  taxName = "sales_tax",
  freightName = "freight",
}: {
  name?: string;
  taxName?: string;
  freightName?: string;
}) {
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [tax, setTax] = useState<number | null>(null);
  const [freight, setFreight] = useState<number | null>(null);

  const totals = poTotals({
    lines: draftAsLines(lines),
    salesTax: tax,
    freight,
  });

  function add() {
    setLines((prev) => [
      ...prev,
      {
        lineNo: prev.length + 1,
        quantity: null,
        description: null,
        units: null,
        unitPrice: null,
        extendedPrice: null,
      },
    ]);
  }

  /**
   * Edit a line, and total the extended price as you go.
   *
   * Zarina: "Should automatically total the extended." Whether it keeps
   * following is read off the line itself rather than remembered, so a figure
   * somebody typed and a box somebody cleared both survive a later change to
   * the quantity. See extendedIsAuto.
   *
   * Quantity and Units are one box here too, the same as on the detail page.
   * Zarina: "they are just the same with units." A patch that carries units
   * carries the quantity parsed out of it, so the extended price still
   * follows. See parseUnits.
   */
  function patch(i: number, next: Partial<DraftLine>) {
    setLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== i) return l;
        const merged = { ...l, ...next };
        const touchedExtended = "extendedPrice" in next;
        const wasAuto = extendedIsAuto({
          quantity: l.quantity,
          unit_price: l.unitPrice,
          extended_price: l.extendedPrice,
        });
        if (touchedExtended || !wasAuto) return merged;
        return {
          ...merged,
          extendedPrice: derivedExtended({
            quantity: merged.quantity,
            unit_price: merged.unitPrice,
          }),
        };
      }),
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      {/* What actually posts. Everything above is the editor. */}
      <input type="hidden" name={name} value={JSON.stringify(lines)} />
      <input type="hidden" name={taxName} value={tax ?? ""} />
      <input type="hidden" name={freightName} value={freight ?? ""} />

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="text-sm font-medium">Line items</span>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            What the PO buys. The subtotal is the extended prices; tax and
            freight sit below it, the way the paper form reads. Leave Total PO
            value blank and this becomes it.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={add}>
          Add line
        </Button>
      </div>

      {lines.length === 0 ? (
        <p className="rounded border border-dashed p-3 text-xs text-muted-foreground">
          No line items. Add them here and they save with the PO, or leave this
          empty and add them on the detail page later.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] table-fixed text-xs">
            <colgroup>
              {/* Fixed widths, so a header sits over its own box. Without
                  them the browser sizes each column to its content and a
                  narrow input drifts away from the label above it. */}
              <col className="w-[7%]" />
              <col className="w-[36%]" />
              <col className="w-[12%]" />
              <col className="w-[16%]" />
              <col className="w-[18%]" />
              <col className="w-[11%]" />
            </colgroup>
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-4 py-1 text-left font-medium">Line</th>
                <th className="px-4 py-1 text-left font-medium">Description</th>
                <th className="px-4 py-1 text-left font-medium">Units</th>
                <th className="px-4 py-1 text-right font-medium">Unit price</th>
                <th className="px-4 py-1 text-right font-medium">Extended</th>
                <th className="px-1 py-1" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const suggested = derivedExtended({
                  quantity: l.quantity,
                  unit_price: l.unitPrice,
                });
                return (
                  <tr key={i}>
                    <td className="px-1 py-1">
                      <Input
                        value={l.lineNo ?? ""}
                        onChange={(e) =>
                          patch(i, {
                            lineNo:
                              e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                        inputMode="numeric"
                        className="h-8 w-full text-xs"
                        aria-label={`Line number ${i + 1}`}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <Input
                        value={l.description ?? ""}
                        onChange={(e) => patch(i, { description: e.target.value })}
                        placeholder="Domestic Beam W6x25 cut @ (3.3m)"
                        className="h-8 w-full text-xs"
                        aria-label={`Description ${i + 1}`}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <Input
                        value={unitsText(l)}
                        onChange={(e) => {
                          const parsed = parseUnits(e.target.value);
                          patch(i, {
                            quantity: parsed.quantity,
                            units: parsed.units,
                          });
                        }}
                        placeholder="410 EA"
                        className="h-8 w-full text-xs"
                        aria-label={`Units ${i + 1}`}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <MoneyInput
                        value={l.unitPrice}
                        onValueChange={(v) => patch(i, { unitPrice: v })}
                        className="h-8 w-full text-right text-xs"
                        aria-label={`Unit price ${i + 1}`}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <MoneyInput
                        value={l.extendedPrice}
                        onValueChange={(v) => patch(i, { extendedPrice: v })}
                        className="h-8 w-full text-right text-xs"
                        aria-label={`Extended price ${i + 1}`}
                      />
                      {/* The box fills itself. This is the way back after
                          clearing it, which is how a freight line says it
                          carries no extended price. */}
                      {suggested != null && l.extendedPrice == null && (
                        <button
                          type="button"
                          className="mt-0.5 block w-full pr-3 text-right text-[10px] text-emerald-700 hover:underline"
                          onClick={() => patch(i, { extendedPrice: suggested })}
                        >
                          use {formatCurrency(suggested)}
                        </button>
                      )}
                    </td>
                    <td className="px-1 py-1 text-right">
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          setLines((prev) => prev.filter((_, idx) => idx !== i))
                        }
                        aria-label={`Remove line ${i + 1}`}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} />
                <td className="px-4 py-1 text-right text-muted-foreground">
                  Subtotal
                </td>
                <td className="px-4 py-1 text-right font-mono">
                  {formatCurrency(totals.subtotal)}
                </td>
                <td />
              </tr>
              <tr>
                <td colSpan={3} />
                <td className="px-4 py-1 text-right text-muted-foreground">
                  Sales tax
                </td>
                <td className="px-1 py-1">
                  <MoneyInput
                    value={tax}
                    onValueChange={setTax}
                    className="h-8 w-full text-right text-xs"
                    aria-label="Sales tax"
                  />
                </td>
                <td />
              </tr>
              <tr>
                <td colSpan={3} />
                <td className="px-4 py-1 text-right text-muted-foreground">
                  Freight
                </td>
                <td className="px-1 py-1">
                  <MoneyInput
                    value={freight}
                    onValueChange={setFreight}
                    className="h-8 w-full text-right text-xs"
                    aria-label="Freight"
                  />
                </td>
                <td />
              </tr>
              <tr>
                <td colSpan={3} />
                <td className="px-4 py-1 text-right font-medium">Total</td>
                <td className="px-4 py-1 text-right font-mono font-semibold">
                  {formatCurrency(totals.total)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {totals.pricedButNotExtended > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {totals.pricedButNotExtended} line
          {totals.pricedButNotExtended === 1 ? " carries" : "s carry"} a unit
          price with no extended price, so
          {totals.pricedButNotExtended === 1 ? " it is" : " they are"} not in the
          subtotal. That is how the paper form handles freight and anything
          included in another line.
        </p>
      )}
    </div>
  );
}
