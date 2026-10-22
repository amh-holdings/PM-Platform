// Which items on a PO have already been put on a pay application.
//
// Phil: "build the billed-items ledger so items aren't double billed". Add to
// AFP bills part of a PO by ticking items (#149); billing_entry_po_items
// (migration 0079) records the ticks against the billing entry they landed on.
// Whether that entry has gone out is read off the entry itself - its AFP
// number, pay application or billed status - the same test every other part
// of billing uses, so the ledger cannot disagree with the Billing page.

export type ItemLedgerRow = {
  itemId: string;
  periodMonth: string;
  /** The entry is on an application: afp number, pay app, or billed status. */
  billed: boolean;
  afpNumber: string | null;
};

export type ItemBillingState =
  | { kind: "open" }
  | { kind: "billed"; label: string }
  | { kind: "staged_here"; label: string }
  | { kind: "staged_elsewhere"; label: string };

function monthLabel(iso: string): string {
  const [y, m] = iso.split("-");
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const name = names[Number(m) - 1];
  return name ? `${name} ${y}` : iso;
}

/**
 * Where one item stands against the period being billed.
 *
 * Billed beats everything: an item on a submitted application is done, even
 * if a later forecast also names it. Staged for this period is the PO's own
 * current figure - re-saving replaces it, so the item stays tickable and the
 * dialog opens with it ticked. Staged for another period and never billed is
 * blocked too: billing it here would put it on two entries at once, and the
 * fix is to undo the stale one, not to bill around it.
 */
export function itemBillingState(
  rows: readonly ItemLedgerRow[],
  periodMonth: string,
): ItemBillingState {
  const billed = rows.find((r) => r.billed);
  if (billed) {
    return {
      kind: "billed",
      label: billed.afpNumber
        ? `Billed on AFP ${billed.afpNumber}`
        : `Billed ${monthLabel(billed.periodMonth)}`,
    };
  }
  if (rows.some((r) => r.periodMonth === periodMonth)) {
    return { kind: "staged_here", label: `Staged for ${monthLabel(periodMonth)}` };
  }
  const other = rows[0];
  if (other) {
    return {
      kind: "staged_elsewhere",
      label: `Staged for ${monthLabel(other.periodMonth)}, not on an AFP yet`,
    };
  }
  return { kind: "open" };
}

/** Can this item be ticked for the period. */
export function canBillItem(state: ItemBillingState): boolean {
  return state.kind === "open" || state.kind === "staged_here";
}

/** Group ledger rows by item and resolve each one. */
export function itemBillingStates(
  rows: readonly ItemLedgerRow[],
  periodMonth: string,
): Record<string, ItemBillingState> {
  const byItem = new Map<string, ItemLedgerRow[]>();
  for (const r of rows) {
    const list = byItem.get(r.itemId) ?? [];
    list.push(r);
    byItem.set(r.itemId, list);
  }
  const out: Record<string, ItemBillingState> = {};
  byItem.forEach((list, id) => {
    out[id] = itemBillingState(list, periodMonth);
  });
  return out;
}

/**
 * The server's last check before writing: every ticked item that is not
 * allowed, with why. Empty means the save can go ahead.
 */
export function blockedItems(
  selectedIds: readonly string[],
  states: Record<string, ItemBillingState>,
): { itemId: string; label: string }[] {
  const out: { itemId: string; label: string }[] = [];
  for (const id of selectedIds) {
    const s = states[id];
    if (s && s.kind !== "open" && !canBillItem(s)) out.push({ itemId: id, label: s.label });
  }
  return out;
}
