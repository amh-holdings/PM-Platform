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
// Per the Build Spec, Mark Wooley (role = ahc_super) is the single internal
// gate. Phil is included here as well at his request so he can exercise the
// full approve/reject flow while testing the live app.
//
// To return to the spec's strict single-gate (Mark only): remove "phil" from
// INSPECTION_APPROVER_ROLES. To narrow to a specific person when more than one
// ahc_super exists, set INSPECTION_APPROVER_PROFILE_ID and the id check wins.
export const INSPECTION_APPROVER_ROLES: readonly string[] = ["ahc_super", "phil"];
export const INSPECTION_APPROVER_PROFILE_ID: string | null = null;

export type ApproverContext = { role: string; profileId?: string | null };

export function isInspectionApprover(ctx: ApproverContext): boolean {
  if (INSPECTION_APPROVER_PROFILE_ID) {
    return ctx.profileId === INSPECTION_APPROVER_PROFILE_ID;
  }
  return INSPECTION_APPROVER_ROLES.includes(ctx.role);
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

// ---- Field Report origin (migration 0022) ----
// A pin is either the subcontractor's work-done item ('sub') or the
// Construction Manager's own independent check ('cm'). Legacy inspections
// default to 'sub'.
export const INSPECTION_ORIGINS = ["sub", "cm"] as const;
export type InspectionOrigin = (typeof INSPECTION_ORIGINS)[number];

export function isInspectionOrigin(v: string): v is InspectionOrigin {
  return (INSPECTION_ORIGINS as readonly string[]).includes(v);
}

// ---- Photo side convention (inspection_photos.side) ----
// 'sub' = authored by the subcontractor (their submission photos).
// 'ahc' = authored internally by the CM/AHC team - both the verification
// photos attached to a sub's pin AND the photos on a CM own-check ('cm' origin)
// pin. So `side` always means "who took it", independent of `origin`.
export const PHOTO_SIDE_SUB = "sub" as const;
export const PHOTO_SIDE_CM = "ahc" as const;
