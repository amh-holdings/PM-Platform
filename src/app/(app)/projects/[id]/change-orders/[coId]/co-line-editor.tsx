"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { addCoBillingLine, removeCoBillingLine } from "../../change-orders-actions";

type LineRow = {
  id: string;
  itemNumber: string;
  description: string;
  scheduledValue: number;
};

type Props = {
  projectId: string;
  changeOrderId: string;
  coValue: number;
  lines: LineRow[];
  linesTotal: number;
  drift: number;
};

export function CoLineEditor({
  projectId,
  changeOrderId,
  coValue,
  lines,
  linesTotal,
  drift,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [itemNumber, setItemNumber] = useState("");
  const [description, setDescription] = useState("");
  const [scheduledValue, setScheduledValue] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function onAdd() {
    setErr(null);
    if (!itemNumber.trim() || !description.trim()) {
      setErr("Item number and description are required");
      return;
    }
    const val = Number(scheduledValue.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(val) || val < 0) {
      setErr("Scheduled value must be a positive number");
      return;
    }
    const res = await addCoBillingLine({
      projectId,
      changeOrderId,
      itemNumber: itemNumber.trim(),
      description: description.trim(),
      scheduledValue: val,
    });
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    setItemNumber("");
    setDescription("");
    setScheduledValue("");
    setAdding(false);
    refresh();
  }

  async function onRemove(lineId: string) {
    setErr(null);
    const res = await removeCoBillingLine(lineId, changeOrderId, projectId);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    refresh();
  }

  const driftAbs = Math.abs(drift);
  const driftTone =
    drift > 1
      ? "text-amber-600"
      : drift < -1
        ? "text-destructive"
        : "text-emerald-600";

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <div>
          <h3 className="text-sm font-semibold">SOV line items under this CO</h3>
          <p className="text-xs text-muted-foreground">
            Each line shows up on the AFP G703 sheet. Multiple sub-lines let
            you bill components separately (e.g. storage + SCADA increase).
          </p>
        </div>
        <div className="text-right text-xs">
          <div className="text-muted-foreground">SOV lines total / CO value</div>
          <div className="font-semibold">
            {formatCurrency(linesTotal)} / {formatCurrency(coValue)}
          </div>
          {driftAbs > 1 && (
            <div className={cn("text-[10px]", driftTone)}>
              {drift > 0
                ? `${formatCurrency(drift)} of CO not yet on SOV`
                : `${formatCurrency(driftAbs)} above CO value`}
            </div>
          )}
        </div>
      </div>

      {lines.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">Item #</th>
              <th className="px-3 py-2 text-left font-medium">Description</th>
              <th className="px-3 py-2 text-right font-medium">Scheduled value</th>
              <th className="w-24 px-3 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b hover:bg-muted/30">
                <td className="px-3 py-2 font-mono">{l.itemNumber}</td>
                <td className="px-3 py-2">{l.description}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatCurrency(l.scheduledValue)}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => onRemove(l.id)}
                  >
                    Detach
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="border-t p-3">
        {!adding ? (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {lines.length === 0
                ? "No SOV lines yet for this CO. Add one to make it billable."
                : "Add another sub-line if the CO covers multiple components."}
            </p>
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              Add SOV line
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-[120px_1fr_140px_auto]">
              <Input
                value={itemNumber}
                onChange={(e) => setItemNumber(e.target.value)}
                placeholder="e.g. 14.00"
              />
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Equipment storage"
              />
              <Input
                value={scheduledValue}
                onChange={(e) => setScheduledValue(e.target.value)}
                placeholder="$ scheduled value"
                inputMode="decimal"
                className="text-right"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={onAdd}>
                  Add
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAdding(false);
                    setErr(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
            {drift > 0 && (
              <p className="text-[10px] text-muted-foreground">
                Hint: {formatCurrency(drift)} of the CO value is still
                unallocated to SOV lines.
              </p>
            )}
          </div>
        )}
        {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
      </div>
    </section>
  );
}
