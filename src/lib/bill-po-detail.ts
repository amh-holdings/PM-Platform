/**
 * What a procurement line on the Bill this period panel is made of: the POs
 * behind the figure, and under each PO the items that were ticked on Add to AFP.
 *
 * Phil: "you need to show as a sub information what PO's and what equipments
 * are added here through the procurement page". The panel printed
 * "PO-017 $23,982.50 + PO-021 $9,861.46 + PO-019 $8,268.63" and stopped, so
 * the one question an owner asks about a procurement line - what equipment is
 * this - meant opening three PO pages.
 *
 * Nothing here is entered on the Billing page. The per-PO figures come from
 * billing_entry_po_amounts (0059) and the ticks from billing_entry_po_items
 * (0079), both written by Add to AFP.
 */

import { poItemValue } from "./billing-progress";

export type BillPoItemInput = {
  id: string;
  description: string | null;
  quantity: number | null;
  units: string | null;
  unitPrice: number | null;
  extendedPrice: number | null;
  deliveredOn: string | null;
};

export type BillPoItem = {
  id: string;
  description: string;
  quantity: number | null;
  units: string | null;
  /** The item's value on the PO. */
  value: number;
  /**
   * This period's figure for the PO, split across the ticked items by value.
   * Add to AFP prices ticked items the same way (amountForPoItems: value plus
   * a by-value share of tax and freight, less the fraction already billed), so
   * the split lands back on what each item was priced at. A hand-typed figure
   * splits the same way, and the shares always add up to the PO's figure.
   */
  share: number;
  deliveredOn: string | null;
};

export type BillPoDetail = {
  poId: string;
  label: string;
  vendor: string | null;
  poTotal: number | null;
  amount: number;
  /** False when the PO was added without ticking items - a whole-PO figure. */
  itemsRecorded: boolean;
  items: BillPoItem[];
  /** Items on the PO that were not ticked for this period. */
  otherItemCount: number;
  /** What other entries already on an AFP billed against this PO. */
  billedEarlier: number;
  earlierAfps: string[];
};

export type EarlierPoBilling = {
  poId: string;
  entryId: string;
  amount: number;
  billed: boolean;
  afpNumber: string | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Split an amount across items by value, to the cent. The last item takes the
 * rounding so the shares add up to the amount exactly. Items with no value on
 * the PO split evenly, so a figure is never shown against nothing.
 */
export function splitByValue(amount: number, values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const total = values.reduce((s, v) => s + (v > 0 ? v : 0), 0);
  const weights =
    total > 0 ? values.map((v) => (v > 0 ? v / total : 0)) : values.map(() => 1 / values.length);
  const shares = weights.map((w) => round2(amount * w));
  const drift = round2(amount - shares.reduce((s, v) => s + v, 0));
  shares[shares.length - 1] = round2(shares[shares.length - 1] + drift);
  return shares;
}

export function buildPoBillDetail(input: {
  entryId: string;
  contributions: readonly { poId: string; amount: number }[];
  po: (poId: string) => { label: string; vendor: string | null; total: number | null };
  itemsByPo: ReadonlyMap<string, readonly BillPoItemInput[]>;
  /** Item ids ticked on this entry. */
  tickedIds: ReadonlySet<string>;
  earlier: readonly EarlierPoBilling[];
}): BillPoDetail[] {
  return input.contributions.map((c) => {
    const info = input.po(c.poId);
    const all = input.itemsByPo.get(c.poId) ?? [];
    const ticked = all.filter((i) => input.tickedIds.has(i.id));
    const values = ticked.map((i) =>
      poItemValue({
        id: i.id,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        extendedPrice: i.extendedPrice,
      }),
    );
    const shares = splitByValue(c.amount, values);
    const prior = input.earlier.filter(
      (e) => e.poId === c.poId && e.entryId !== input.entryId && e.billed,
    );
    const afps = Array.from(
      new Set(prior.map((e) => e.afpNumber).filter((n): n is string => !!n)),
    ).sort();
    return {
      poId: c.poId,
      label: info.label,
      vendor: info.vendor,
      poTotal: info.total,
      amount: round2(c.amount),
      itemsRecorded: ticked.length > 0,
      items: ticked.map((i, idx) => ({
        id: i.id,
        description: i.description?.trim() || "Unnamed item",
        quantity: i.quantity,
        units: i.units,
        value: round2(values[idx]),
        share: shares[idx],
        deliveredOn: i.deliveredOn,
      })),
      otherItemCount: all.length - ticked.length,
      billedEarlier: round2(prior.reduce((s, e) => s + e.amount, 0)),
      earlierAfps: afps,
    };
  });
}
