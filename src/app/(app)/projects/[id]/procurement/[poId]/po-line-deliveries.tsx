"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format";
import { lineLabel } from "@/lib/po-payment-forecast";

import {
  setPoLineDelivery,
  type PoLineRow,
} from "../../procurement-actions";
import type { DeliveryTaskOption } from "./delivery-task-link";

/**
 * Which schedule row each item on the PO is delivered against.
 *
 * Zarina: "there are POs that has multiple deliveries on it. And each item
 * inside a PO can be linked to a line in the schedule."
 *
 * The PO-level link above says the whole order arrives as one delivery, which
 * is right for most POs and wrong for FTC Solar, where piles and racking land
 * three weeks apart against different schedule rows. One link gave both
 * shipments one date.
 *
 * Linking an item here overrides the order-level link for any payment
 * milestone tied to that item. Leave them all blank and nothing changes.
 */
export function PoLineDeliveries({
  poId,
  projectId,
  lines,
  options,
  poTaskWbs,
}: {
  poId: string;
  projectId: string;
  lines: PoLineRow[];
  options: DeliveryTaskOption[];
  /** The order-level link, named so the fallback is not a mystery. */
  poTaskWbs: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (lines.length === 0) return null;

  const save = async (
    lineId: string,
    input: { wbsCode: string | null; actualDeliveryDate?: string | null },
  ) => {
    setBusy(lineId);
    setError(null);
    const res = await setPoLineDelivery(lineId, poId, projectId, input);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => router.refresh());
  };

  const linked = lines.filter((l) => l.linkedDeliveryTaskWbsCode).length;

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Deliveries by item</h3>
          <p className="text-xs text-muted-foreground">
            Point each item at the schedule row it lands on. A payment tied to
            that item then follows it, instead of one date for the whole order.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {linked} of {lines.length} linked
          {poTaskWbs ? `, the rest follow ${poTaskWbs}` : ""}
        </span>
      </div>

      {error && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left font-medium">Item</th>
              <th className="px-2 py-2 text-left font-medium">Delivered against</th>
              <th className="px-2 py-2 text-left font-medium">Arrived</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((l) => {
              const task = options.find(
                (o) => o.wbsCode === l.linkedDeliveryTaskWbsCode,
              );
              return (
                <tr key={l.id}>
                  <td className="px-2 py-2 align-top">
                    <div className="font-medium">
                      {lineLabel({ line_no: l.lineNo, description: l.description })}
                    </div>
                    {/* The planned date of whatever it is pointed at, so the
                        consequence of the choice is on screen next to it. */}
                    {task?.endDate && (
                      <div className="text-[10px] text-muted-foreground">
                        plans to land {formatDate(task.endDate)}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 align-top">
                    <select
                      value={l.linkedDeliveryTaskWbsCode ?? ""}
                      disabled={busy === l.id}
                      onChange={(e) => save(l.id, { wbsCode: e.target.value || null })}
                      className="h-8 w-full max-w-sm rounded-md border border-input bg-background px-2 text-xs"
                      aria-label={`Schedule row for line ${l.lineNo ?? ""}`}
                    >
                      <option value="">
                        {poTaskWbs
                          ? `Follow the whole order (${poTaskWbs})`
                          : "Not linked"}
                      </option>
                      {options.map((o) => (
                        <option key={o.wbsCode} value={o.wbsCode}>
                          {o.wbsCode} {o.parentName ? `${o.parentName} ` : ""}
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2 align-top">
                    <Input
                      type="date"
                      defaultValue={l.actualDeliveryDate ?? ""}
                      disabled={busy === l.id}
                      onBlur={(e) =>
                        e.target.value !== (l.actualDeliveryDate ?? "") &&
                        save(l.id, {
                          wbsCode: l.linkedDeliveryTaskWbsCode,
                          actualDeliveryDate: e.target.value || null,
                        })
                      }
                      className="h-8 w-[10rem] text-xs"
                      aria-label={`Arrival date for line ${l.lineNo ?? ""}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
