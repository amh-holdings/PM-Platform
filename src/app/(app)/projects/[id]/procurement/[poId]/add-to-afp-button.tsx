"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/format";
import { describeStagingEffect } from "@/lib/afp-po-staging";
import { amountForPoItems, poItemValue } from "@/lib/billing-progress";
import { PO_ITEM_STATUS_TONE, poItemStatus } from "@/lib/po-item-status";
import {
  canBillItem,
  type ItemBillingState,
  type PoBillingPosition,
} from "@/lib/po-item-ledger";
import { todayIso } from "@/lib/schedule-calendar";

import {
  getPoAfpContext,
  stagePoAmountForAfp,
  type AfpTargetLine,
  type PoLineRow,
} from "../../procurement-actions";

/**
 * What this PO puts on the next pay application, typed rather than derived.
 *
 * The dialog opens on half the PO because that is the standing rule, and shows
 * what the SOV line has already been billed and what is already staged for the
 * period so the number can be set against them. Saving writes an ordinary
 * forecast row, which then behaves like every other row on the Bill this
 * period panel.
 *
 * Where the PO has a line-item table, the items are listed with a box each.
 * Ticking the ones that arrived fills the amount with their value plus their
 * share of tax and freight, for a PO that is only partly delivered. The box
 * stays editable afterwards; the ticks are a way to arrive at the number.
 *
 * The ticks are remembered (migration 0079). An item already on an AFP, or
 * staged for another period, is greyed out with where it went. Items this PO
 * already staged for the period open ticked, so saving again adds to them
 * rather than quietly replacing them.
 *
 * Ticked items are priced net of what the PO already billed PO-wide. A PO
 * that went out at the standing half has half of every item billed, so only
 * the other half is offered, and nothing ticked can take the PO past 100%.
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
  const [suggested, setSuggested] = useState(0);
  const [items, setItems] = useState<PoLineRow[]>([]);
  const [salesTax, setSalesTax] = useState<number | null>(null);
  const [freight, setFreight] = useState<number | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [itemBilling, setItemBilling] = useState<Record<string, ItemBillingState>>({});
  const [position, setPosition] = useState<PoBillingPosition | null>(null);

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
    setSuggested(res.suggestedAmount);
    setAmount(res.suggestedAmount > 0 ? res.suggestedAmount.toFixed(2) : "");
    setItems(res.items);
    setSalesTax(res.salesTax);
    setFreight(res.freight);
    setItemBilling(res.itemBilling);
    setPosition(res.poPosition);
    // What this PO already put on this period opens ticked, priced from the
    // ticks, so the dialog shows the figure saving would keep.
    const staged = res.items
      .filter((i) => res.itemBilling[i.id]?.kind === "staged_here")
      .map((i) => i.id);
    setPicked(staged);
    if (staged.length) {
      const total = amountForPoItems({
        items: res.items,
        selectedIds: staged,
        salesTax: res.salesTax,
        freight: res.freight,
        billedFraction: res.poPosition.billedFraction,
        cap: res.poPosition.remaining,
      }).total;
      setAmount(total > 0 ? total.toFixed(2) : "");
    }
  }

  // Every item price in the dialog goes through here, so the list, the
  // breakdown and the amount box can never disagree about the net figure.
  const priceItems = (ids: readonly string[]) =>
    amountForPoItems({
      items,
      selectedIds: ids,
      salesTax,
      freight,
      billedFraction: position?.billedFraction ?? 0,
      cap: position?.remaining ?? null,
    });
  const itemAmount = priceItems(picked);
  const priorOnPo = position
    ? Math.round((position.billedToDate + position.stagedElsewhere) * 100) / 100
    : 0;

  const today = todayIso();
  const billable = (id: string) => {
    const state = itemBilling[id];
    return !state || canBillItem(state);
  };
  const billableIds = items.filter((i) => billable(i.id)).map((i) => i.id);
  const deliveredIds = items
    .filter(
      (i) =>
        billable(i.id) &&
        poItemStatus(i.deliveryTask, today).kind === "delivered",
    )
    .map((i) => i.id);

  function pick(next: string[]) {
    setPicked(next);
    // Nothing ticked goes back to the standing half-the-PO figure, so
    // unticking the last item does not leave a stale partial amount behind.
    const total = priceItems(next).total;
    const value = next.length > 0 ? total : suggested;
    setAmount(value > 0 ? value.toFixed(2) : "");
  }

  function togglePicked(id: string) {
    pick(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);
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
      itemIds: items.length > 0 ? picked : undefined,
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
                  {priorOnPo > 0 && position && (
                    <>
                      <div className="mt-1 flex justify-between">
                        <span className="text-muted-foreground">
                          Already on other AFPs
                          {position.stagedElsewhere > 0 ? " or staged" : ""}
                        </span>
                        <span className="font-mono">
                          {formatCurrency(priorOnPo)}
                          {poTotalValue > 0
                            ? ` (${Math.round((priorOnPo / poTotalValue) * 100)}%)`
                            : ""}
                        </span>
                      </div>
                      <div className="mt-1 flex justify-between">
                        <span className="text-muted-foreground">Left on this PO</span>
                        <span className="font-mono">
                          {formatCurrency(position.remaining)}
                        </span>
                      </div>
                    </>
                  )}
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

                {items.length > 0 && (
                  <div>
                    <div className="flex items-baseline justify-between">
                      <Label className="text-xs">Items delivered</Label>
                      <span className="flex gap-3">
                        {/* What the schedule says has arrived, in one click.
                            Delivered means its row is Complete. */}
                        {deliveredIds.length > 0 && (
                          <button
                            type="button"
                            className="text-[11px] text-muted-foreground underline"
                            onClick={() => pick(deliveredIds)}
                          >
                            Tick delivered ({deliveredIds.length})
                          </button>
                        )}
                        <button
                          type="button"
                          className="text-[11px] text-muted-foreground underline"
                          onClick={() =>
                            pick(
                              picked.length === billableIds.length
                                ? []
                                : billableIds,
                            )
                          }
                        >
                          {picked.length === billableIds.length && picked.length > 0
                            ? "Clear"
                            : "Tick all"}
                        </button>
                      </span>
                    </div>
                    <div className="mt-1 divide-y rounded-md border text-xs">
                      {items.map((item) => {
                        const billing = itemBilling[item.id];
                        const locked = !billable(item.id);
                        return (
                        <label
                          key={item.id}
                          className={
                            locked
                              ? "flex items-start gap-2 p-2 opacity-60"
                              : "flex cursor-pointer items-start gap-2 p-2 hover:bg-muted/30"
                          }
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={picked.includes(item.id)}
                            disabled={locked}
                            onChange={() => togglePicked(item.id)}
                          />
                          <span className="flex-1">
                            {item.lineNo != null ? `Line ${item.lineNo} ` : ""}
                            {item.description ?? "Unnamed item"}
                            {(() => {
                              const status = poItemStatus(item.deliveryTask, today);
                              return (
                                <span
                                  className={`ml-1.5 inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ${PO_ITEM_STATUS_TONE[status.kind]}`}
                                >
                                  {status.label}
                                </span>
                              );
                            })()}
                            {billing && billing.kind !== "open" && (
                              <span
                                className={`ml-1.5 inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                  billing.kind === "staged_here"
                                    ? "bg-blue-100 text-blue-900"
                                    : "bg-muted text-muted-foreground"
                                }`}
                              >
                                {billing.label}
                              </span>
                            )}
                          </span>
                          <span className="text-right font-mono">
                            {(() => {
                              // An item partly covered by earlier PO-wide
                              // billing shows what is left on it, with its
                              // full price beneath.
                              const full = poItemValue(item);
                              const net = priceItems([item.id]).total;
                              if (locked || Math.abs(full - net) < 0.005) {
                                return formatCurrency(full);
                              }
                              return (
                                <>
                                  {formatCurrency(net)}
                                  <span className="block text-[10px] text-muted-foreground">
                                    of {formatCurrency(full)}
                                  </span>
                                </>
                              );
                            })()}
                          </span>
                        </label>
                        );
                      })}
                    </div>
                    {picked.length > 0 && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {formatCurrency(itemAmount.items)} in items
                        {itemAmount.taxAndFreight > 0
                          ? ` plus ${formatCurrency(itemAmount.taxAndFreight)} share of tax and freight`
                          : ""}
                        {itemAmount.alreadyBilled > 0
                          ? `, less ${formatCurrency(itemAmount.alreadyBilled)} already billed on earlier AFPs`
                          : ""}
                        {" "}= {formatCurrency(itemAmount.total)}
                      </p>
                    )}
                  </div>
                )}

                <div>
                  <Label htmlFor="afp-amount" className="text-xs">
                    Amount to bill
                  </Label>
                  <MoneyInput
                    id="afp-amount"
                    value={amount}
                    onTextChange={setAmount}
                    className="mt-1 font-mono"
                  />
                  {position &&
                    priorOnPo > 0 &&
                    Number.isFinite(typed) &&
                    typed > position.remaining + 0.005 && (
                      <p className="mt-1 text-[11px] text-amber-700">
                        That is more than the {formatCurrency(position.remaining)} left
                        on {poNumber ?? "this PO"} after earlier AFPs.
                      </p>
                    )}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {picked.length > 0
                      ? "Filled from the ticked items. Saving replaces this PO's figure and item list for the period with what is ticked here."
                      : items.length > 0
                        ? "Opens on half the PO. Tick the items that arrived to bill only those, or type the figure."
                        : "Opens on half the PO. Change it to whatever the owner is actually billed this period."}
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
