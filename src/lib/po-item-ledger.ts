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

// ---------------------------------------------------------------------------
// What the whole PO has already put on applications
// ---------------------------------------------------------------------------
//
// Phil: "build the unbilled share fix". The standing rule bills half a PO the
// day it goes out, typed against the PO rather than any item. Ticking items
// later priced them at full value, so a half-billed PO's items came out at
// 150%. The fix is to know what the PO has already billed, and which part of
// that was PO-wide rather than for particular items.

export type PoContributionRow = {
  entryId: string;
  amount: number;
  periodMonth: string;
  billed: boolean;
};

export type PoBillingPosition = {
  /** On submitted applications. */
  billedToDate: number;
  /** Staged for another period and not billed yet. */
  stagedElsewhere: number;
  /** The part of both that named no items - spread across every item. */
  poWide: number;
  /** PO total less everything above. Never negative. */
  remaining: number;
  /** poWide as a share of the PO: how much of each item is already covered. */
  billedFraction: number;
};

/**
 * This PO's position, leaving out what it has staged for the period being
 * billed - that figure is about to be replaced by the save, so counting it
 * would net the PO against itself.
 *
 * An entry that carries item rows billed those items, and they are locked by
 * the ledger, so only entries with no items count towards the PO-wide share.
 */
export function poBillingPosition(opts: {
  poTotal: number;
  contributions: readonly PoContributionRow[];
  itemEntryIds: readonly string[];
  periodMonth: string;
}): PoBillingPosition {
  const withItems = new Set(opts.itemEntryIds);
  let billed = 0;
  let staged = 0;
  let poWide = 0;
  for (const c of opts.contributions) {
    const amount = Number(c.amount) || 0;
    if (amount <= 0) continue;
    if (!c.billed && c.periodMonth === opts.periodMonth) continue;
    if (c.billed) billed += amount;
    else staged += amount;
    if (!withItems.has(c.entryId)) poWide += amount;
  }
  const total = Math.max(0, Number(opts.poTotal) || 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    billedToDate: r2(billed),
    stagedElsewhere: r2(staged),
    poWide: r2(poWide),
    remaining: r2(Math.max(0, total - billed - staged)),
    billedFraction: total > 0 ? Math.min(1, poWide / total) : 0,
  };
}
