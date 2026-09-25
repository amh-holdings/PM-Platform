"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { formatCurrency } from "@/lib/format";
import {
  derivedExtended,
  describeTotalAgreement,
  extendedIsAuto,
  nextLineNo,
  parseUnits,
  poTotals,
  totalAgreement,
  unitsText,
} from "@/lib/procurement-lines";

import {
  addPoLine,
  applyLineTotalToPo,
  deletePoLine,
  setPoTaxAndFreight,
  updatePoLine,
  type PoLineRow,
} from "../../procurement-actions";

/**
 * The PO's line items, laid out the way the paper form is.
 *
 * Zarina: "I need to have option to add line items for PO forms. See PO form
 * we used." Line, description, units, unit price, extended price, then
 * Subtotal, Sales Tax, Freight, Total.
 *
 * Quantity and Units were two boxes until Zarina said "they are just the same
 * with units". They are one box now that reads the way the line reads out
 * loud, "410 EA". The number is still parsed out and stored in quantity, so
 * the extended price keeps totalling itself and nothing downstream changed.
 * See parseUnits.
 *
 * Extended price is offered from quantity times unit price and can be cleared,
 * because the real document does not always derive it. On PO-023 the freight
 * line carries a unit price and no extended price, since the freight is
 * carried below the subtotal instead; deriving it would bill it twice.
 */
