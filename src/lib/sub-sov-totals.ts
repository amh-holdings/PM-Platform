// Base contract against change orders, on a subcontractor's SOV.
//
// sub_sov_lines has carried is_change_order and change_order_ref since 0038,
// and the Add a line form has always offered both. What nothing did was tell
// the two apart when the SOV was totalled, so the first change order line
// added to a sub tripped the reconciliation warning: the SOV now exceeded the
// executed contract value, which is exactly what a change order is supposed
// to do.
//
// Zarina: "Can we also add a change order line to their SOV?"
//
// The base lines are what ties to the executed contract. Change orders are
// additions to it, and the revised total is what every percentage on the page
// is priced against.

export type SovTotalLine = {
  scheduled_value?: number | null;
  is_change_order?: boolean | null;
};

export type SovTotals = {
  /** Lines that are not change orders. This is what the contract value checks against. */
  base: number;
  /** Change order lines, which raise the contract rather than breaking it. */
  changeOrders: number;
  /** Base plus change orders - the number percentages are priced off. */
  revised: number;
  /** How many change order lines there are, for the label. */
  changeOrderCount: number;
  /**
   * Base less the executed contract value. Null when no contract value is on
   * record, because "the SOV is 798,067 over a contract of nothing" is not a
   * finding, it is a missing field.
   */
  variance: number | null;
};

const money = (n: number) => Math.round(n * 100) / 100;

export function sovTotals(
  lines: readonly SovTotalLine[],
  contractValue: number,
): SovTotals {
  let base = 0;
  let changeOrders = 0;
  let changeOrderCount = 0;
  for (const l of lines) {
    const v = Number(l.scheduled_value ?? 0);
    if (l.is_change_order) {
      changeOrders += v;
      changeOrderCount++;
    } else {
      base += v;
    }
  }
  base = money(base);
  changeOrders = money(changeOrders);
  return {
    base,
    changeOrders,
    revised: money(base + changeOrders),
    changeOrderCount,
    variance: contractValue > 0 ? money(base - contractValue) : null,
  };
}
