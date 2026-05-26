// Shared constants for the Subcontractors section.

export const TRADE_OPTIONS = [
  "Civil",
  "Electrical",
  "Mechanical / Racking",
  "Tracker / Modules",
  "Inverter",
  "Fencing",
  "Earthwork / Site Prep",
  "Commissioning / Testing",
  "Surveying",
  "Trenching / Boring",
  "Engineering / Design",
  "Permitting",
  "Landscaping / Erosion",
  "Hauling / Logistics",
  "Other",
] as const;

export const COI_STATUS_OPTIONS = [
  "pending",
  "received",
  "expiring",
  "expired",
  "waived",
] as const;

export const W9_STATUS_OPTIONS = [
  "pending",
  "received",
  "waived",
] as const;

export type Trade = (typeof TRADE_OPTIONS)[number];
export type CoiStatus = (typeof COI_STATUS_OPTIONS)[number];
export type W9Status = (typeof W9_STATUS_OPTIONS)[number];

export const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900",
  received: "bg-emerald-100 text-emerald-900",
  expiring: "bg-amber-100 text-amber-900",
  expired: "bg-destructive/10 text-destructive",
  waived: "bg-muted text-muted-foreground",
};

export function statusLabel(value: string | null | undefined): string {
  if (!value) return "-";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
