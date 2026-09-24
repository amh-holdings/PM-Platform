"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/format";
import { describeStagingEffect } from "@/lib/afp-po-staging";

import {
  getPoAfpContext,
  stagePoAmountForAfp,
  type AfpTargetLine,
} from "../../procurement-actions";

/**
 * What this PO puts on the next pay application, typed rather than derived.
 *
 * The dialog opens on half the PO because that is the standing rule, and shows
 * what the SOV line has already been billed and what is already staged for the
 * period so the number can be set against them. Saving writes an ordinary
 * forecast row, which then behaves like every other row on the Bill this
 * period panel.
 */
export function AddToAfpButton({
  poId,
  projectId,
  poTotalValue,
  size = "sm",
  variant,
}: {
  poId: string;
  projectId: string;
  poTotalValue: number;
  /** The header copy is small; the one in the page body is not. */
  size?: "sm" | "default";
  variant?: "outline";
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [periodMonth, setPeriodMonth] = useState<string>("");
  const [lines, setLines] = useState<AfpTargetLine[]>([]);
  const [lineId, setLineId] = useState("");
  const [amount, setAmount] = useState("");
  const [poNumber, setPoNumber] = useState<string | null>(null);

  async function openDialog() {
    setOpen(true);
    setLoading(true);
    setError(null);
    setDone(null);
    const res = await getPoAfpContext(poId, projectId);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPeriodMonth(res.periodMonth);
    setPoNumber(res.poNumber);
    setLines(res.lines);
    setLineId(res.defaultBillingLineId ?? "");
    setAmount(res.suggestedAmount > 0 ? res.suggestedAmount.toFixed(2) : "");
  }

  const selected = lines.find((l) => l.id === lineId) ?? null;
  const typed = Number(amount.replace(/[$,\s]/g, ""));
  // Replacing this PO's own figure, or adding alongside another PO's. The
  // difference decides what the line totals, so it is said before the save.
  const stagingEffect = selected
    ? describeStagingEffect({
        stagedThisPeriod: selected.stagedThisPeriod,
        stagedByThisPo: selected.stagedByThisPo,
        incomingAmount: Number.isFinite(typed) ? typed : 0,
        poLabel: poNumber ?? "This PO",
        formatAmount: formatCurrency,
      })
    : null;

  async function save() {
    setSaving(true);
    setError(null);
    const res = await stagePoAmountForAfp(poId, projectId, {
      billingLineId: lineId,
      amount: typed,
      periodMonth: periodMonth || undefined,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDone(
      `${formatCurrency(res.amount)} staged for ${monthLabel(res.periodMonth)}. It is on the Bill this period panel now.`,
    );
    startTransition(() => router.refresh());
  }

  return (
    <>
      <Button size={size} variant={variant} onClick={openDialog}>
        Add to AFP
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Add to AFP</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  What the owner is billed for this PO. It does not have to
                  match what we pay the vendor.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>

            {loading && (
              <p className="mt-6 text-sm text-muted-foreground">Loading...</p>
            )}

            {!loading && !done && lines.length > 0 && (
              <div className="mt-5 space-y-4">
                <div className="rounded-md border bg-muted/30 p-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">PO value</span>
                    <span className="font-mono">
                      {formatCurrency(poTotalValue)}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span className="text-muted-foreground">Billing period</span>
                    <span>{monthLabel(periodMonth)}</span>
                  </div>
                </div>

                <div>
                  <Label htmlFor="afp-line" className="text-xs">
                    SOV line it bills against
                  </Label>
                  <select
                    id="afp-line"
                    value={lineId}
                    onChange={(e) => setLineId(e.target.value)}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="">Pick a line</option>
                    {lines.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.itemNumber} {l.description}
                        {l.allocated != null
                          ? ` (PO allocated ${formatCurrency(l.allocated)})`
                          : ""}
                      </option>
                    ))}
                  </select>
                </div>

                {selected && (
                  <div className="rounded-md border bg-card p-3 text-xs">
                    <Row
                      label="Scheduled value"
                      value={formatCurrency(selected.scheduledValue)}
                    />
                    <Row
                      label="Billed on prior AFPs"
                      value={formatCurrency(selected.alreadyBilled)}
                    />
                    <Row
                      label={`Already staged for ${monthLabel(periodMonth)}`}
                      value={formatCurrency(selected.stagedThisPeriod)}
                      warn={selected.stagedThisPeriod > 0}
                    />
                    {selected.stagedByThisPo != null &&
                      selected.stagedByThisPo > 0 && (
                        <Row
                          label={`Of that, from ${poNumber ?? "this PO"}`}
                          value={formatCurrency(selected.stagedByThisPo)}
                        />
                      )}
                    {stagingEffect && (
                      <p className="mt-2 text-amber-700">{stagingEffect}</p>
                    )}
                  </div>
                )}

                <div>
                  <Label htmlFor="afp-amount" className="text-xs">
                    Amount to bill
                  </Label>
                  <Input
                    id="afp-amount"
                    value={amount}
                    inputMode="decimal"
                    onChange={(e) => setAmount(e.target.value)}
                    className="mt-1 font-mono"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Opens on half the PO. Change it to whatever the owner is
                    actually billed this period.
                  </p>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={save}
                    disabled={saving || !lineId || !(typed > 0)}
                  >
                    {saving ? "Adding..." : "Add to AFP"}
                  </Button>
                </div>
              </div>
            )}

            {!loading && !done && lines.length === 0 && !error && (
              <p className="mt-6 text-sm text-muted-foreground">
                This project has no SOV lines to bill against yet.
              </p>
            )}

            {done && (
              <div className="mt-5 space-y-4">
                <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
                  {done}
                </p>
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => setOpen(false)}>
                    Done
                  </Button>
                </div>
              </div>
            )}

            {error && (
              <p className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-700">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Row({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={warn ? "font-mono text-amber-700" : "font-mono"}>
        {value}
      </span>
    </div>
  );
}

function monthLabel(iso: string): string {
  if (!iso) return "the open period";
  const [y, m] = iso.split("-");
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const name = names[Number(m) - 1];
  return name ? `${name} ${y}` : iso;
}
