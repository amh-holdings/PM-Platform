// QA/QC Inspection state machine. Pure, dependency-free, so it can be unit
// tested and reused by both the server actions and the UI (color coding).
//
// Flow (Build Spec, approved 2026-06-29):
//   submitted     - sub submitted daily; awaiting AHC
//   under_review  - AHC opened the map, attaching verification photos/notes
//   approved      - Mark Wooley approved; record is LOCKED (terminal)
//   rejected      - Mark Wooley rejected with a reason; returns to the sub
//   rejected -> submitted on resubmission. approved is terminal.

export const INSPECTION_STATUSES = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
] as const;

export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

// Allowed transitions. Anything not listed is rejected.
const TRANSITIONS: Record<InspectionStatus, InspectionStatus[]> = {
  submitted: ["under_review"],
  under_review: ["approved", "rejected"],
  rejected: ["submitted"], // resubmission
  approved: [], // locked, terminal
};

export function canTransition(
  from: InspectionStatus,
  to: InspectionStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatuses(from: InspectionStatus): InspectionStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function isTerminal(status: InspectionStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

// A locked record cannot be edited (approved only).
export function isLocked(status: InspectionStatus): boolean {
  return status === "approved";
}

// ---- Approver gate ----
// Mark Wooley is the single internal gate. He is the AHC field super
// (role = ahc_super). Phil is digest-only and intentionally cannot decide,
// even though phil/zarina can run the review and attach verification.
//
// If more than one ahc_super ever exists, narrow this to Mark's profile id by
// setting INSPECTION_APPROVER_PROFILE_ID and switching isInspectionApprover to
// compare ids. Kept as a role check for now so the mock seeds cleanly.
export const INSPECTION_APPROVER_ROLE = "ahc_super" as const;
export const INSPECTION_APPROVER_PROFILE_ID: string | null = null;

export type ApproverContext = { role: string; profileId?: string | null };

export function isInspectionApprover(ctx: ApproverContext): boolean {
  if (INSPECTION_APPROVER_PROFILE_ID) {
    return ctx.profileId === INSPECTION_APPROVER_PROFILE_ID;
  }
  return ctx.role === INSPECTION_APPROVER_ROLE;
}

// Roles allowed to run the AHC-side review (open map, attach verification).
// Distinct from the decision gate above.
const AHC_TEAM = ["phil", "zarina", "ahc_super"];
export function canReview(role: string): boolean {
  return AHC_TEAM.includes(role);
}

// ---- Color-coded QA/QC system (Component Library) ----
// Used by both the map pins and the list chips so color is consistent.
export type StatusStyle = { label: string; pin: string; chip: string };

export const STATUS_STYLE: Record<InspectionStatus, StatusStyle> = {
  submitted: {
    label: "Submitted",
    pin: "#f59e0b", // amber - awaiting AHC
    chip: "bg-amber-100 text-amber-800 border-amber-200",
  },
  under_review: {
    label: "Under Review",
    pin: "#3b82f6", // blue - AHC verifying
    chip: "bg-blue-100 text-blue-800 border-blue-200",
  },
  approved: {
    label: "Approved",
    pin: "#16a34a", // green - locked
    chip: "bg-green-100 text-green-800 border-green-200",
  },
  rejected: {
    label: "Rejected",
    pin: "#dc2626", // red - returned to sub
    chip: "bg-red-100 text-red-800 border-red-200",
  },
};

export function statusLabel(status: InspectionStatus): string {
  return STATUS_STYLE[status].label;
}
