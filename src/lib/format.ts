// Small formatting helpers used across project views.

// Cents, always, everywhere.
//
// Whole dollars read cleanly on a dashboard and wrongly everywhere else. These
// numbers are copied onto Exhibit H, onto a G702, and into the owner's own
// records, and a contract price that rounds to the dollar does not tie to the
// contract. Rounding also hid where it came from: $102,352 could be any of a
// hundred cents, so a one-cent disagreement between the SOV total and the CO
// value looked like agreement.
//
// minimum and maximum both 2, so $3,787,186 renders $3,787,186.00 and columns
// line up on the decimal instead of ragging.
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return currencyFormatter.format(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  // Date-only columns come back as YYYY-MM-DD. Render without timezone shifting.
  const [year, month, day] = value.split("T")[0].split("-").map(Number);
  if (!year || !month || !day) return value;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
