// Shared presentation constants for the sub-billing views. These live outside
// the page files because Next.js only allows its own reserved exports from a
// route module.

export const STATUS_TONE: Record<string, string> = {
  received: "bg-amber-100 text-amber-900",
  under_review: "bg-amber-100 text-amber-900",
  cm_recommended: "bg-blue-100 text-blue-900",
  approved: "bg-emerald-100 text-emerald-900",
  rejected: "bg-red-100 text-red-900",
  paid: "bg-slate-200 text-slate-900",
};

export const STATUS_LABEL: Record<string, string> = {
  received: "Received",
  under_review: "Under review",
  cm_recommended: "CM recommended",
  approved: "Approved",
  rejected: "Rejected",
  paid: "Paid",
};

export const METHOD_LABEL: Record<string, string> = {
  schedule: "Schedule tasks",
  commodity: "Commodity quantities",
  milestone: "Milestone",
  time: "Time-based",
  manual: "CM sign-off",
  unmapped: "Not mapped",
};

export const FLAG_TONE: Record<string, string> = {
  ok: "bg-emerald-100 text-emerald-900",
  review: "bg-amber-100 text-amber-900",
  flag: "bg-red-100 text-red-900",
  unverifiable: "bg-slate-200 text-slate-700",
};

export const FLAG_LABEL: Record<string, string> = {
  ok: "Supported",
  review: "Review",
  flag: "Overbilled",
  unverifiable: "No evidence",
};
