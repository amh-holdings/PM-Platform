// Report-level review state for a Field Report (a `dprs` row plus its work
// pins). Pure and dependency-free so both the server actions and the Review
// Board / detail UI derive the exact same state and finalize rules.
//
// The workflow (chosen 2026-07-07): the Construction Manager reviews each work
// pin (submitted -> under_review -> approved/rejected), THEN finalizes the whole
// report. Approve is only allowed once every sub work pin is approved; if any
// pin is rejected the report is Returned to the sub, who fixes the flagged pins
// and resubmits the same report.
//
// Only the subcontractor's own work pins (origin='sub') gate finalize. The CM's
// own-check pins (origin='cm') are independent records that are never "decided",
// so they must not be counted here.

import type { InspectionStatus } from "./inspection-status";

export type ReportReviewState =
  | "needs_review" // report submitted; no sub pin reviewed yet (all submitted)
  | "in_review" // some sub pins decided/under review, but not all decided
  | "ready_to_finalize" // every sub pin decided; awaiting the CM's finalize
  | "approved" // report finalized (dprs.status = 'approved')
  | "returned"; // report returned to the sub (dprs.status = 'returned')

export const REPORT_STATE_LABEL: Record<ReportReviewState, string> = {
  needs_review: "Needs review",
  in_review: "In review",
  ready_to_finalize: "Ready to finalize",
  approved: "Approved",
  returned: "Returned",
};

// Board column tone, aligned with the QA/QC pin palette in inspection-status.
export const REPORT_STATE_TONE: Record<ReportReviewState, string> = {
  needs_review: "bg-amber-100 text-amber-900 border-amber-200",
  in_review: "bg-blue-100 text-blue-900 border-blue-200",
  ready_to_finalize: "bg-violet-100 text-violet-900 border-violet-200",
  approved: "bg-emerald-100 text-emerald-900 border-emerald-200",
  returned: "bg-red-100 text-red-900 border-red-200",
};

const DECIDED: InspectionStatus[] = ["approved", "rejected"];

function isDecided(s: InspectionStatus): boolean {
  return DECIDED.includes(s);
}

export type FinalizeGate = {
  state: ReportReviewState;
  totalSubPins: number;
  decidedSubPins: number;
  approvedSubPins: number;
  rejectedSubPins: number;
  allDecided: boolean;
  // Approve the whole report: report still open AND every sub pin approved.
  canApprove: boolean;
  // Return the report to the sub: report still open, every sub pin decided,
  // and at least one was rejected.
  canReturn: boolean;
};

// Derive the finalize gate from the report's stored status and the statuses of
// its subcontractor work pins (origin='sub' only - filter before calling).
export function finalizeGate(
  dprStatus: string | null | undefined,
  subPinStatuses: InspectionStatus[],
): FinalizeGate {
  const total = subPinStatuses.length;
  const approved = subPinStatuses.filter((s) => s === "approved").length;
  const rejected = subPinStatuses.filter((s) => s === "rejected").length;
  const decided = subPinStatuses.filter(isDecided).length;
  const allDecided = total > 0 && decided === total;

  const isOpen = dprStatus !== "approved" && dprStatus !== "returned";

  let state: ReportReviewState;
  if (dprStatus === "approved") state = "approved";
  else if (dprStatus === "returned") state = "returned";
  else if (allDecided) state = "ready_to_finalize";
  else if (decided === 0 && subPinStatuses.every((s) => s === "submitted"))
    state = "needs_review";
  else state = "in_review";

  return {
    state,
    totalSubPins: total,
    decidedSubPins: decided,
    approvedSubPins: approved,
    rejectedSubPins: rejected,
    allDecided,
    canApprove: isOpen && total > 0 && approved === total,
    canReturn: isOpen && allDecided && rejected > 0,
  };
}