export function PoLineEditor({
  poId,
  projectId,
  poValue,
  lines,
  salesTax,
  freight,
  available,
}: {
  poId: string;
  projectId: string;
  poValue: number;
  lines: PoLineRow[];
  salesTax: number | null;
  freight: number | null;
  available: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const blank = {
    lineNo: String(nextLineNo(lines.map((l) => ({ line_no: l.lineNo })))),
    description: "",
    units: "",
    unitPrice: null as number | null,
    extendedPrice: null as number | null,
  };
  const [draft, setDraft] = useState(blank);
  const [tax, setTax] = useState<number | null>(salesTax);
  const [frt, setFrt] = useState<number | null>(freight);

  const asLines = lines.map((l) => ({
    line_no: l.lineNo,
    quantity: l.quantity,
    unit_price: l.unitPrice,
    extended_price: l.extendedPrice,
  }));
  const totals = poTotals({ lines: asLines, salesTax: tax, freight: frt });
  const agreement = totalAgreement({
    lines: asLines,
    salesTax: tax,
    freight: frt,
    poValue,
  });
  const agreementNote = describeTotalAgreement(agreement, formatCurrency);

  async function run(
    fn: () => Promise<{ ok: true } | { ok: false; error: string }>,
  ) {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    startTransition(() => router.refresh());
    return true;
  }

  async function add() {
    const ok = await run(() =>
      addPoLine(poId, projectId, {
        lineNo: draft.lineNo.trim() === "" ? null : Number(draft.lineNo),
        quantity: parseUnits(draft.units).quantity,
        description: draft.description,
        units: parseUnits(draft.units).units ?? "",
        unitPrice: draft.unitPrice,
        extendedPrice: draft.extendedPrice,
      }),
    );
    if (ok) {
      setDraft({
        ...blank,
        lineNo: String(
          nextLineNo([...asLines, { line_no: Number(draft.lineNo) || null }]),
        ),
      });
    }
  }

  /**
   * Edit the row being added, totalling the extended price as you go.
   *
   * Zarina: "Should automatically total the extended." Whether it keeps
   * following is read off the row rather than remembered, so a typed figure
   * and a deliberately cleared box both survive a later quantity change.
   */
  function patchDraft(next: Partial<typeof draft>, touchedExtended = false) {
    setDraft((prev) => {
      const merged = { ...prev, ...next };
      const wasAuto = extendedIsAuto({
        quantity: parseUnits(prev.units).quantity,
        unit_price: prev.unitPrice,
        extended_price: prev.extendedPrice,
      });
      if (touchedExtended || !wasAuto) return merged;
      return {
        ...merged,
        extendedPrice: derivedExtended({
          quantity: parseUnits(merged.units).quantity,
          unit_price: merged.unitPrice,
        }),
      };
    });
  }

  // The box fills itself. This is the way back after clearing it.
  const suggested = derivedExtended({
    quantity: parseUnits(draft.units).quantity,
    unit_price: draft.unitPrice,
  });

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Line items</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            What the PO buys, line by line. The subtotal is the extended prices;
            tax and freight sit below it, the way the paper form reads.
          </p>
        </div>
        <div className="text-right text-xs">
          <div className="text-muted-foreground">Total from lines</div>
          <div className="font-mono text-sm font-medium">
            {formatCurrency(totals.total)}
          </div>
        </div>
      </div>

      {!available && (
        <p className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-800">
          Line items need database migration 0061. Everything else on this PO
          keeps working without it.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] table-fixed text-xs">
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
          <thead className="border-b bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-5 py-2 text-left font-medium">Line</th>
              <th className="px-5 py-2 text-left font-medium">Description</th>
              <th className="px-5 py-2 text-left font-medium">Units</th>
              <th className="px-5 py-2 text-right font-medium">Unit price</th>
              <th className="px-5 py-2 text-right font-medium">Extended price</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <LineRow
                key={l.id}
                line={l}
                busy={busy}
                editing={editing === l.id}
                onEdit={() => setEditing(l.id)}
                onCancel={() => setEditing(null)}
                onSave={async (patch) => {
                  const ok = await run(() =>
                    updatePoLine(l.id, poId, projectId, patch),
                  );
                  if (ok) setEditing(null);
                }}
                onDelete={() => run(() => deletePoLine(l.id, poId, projectId))}
              />
            ))}

            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-muted-foreground">
                  No line items yet. Add them below and the subtotal builds
                  itself.
                </td>
              </tr>
            )}

            {/* The row you type into. */}
            <tr className="border-t bg-muted/20">
              <td className="px-2 py-2">
                <Input
                  value={draft.lineNo}
                  onChange={(e) => setDraft({ ...draft, lineNo: e.target.value })}
                  inputMode="numeric"
                  className="h-8 w-full text-xs"
                  aria-label="Line number"
                />
              </td>
              <td className="px-2 py-2">
                <Input
                  value={draft.description}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                  placeholder="Domestic Beam W6x25 cut @ (3.3m)"
                  className="h-8 w-full text-xs"
                  aria-label="Description"
                />
              </td>
              <td className="px-2 py-2">
                <Input
                  value={draft.units}
                  onChange={(e) => patchDraft({ units: e.target.value })}
                  placeholder="410 EA"
                  className="h-8 w-full text-xs"
                  aria-label="Units"
                />
              </td>
              <td className="px-2 py-2">
                <MoneyInput
                  value={draft.unitPrice}
                  onValueChange={(v) => patchDraft({ unitPrice: v })}
                  className="h-8 w-full text-right text-xs"
                  aria-label="Unit price"
                />
              </td>
              <td className="px-2 py-2">
                <MoneyInput
                  value={draft.extendedPrice}
                  onValueChange={(v) => patchDraft({ extendedPrice: v }, true)}
                  className="h-8 w-full text-right text-xs"
                  aria-label="Extended price"
                />
                {suggested != null && draft.extendedPrice == null && (
                  <button
                    type="button"
                    className="mt-1 block w-full pr-3 text-right text-[10px] text-emerald-700 hover:underline"
                    onClick={() => setDraft({ ...draft, extendedPrice: suggested })}
                  >
                    use {formatCurrency(suggested)}
                  </button>
                )}
              </td>
              <td className="px-2 py-2 text-right">
                <Button size="sm" disabled={busy} onClick={() => void add()}>
                  Add
                </Button>
              </td>
            </tr>
          </tbody>

          <tfoot className="border-t">
            <tr>
              <td colSpan={3} />
              <td className="px-5 py-1.5 text-right text-muted-foreground">
                Subtotal
              </td>
              <td className="px-5 py-1.5 text-right font-mono">
                {formatCurrency(totals.subtotal)}
              </td>
              <td />
            </tr>
            <tr>
              <td colSpan={3} />
              <td className="px-5 py-1.5 text-right text-muted-foreground">
                Sales tax
              </td>
              <td className="px-2 py-1.5">
                <MoneyInput
                  value={tax}
                  onValueChange={setTax}
                  onBlur={() =>
                    void run(() =>
                      setPoTaxAndFreight(poId, projectId, {
                        salesTax: tax,
                        freight: frt,
                      }),
                    )
                  }
                  className="h-8 w-full text-right text-xs"
                  aria-label="Sales tax"
                />
              </td>
              <td />
            </tr>
            <tr>
              <td colSpan={3} />
              <td className="px-5 py-1.5 text-right text-muted-foreground">
                Freight
              </td>
              <td className="px-2 py-1.5">
                <MoneyInput
                  value={frt}
                  onValueChange={setFrt}
                  onBlur={() =>
                    void run(() =>
                      setPoTaxAndFreight(poId, projectId, {
                        salesTax: tax,
                        freight: frt,
                      }),
                    )
                  }
                  className="h-8 w-full text-right text-xs"
                  aria-label="Freight"
                />
              </td>
              <td />
            </tr>
            <tr className="border-t">
              <td colSpan={3} />
              <td className="px-5 py-2 text-right font-medium">Total</td>
              <td className="px-5 py-2 text-right font-mono font-semibold">
                {formatCurrency(totals.total)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {totals.pricedButNotExtended > 0 && (
        <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">
          {totals.pricedButNotExtended} line
          {totals.pricedButNotExtended === 1 ? " carries" : "s carry"} a unit
          price with no extended price, so
          {totals.pricedButNotExtended === 1 ? " it is" : " they are"} not in the
          subtotal. That is how the paper form handles freight and anything
          included in another line.
        </p>
      )}

      {agreementNote && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-amber-50 px-4 py-2">
          <p className="text-xs text-amber-900">{agreementNote}</p>
          {(agreement.state === "adopt" || agreement.state === "disagrees") && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  applyLineTotalToPo(poId, projectId, agreement.total),
                )
              }
            >
              Set PO value to {formatCurrency(agreement.total)}
            </Button>
          )}
        </div>
      )}

      {error && (
        <p className="border-t px-4 py-2 text-xs text-red-600">{error}</p>
      )}
    </section>
  );
}

