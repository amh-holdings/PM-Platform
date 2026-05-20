// Small formatting helpers used across project views.

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
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
