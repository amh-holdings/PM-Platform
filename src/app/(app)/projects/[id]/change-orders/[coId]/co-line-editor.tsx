"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  addCoBillingLine,
  linkCoBillingLine,
  removeCoBillingLine,
} from "../../change-orders-actions";

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
  /**
   * SOV lines on this project attached to no change order. Most of Sweet
   * Springs' COs were billed on paper before the app, so their line is already
   * on the sheet and only the link is missing.
   */
  linkable: LineRow[];
};

export function CoLineEditor({
  projectId,
  changeOrderId,
  coValue,
  lines,
  linesTotal,
  drift,
  linkable,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [itemNumber, setItemNumber] = useState("");
  const [description, setDescription] = useState("");
  const [scheduledValue, setScheduledValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkId, setLinkId] = useState("");
  const [busy, setBusy] = useState(false);

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

  async function onLink() {
    setErr(null);
    if (!linkId) {
      setErr("Pick the SOV line this change order is billed on");
      return;
    }
    setBusy(true);
    const res = await linkCoBillingLine(linkId, changeOrderId, projectId);
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    setLinkId("");
    setLinking(false);
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
        {linking ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Pick the line this change order is already billed on. Linking
              moves no money - it records which CO the line came from.{" "}
              {linkable.length} SOV line{linkable.length === 1 ? "" : "s"} on
              this project are linked to no change order.
            </p>
            <div className="flex flex-wrap gap-2">
              <select
                value={linkId}
                onChange={(e) => setLinkId(e.target.value)}
                className="h-9 min-w-[22rem] flex-1 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="">- Select an unlinked SOV line -</option>
                {linkable.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.itemNumber} - {l.description} ({formatCurrency(l.scheduledValue)})
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={onLink} disabled={busy}>
                {busy ? "Linking..." : "Link"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setLinking(false);
                  setErr(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : !adding ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {lines.length === 0
                ? "No SOV lines yet for this CO. Link the line it already bills on, or add a new one."
                : "Add another sub-line if the CO covers multiple components."}
            </p>
            <div className="flex gap-2">
              {/* Link first, and deliberately the primary of the two. Adding a
                  second line for scope the sheet already carries is what put
                  Sweet Springs' SOV over its own contract. */}
              {linkable.length > 0 && (
                <Button size="sm" onClick={() => setLinking(true)}>
                  Link existing SOV line
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                Add SOV line
              </Button>
            </div>
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