function LineRow({
  line,
  busy,
  editing,
  onEdit,
  onCancel,
  onSave,
  onDelete,
}: {
  line: PoLineRow;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (patch: {
    lineNo: number | null;
    quantity: number | null;
    description: string;
    units: string;
    unitPrice: number | null;
    extendedPrice: number | null;
  }) => void;
  onDelete: () => void;
}) {
  const [lineNo, setLineNo] = useState(line.lineNo == null ? "" : String(line.lineNo));
  const [description, setDescription] = useState(line.description ?? "");
  // One box. "410 EA" goes back out as quantity 410 and units EA.
  const [units, setUnits] = useState(
    unitsText({ quantity: line.quantity, units: line.units }),
  );
  const [unitPrice, setUnitPrice] = useState<number | null>(line.unitPrice);
  const [extendedPrice, setExtendedPrice] = useState<number | null>(
    line.extendedPrice,
  );

  /**
   * Retotal the extended price while the row is being edited.
   *
   * Same rule as everywhere else: it follows quantity times unit price until
   * the row says otherwise, and what the row says is read off the row. A typed
   * figure stands and a cleared box on a priced line stays cleared, which is
   * the freight case.
   */
  function retotal(next: { units?: string; unitPrice?: number | null }) {
    const nextUnits = next.units ?? units;
    const u = next.unitPrice === undefined ? unitPrice : next.unitPrice;
    if (next.units !== undefined) setUnits(next.units);
    if (next.unitPrice !== undefined) setUnitPrice(next.unitPrice);
    const wasAuto = extendedIsAuto({
      quantity: parseUnits(units).quantity,
      unit_price: unitPrice,
      extended_price: extendedPrice,
    });
    if (!wasAuto) return;
    setExtendedPrice(
      derivedExtended({
        quantity: parseUnits(nextUnits).quantity,
        unit_price: u,
      }),
    );
  }

  if (!editing) {
    return (
      <tr className="border-b last:border-0">
        <td className="px-5 py-1.5 font-mono text-muted-foreground">
          {line.lineNo ?? "-"}
        </td>
        <td className="px-5 py-1.5 truncate">{line.description ?? "-"}</td>
        <td className="px-5 py-1.5 whitespace-nowrap text-muted-foreground">
          {unitsText({ quantity: line.quantity, units: line.units }) || "-"}
        </td>
        <td className="px-5 py-1.5 text-right font-mono">
          {line.unitPrice == null ? "-" : formatCurrency(line.unitPrice)}
        </td>
        <td className="px-5 py-1.5 text-right font-mono">
          {line.extendedPrice == null ? "-" : formatCurrency(line.extendedPrice)}
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 text-right">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={busy}
            className="ml-2 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            Remove
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b bg-accent/40 last:border-0">
      <td className="px-2 py-1.5">
        <Input
          value={lineNo}
          onChange={(e) => setLineNo(e.target.value)}
          inputMode="numeric"
          className="h-8 w-full text-xs"
          aria-label="Line number"
        />
      </td>
      <td className="px-2 py-1.5">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="h-8 w-full text-xs"
          aria-label="Description"
        />
      </td>
      <td className="px-2 py-1.5">
        <Input
          value={units}
          onChange={(e) => retotal({ units: e.target.value })}
          placeholder="410 EA"
          className="h-8 w-full text-xs"
          aria-label="Units"
        />
      </td>
      <td className="px-2 py-1.5">
        <MoneyInput
          value={unitPrice}
          onValueChange={(v) => retotal({ unitPrice: v })}
          className="h-8 w-full text-right text-xs"
          aria-label="Unit price"
        />
      </td>
      <td className="px-2 py-1.5">
        <MoneyInput
          value={extendedPrice}
          onValueChange={setExtendedPrice}
          className="h-8 w-full text-right text-xs"
          aria-label="Extended price"
        />
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-right">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            onSave({
              lineNo: lineNo.trim() === "" ? null : Number(lineNo),
              quantity: parseUnits(units).quantity,
              description,
              units: parseUnits(units).units ?? "",
              unitPrice,
              extendedPrice,
            })
          }
        >
          Save
        </Button>
        <button
          type="button"
          className="ml-2 text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
      </td>
    </tr>
  );
}
