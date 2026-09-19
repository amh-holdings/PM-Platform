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
   * EVERY SOV line on the project, each saying which change order holds it.
   *
   * The unlinked ones are selectable. The rest are shown greyed with the CO
   * that has them, because a line missing from a picker has two very different
   * explanations - it does not exist, or somebody already linked it - and an
   * absence cannot tell you which.
   */
  linkable: (LineRow & { linkedTo: string | null })[];
  /** Prefills for Add SOV line, computed from the whole project's SOV. */
  suggestedItemNumber: string;
  suggestedDescription: string;
};

export function CoLineEditor({
  projectId,
  changeOrderId,
  coValue,
  lines,
  linesTotal,
  drift,
  linkable,
  suggestedItemNumber,
  suggestedDescription,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [itemNumber, setItemNumber] = useState(suggestedItemNumber);
  // Untouched means "whatever the server decides". The suggestion is rendered
  // from a snapshot of the SOV and another tab can move it, so an unedited
  // field is sent blank and settled server side rather than posted stale.
  const [itemTouched, setItemTouched] = useState(false);
  const [description, setDescription] = useState(suggestedDescription);
  const [scheduledValue, setScheduledValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkId, setLinkId] = useState("");
  const [busy, setBusy] = useState(false);
  const freeLines = linkable.filter((l) => l.linkedTo == null);
  const takenLines = linkable.filter((l) => l.linkedTo != null);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function onAdd() {
    setErr(null);
    if (!description.trim()) {
      setErr("Description is required");
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
      itemNumber: itemTouched ? itemNumber.trim() : "",
      description: description.trim(),
      scheduledValue: val,
    });
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    // Deliberately not reset to the old suggestion - it has just been used.
    // The next render supplies the new one through props.
    setItemTouched(false);
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
              moves no money - it records which CO the line came from.
            </p>
            <p className="text-[10px] text-muted-foreground">
              {linkable.length} SOV line{linkable.length === 1 ? "" : "s"} on
              this project &middot; {freeLines.length} free to link &middot;{" "}
              {linkable.length - freeLines.length} already on a change order.
              The taken ones are listed below, greyed, so you can see where they
              went.
            </p>
            <div className="flex flex-wrap gap-2">
              <select
                value={linkId}
                onChange={(e) => setLinkId(e.target.value)}
                className="h-9 min-w-[22rem] flex-1 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="">- Select an unlinked SOV line -</option>
                {freeLines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.itemNumber} - {l.description} ({formatCurrency(l.scheduledValue)})
                  </option>
                ))}
                {takenLines.length > 0 && (
                  <optgroup label="Already linked - detach there first">
                    {takenLines.map((l) => (
                      <option key={l.id} value={l.id} disabled>
                        {l.itemNumber} - {l.description} ({formatCurrency(l.scheduledValue)}) &rarr; {l.linkedTo}
                      </option>
                    ))}
                  </optgroup>
                )}
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
                <Button
                  size="sm"
                  onClick={() => setLinking(true)}
                  disabled={freeLines.length === 0}
                  title={
                    freeLines.length === 0
                      ? "Every SOV line on this project is already on a change order"
                      : undefined
                  }
                >
                  Link existing SOV line
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  // Read the suggestions now, not at mount: the SOV grows
                  // under this component and useState seeds only once.
                  setItemNumber(suggestedItemNumber);
                  setDescription(suggestedDescription);
                  setItemTouched(false);
                  setErr(null);
                  setAdding(true);
                }}
              >
                Add SOV line
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-[120px_1fr_140px_auto]">
              <Input
                value={itemNumber}
                onChange={(e) => {
                  setItemTouched(true);
                  setItemNumber(e.target.value);
                }}
                placeholder={suggestedItemNumber}
                aria-label="SOV item number"
              />
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Equipment storage"
                aria-label="SOV line description"
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
            <p className="text-[10px] text-muted-foreground">
              Item number and description are filled in from this change order
              and the next free number on the SOV. Edit either before adding.
              {!itemTouched &&
                " Leave the number as it is and it is settled when you click Add, so a line added in another tab cannot take it first."}
            </p>
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
