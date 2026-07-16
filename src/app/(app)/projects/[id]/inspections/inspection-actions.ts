"use server";

import { revalidatePath } from "next/cache";

import { randomUUID } from "node:crypto";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TablesUpdate } from "@/lib/database.types";
import { generateInspectionToken, isLinkUsable } from "@/lib/inspection-token";
import { INSPECTION_BUCKET, sanitizeFileName } from "./inspection-constants";
import {
  canReview,
  canTransition,
  isInspectionApprover,
  isLocked,
  type InspectionStatus,
} from "@/lib/inspection-status";

// ============ AUTH HELPERS ============

type Authed = {
  ok: true;
  supabase: ReturnType<typeof createClient>;
  userId: string;
  role: string;
};
type AuthFail = { ok: false; error: string };

async function getProfile(): Promise<Authed | AuthFail> {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return { ok: false, error: "Profile not found" };
  return { ok: true, supabase, userId: user.id, role: profile.role };
}

async function assertReviewer(): Promise<Authed | AuthFail> {
  const auth = await getProfile();
  if (!auth.ok) return auth;
  if (!canReview(auth.role)) {
    return { ok: false, error: "Restricted to AHC team members" };
  }
  return auth;
}

// ============ RESULT TYPES ============

export type InspectionResult =
  | { ok: true; inspectionId: string }
  | { ok: false; error: string };

export type InspectionPhotoInput = {
  storagePath: string;
  caption?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  takenAt?: string | null;
};

export type SubmitInspectionInput = {
  projectId: string;
  subcontractorId: string;
  inspectionType?: string | null;
  title: string;
  notes?: string | null;
  quantity?: number | null;
  unitOfMeasure?: string | null;
  basemapKey?: string;
  pinX?: number | null;
  pinY?: number | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  inspectorName?: string | null;
  photos?: InspectionPhotoInput[];
};

// ============ 1. SUBMIT (sub or AHC, signed-in) ============

export async function submitInspection(
  input: SubmitInspectionInput,
): Promise<InspectionResult> {
  const auth = await getProfile();
  if (!auth.ok) return auth;

  if (!input.title?.trim()) return { ok: false, error: "Title is required" };
  if (!input.subcontractorId)
    return { ok: false, error: "Subcontractor is required" };

  const { data: inspection, error } = await auth.supabase
    .from("inspections")
    .insert({
      project_id: input.projectId,
      subcontractor_id: input.subcontractorId,
      inspection_type: input.inspectionType ?? null,
      title: input.title.trim(),
      notes: input.notes ?? null,
      quantity: input.quantity ?? null,
      unit_of_measure: input.unitOfMeasure ?? null,
      basemap_key: input.basemapKey ?? "C2-01",
      pin_x: input.pinX ?? null,
      pin_y: input.pinY ?? null,
      gps_lat: input.gpsLat ?? null,
      gps_lng: input.gpsLng ?? null,
      inspector_name: input.inspectorName ?? null,
      submitted_by: auth.userId,
      status: "submitted",
      submitted_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !inspection) {
    return { ok: false, error: error?.message ?? "Failed to create inspection" };
  }

  if (input.photos?.length) {
    const rows = input.photos.map((p) => ({
      inspection_id: inspection.id,
      side: "sub" as const,
      storage_path: p.storagePath,
      caption: p.caption ?? null,
      gps_lat: p.gpsLat ?? null,
      gps_lng: p.gpsLng ?? null,
      taken_at: p.takenAt ?? new Date().toISOString(),
      uploaded_by: auth.userId,
    }));
    const { error: photoErr } = await auth.supabase
      .from("inspection_photos")
      .insert(rows);
    if (photoErr) return { ok: false, error: `Photos failed: ${photoErr.message}` };
  }

  revalidatePath(`/projects/${input.projectId}/inspections`);
  return { ok: true, inspectionId: inspection.id };
}

// ============ 2. START REVIEW (AHC) submitted -> under_review ============

export async function startReview(
  inspectionId: string,
  projectId: string,
): Promise<{ ok: true } | AuthFail> {
  const auth = await assertReviewer();
  if (!auth.ok) return auth;

  const guard = await guardTransition(auth, inspectionId, projectId, "under_review");
  if (!guard.ok) return guard;

  const { error } = await auth.supabase
    .from("inspections")
    .update({
      status: "under_review",
      review_started_at: new Date().toISOString(),
      reviewed_by: auth.userId,
    })
    .eq("id", inspectionId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/inspections`);
  revalidatePath(`/projects/${projectId}/inspections/${inspectionId}`);
  return { ok: true };
}

// ============ 3. ATTACH AHC VERIFICATION (AHC) ============
// Adds AHC-side photos/notes at the same locations. Allowed while under_review.

export async function attachAhcVerification(input: {
  inspectionId: string;
  projectId: string;
  ahcNotes?: string | null;
  photos?: InspectionPhotoInput[];
}): Promise<{ ok: true } | AuthFail> {
  const auth = await assertReviewer();
  if (!auth.ok) return auth;

  const { data: insp, error: readErr } = await auth.supabase
    .from("inspections")
    .select("id, project_id, status")
    .eq("id", input.inspectionId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!insp) return { ok: false, error: "Inspection not found" };
  if (insp.project_id !== input.projectId)
    return { ok: false, error: "Inspection does not belong to this project" };
  if (isLocked(insp.status as InspectionStatus))
    return { ok: false, error: "Inspection is approved and locked" };

  if (input.ahcNotes != null) {
    const { error } = await auth.supabase
      .from("inspections")
      .update({ ahc_notes: input.ahcNotes })
      .eq("id", input.inspectionId);
    if (error) return { ok: false, error: error.message };
  }

  if (input.photos?.length) {
    const rows = input.photos.map((p) => ({
      inspection_id: input.inspectionId,
      side: "ahc" as const,
      storage_path: p.storagePath,
      caption: p.caption ?? null,
      gps_lat: p.gpsLat ?? null,
      gps_lng: p.gpsLng ?? null,
      taken_at: p.takenAt ?? new Date().toISOString(),
      uploaded_by: auth.userId,
    }));
    const { error } = await auth.supabase
      .from("inspection_photos")
      .insert(rows);
    if (error) return { ok: false, error: `AHC photos failed: ${error.message}` };
  }

  revalidatePath(`/projects/${input.projectId}/inspections/${input.inspectionId}`);
  return { ok: true };
}

// ============ 4. DECIDE (Mark Wooley only) ============
// under_review -> approved (locks) | rejected (returns to sub with reason).

export async function decideInspection(input: {
  inspectionId: string;
  projectId: string;
  decision: "approved" | "rejected";
  decisionNotes?: string | null;
}): Promise<{ ok: true } | AuthFail> {
  const auth = await getProfile();
  if (!auth.ok) return auth;

  // Single internal gate: Mark Wooley (ahc_super). Phil/zarina cannot decide.
  if (!isInspectionApprover({ role: auth.role, profileId: auth.userId })) {
    return { ok: false, error: "Only the QA/QC approver may approve or reject" };
  }
  if (input.decision === "rejected" && !input.decisionNotes?.trim()) {
    return { ok: false, error: "A reason is required to reject" };
  }

  const guard = await guardTransition(
    auth,
    input.inspectionId,
    input.projectId,
    input.decision,
  );
  if (!guard.ok) return guard;

  const { error } = await auth.supabase
    .from("inspections")
    .update({
      status: input.decision,
      decided_by: auth.userId,
      decided_at: new Date().toISOString(),
      decision_notes: input.decisionNotes?.trim() || null,
    })
    .eq("id", input.inspectionId);
  if (error) return { ok: false, error: error.message };

  // Verified work drives the schedule: on approval, apply this pin's progress
  // (status / % complete / installed quantity) to its linked WBS task.
  if (input.decision === "approved") {
    await applyPinProgressToSchedule(auth, input.inspectionId);
  }

  revalidatePath(`/projects/${input.projectId}/inspections`);
  revalidatePath(`/projects/${input.projectId}/inspections/${input.inspectionId}`);
  revalidatePath(`/projects/${input.projectId}/field-reports`);
  revalidatePath(`/projects/${input.projectId}/schedule`);
  return { ok: true };
}

// ============ 4b. FIELD REPORT REVIEW (streamlined per-item decide) ============
// The Field Report flow collapses the QA/QC steps: the CM decides a submitted
// work item in one action. Approving REQUIRES the CM's own verification photo
// (Phil's rule: "the CM needs to add his own picture if he is approving it").
// Both actions then roll the parent report's status up from its items, so the
// report status can never disagree with the pins on the map.

async function rollupReportStatus(
  auth: Authed,
  projectId: string,
  dprId: string,
): Promise<void> {
  const { data: pins } = await auth.supabase
    .from("inspections")
    .select("status, title, decision_notes")
    .eq("dpr_id", dprId)
    .eq("origin", "sub");
  const rows = pins ?? [];
  const statuses = rows.map((p) => p.status as InspectionStatus);
  const total = statuses.length;
  const rejected = statuses.some((s) => s === "rejected");
  const allApproved = total > 0 && statuses.every((s) => s === "approved");
  const nextStatus = rejected
    ? "returned"
    : allApproved
      ? "approved"
      : "submitted";

  const patch: TablesUpdate<"dprs"> = { status: nextStatus };
  if (nextStatus === "approved") {
    patch.reviewed_by = auth.userId;
    patch.reviewed_at = new Date().toISOString();
    // Clear any stale return reason so a report that was returned and later
    // approved doesn't show the old rejection note in the "Approved" banner.
    patch.review_notes = null;
  } else if (nextStatus === "returned") {
    // Roll the rejected pins' reasons up into a single report-level note so the
    // sub's "Returned" banner explains what to fix (the per-pin reasons are also
    // shown on each red pin).
    const reasons = rows
      .filter((p) => (p.status as InspectionStatus) === "rejected")
      .map((p) => {
        const reason = p.decision_notes?.trim();
        return reason ? `${p.title}: ${reason}` : p.title;
      });
    patch.review_notes = reasons.length ? reasons.join("\n") : null;
  }
  await auth.supabase.from("dprs").update(patch).eq("id", dprId);

  revalidatePath(`/projects/${projectId}/review-board`);
  revalidatePath(`/projects/${projectId}/field-reports`);
  revalidatePath(`/projects/${projectId}/field-reports/${dprId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
}

// Load a work item, verifying it belongs to the project and is decidable.
async function loadDecidablePin(
  auth: Authed,
  inspectionId: string,
  projectId: string,
): Promise<
  | { ok: true; dprId: string | null; status: InspectionStatus }
  | AuthFail
> {
  const { data: insp, error } = await auth.supabase
    .from("inspections")
    .select("id, project_id, status, dpr_id")
    .eq("id", inspectionId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!insp) return { ok: false, error: "Work item not found" };
  if (insp.project_id !== projectId)
    return { ok: false, error: "Work item does not belong to this project" };
  const status = insp.status as InspectionStatus;
  if (isLocked(status))
    return { ok: false, error: "This item is approved and locked" };
  return { ok: true, dprId: insp.dpr_id, status };
}

export async function reviewApproveInspection(input: {
  inspectionId: string;
  projectId: string;
  ahcNotes?: string | null;
  photos?: InspectionPhotoInput[];
}): Promise<{ ok: true } | AuthFail> {
  const auth = await getProfile();
  if (!auth.ok) return auth;
  if (!isInspectionApprover({ role: auth.role, profileId: auth.userId })) {
    return { ok: false, error: "Only the QA/QC approver may approve or reject" };
  }

  const pin = await loadDecidablePin(auth, input.inspectionId, input.projectId);
  if (!pin.ok) return pin;

  // Save the CM's verification photos/notes first (side='ahc').
  if (input.photos?.length) {
    const rows = input.photos.map((p) => ({
      inspection_id: input.inspectionId,
      side: "ahc" as const,
      storage_path: p.storagePath,
      caption: p.caption ?? null,
      gps_lat: p.gpsLat ?? null,
      gps_lng: p.gpsLng ?? null,
      taken_at: p.takenAt ?? new Date().toISOString(),
      uploaded_by: auth.userId,
    }));
    const { error } = await auth.supabase
      .from("inspection_photos")
      .insert(rows);
    if (error) return { ok: false, error: `Photos failed: ${error.message}` };
  }

  // The CM must have his own photo on the item to approve it.
  const { count } = await auth.supabase
    .from("inspection_photos")
    .select("id", { count: "exact", head: true })
    .eq("inspection_id", input.inspectionId)
    .eq("side", "ahc");
  if (!count || count === 0) {
    return { ok: false, error: "Add your photo before approving." };
  }

  const { error } = await auth.supabase
    .from("inspections")
    .update({
      status: "approved",
      ahc_notes: input.ahcNotes?.trim() || null,
      reviewed_by: auth.userId,
      decided_by: auth.userId,
      decided_at: new Date().toISOString(),
    })
    .eq("id", input.inspectionId);
  if (error) return { ok: false, error: error.message };

  await applyPinProgressToSchedule(auth, input.inspectionId);
  if (pin.dprId) await rollupReportStatus(auth, input.projectId, pin.dprId);

  revalidatePath(`/projects/${input.projectId}/inspections`);
  revalidatePath(
    `/projects/${input.projectId}/inspections/${input.inspectionId}`,
  );
  return { ok: true };
}

export async function reviewRejectInspection(input: {
  inspectionId: string;
  projectId: string;
  reason: string;
}): Promise<{ ok: true } | AuthFail> {
  const auth = await getProfile();
  if (!auth.ok) return auth;
  if (!isInspectionApprover({ role: auth.role, profileId: auth.userId })) {
    return { ok: false, error: "Only the QA/QC approver may approve or reject" };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: "A reason is required to reject" };
  }

  const pin = await loadDecidablePin(auth, input.inspectionId, input.projectId);
  if (!pin.ok) return pin;

  const { error } = await auth.supabase
    .from("inspections")
    .update({
      status: "rejected",
      reviewed_by: auth.userId,
      decided_by: auth.userId,
      decided_at: new Date().toISOString(),
      decision_notes: input.reason.trim(),
    })
    .eq("id", input.inspectionId);
  if (error) return { ok: false, error: error.message };

  if (pin.dprId) await rollupReportStatus(auth, input.projectId, pin.dprId);

  revalidatePath(`/projects/${input.projectId}/inspections`);
  revalidatePath(
    `/projects/${input.projectId}/inspections/${input.inspectionId}`,
  );
  return { ok: true };
}

// Push an approved pin's captured progress onto its WBS schedule task. Best
// effort: a schedule-write failure does not roll back the approval (the
// decision already stands); it just isn't reflected on the schedule.
async function applyPinProgressToSchedule(
  auth: Authed,
  inspectionId: string,
): Promise<void> {
  const { data: pin } = await auth.supabase
    .from("inspections")
    .select("schedule_task_id, task_new_status, task_new_pct, quantity")
    .eq("id", inspectionId)
    .maybeSingle();
  if (!pin?.schedule_task_id) return;

  const patch: TablesUpdate<"schedule_tasks"> = {
    status_source: "dpr",
    last_dpr_at: new Date().toISOString(),
  };
  if (pin.task_new_status) patch.status = pin.task_new_status;
  if (pin.task_new_pct != null) patch.pct_complete = pin.task_new_pct;
  if (pin.quantity != null) patch.installed_quantity = pin.quantity;

  await auth.supabase
    .from("schedule_tasks")
    .update(patch)
    .eq("id", pin.schedule_task_id);
}

// Shared transition guard: load current status, verify project ownership and
// that from->to is a legal edge in the state machine.
async function guardTransition(
  auth: Authed,
  inspectionId: string,
  projectId: string,
  to: InspectionStatus,
): Promise<{ ok: true } | AuthFail> {
  const { data: insp, error } = await auth.supabase
    .from("inspections")
    .select("id, project_id, status")
    .eq("id", inspectionId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!insp) return { ok: false, error: "Inspection not found" };
  if (insp.project_id !== projectId)
    return { ok: false, error: "Inspection does not belong to this project" };
  const from = insp.status as InspectionStatus;
  if (!canTransition(from, to)) {
    return {
      ok: false,
      error: `Cannot move an inspection from ${from} to ${to}`,
    };
  }
  return { ok: true };
}

// ============ 5. SECURE LINK MANAGEMENT (AHC) ============

export async function createSecureLink(input: {
  projectId: string;
  subcontractorId: string;
  label?: string | null;
  expiresAt?: string | null;
}): Promise<{ ok: true; token: string } | AuthFail> {
  const auth = await assertReviewer();
  if (!auth.ok) return auth;

  const token = generateInspectionToken();
  const { error } = await auth.supabase.from("inspection_secure_links").insert({
    project_id: input.projectId,
    subcontractor_id: input.subcontractorId,
    token,
    label: input.label ?? null,
    expires_at: input.expiresAt ?? null,
    active: true,
    created_by: auth.userId,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/inspections`);
  return { ok: true, token };
}

export async function revokeSecureLink(
  linkId: string,
  projectId: string,
): Promise<{ ok: true } | AuthFail> {
  const auth = await assertReviewer();
  if (!auth.ok) return auth;
  const { error } = await auth.supabase
    .from("inspection_secure_links")
    .update({ active: false })
    .eq("id", linkId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}/inspections`);
  return { ok: true };
}

// ============ 6. SECURE-LINK SUBMISSION (no login) ============
// Called from the public /inspect/[token] route. There is NO authenticated
// session: the token is the credential. We validate it via the service role,
// then constrain the insert to the token's project_id + subcontractor_id. A
// caller cannot submit outside their scope because we never read project or
// subcontractor ids from the request body.

export type SecureLinkSubmitInput = {
  token: string;
  title: string;
  inspectionType?: string | null;
  notes?: string | null;
  quantity?: number | null;
  unitOfMeasure?: string | null;
  basemapKey?: string;
  pinX?: number | null;
  pinY?: number | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  inspectorName: string;
  photos?: InspectionPhotoInput[];
};

export async function submitViaSecureLink(
  input: SecureLinkSubmitInput,
): Promise<InspectionResult> {
  if (!input.token) return { ok: false, error: "Missing link token" };
  if (!input.title?.trim()) return { ok: false, error: "Title is required" };
  if (!input.inspectorName?.trim())
    return { ok: false, error: "Your name is required" };

  const admin = createAdminClient();

  // Validate the token. Scope comes ONLY from the stored link, never the body.
  const { data: link, error: linkErr } = await admin
    .from("inspection_secure_links")
    .select("id, project_id, subcontractor_id, active, expires_at")
    .eq("token", input.token)
    .maybeSingle();
  if (linkErr) return { ok: false, error: linkErr.message };
  if (!link) return { ok: false, error: "Invalid link" };
  if (!isLinkUsable(link)) return { ok: false, error: "This link has expired" };

  const { data: inspection, error } = await admin
    .from("inspections")
    .insert({
      project_id: link.project_id,
      subcontractor_id: link.subcontractor_id,
      inspection_type: input.inspectionType ?? null,
      title: input.title.trim(),
      notes: input.notes ?? null,
      quantity: input.quantity ?? null,
      unit_of_measure: input.unitOfMeasure ?? null,
      basemap_key: input.basemapKey ?? "C2-01",
      pin_x: input.pinX ?? null,
      pin_y: input.pinY ?? null,
      gps_lat: input.gpsLat ?? null,
      gps_lng: input.gpsLng ?? null,
      inspector_name: input.inspectorName.trim(),
      submitted_via_link: link.id,
      status: "submitted",
      submitted_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !inspection) {
    return { ok: false, error: error?.message ?? "Failed to submit" };
  }

  if (input.photos?.length) {
    const rows = input.photos.map((p) => ({
      inspection_id: inspection.id,
      side: "sub" as const,
      storage_path: p.storagePath,
      caption: p.caption ?? null,
      gps_lat: p.gpsLat ?? null,
      gps_lng: p.gpsLng ?? null,
      taken_at: p.takenAt ?? new Date().toISOString(),
    }));
    await admin.from("inspection_photos").insert(rows);
  }

  await admin
    .from("inspection_secure_links")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", link.id);

  revalidatePath(`/projects/${link.project_id}/inspections`);
  return { ok: true, inspectionId: inspection.id };
}

// ============ 6b. SIGNED UPLOAD URL FOR THE NO-LOGIN PATH ============
// The secure-link sub has no auth session, so they cannot upload to storage
// under RLS. We validate the token server-side and mint a one-time signed
// upload URL scoped to a path inside the project's draft prefix. The client
// then PUTs the file directly to storage via uploadToSignedUrl.

export async function createSecureLinkUploadUrl(input: {
  token: string;
  fileName: string;
}): Promise<
  { ok: true; path: string; signedToken: string } | { ok: false; error: string }
> {
  if (!input.token) return { ok: false, error: "Missing link token" };
  const admin = createAdminClient();
  const { data: link } = await admin
    .from("inspection_secure_links")
    .select("id, project_id, active, expires_at")
    .eq("token", input.token)
    .maybeSingle();
  if (!link || !isLinkUsable(link)) return { ok: false, error: "Invalid link" };

  const path = `${link.project_id}/_drafts/sub/${randomUUID()}-${sanitizeFileName(input.fileName)}`;
  const { data, error } = await admin.storage
    .from(INSPECTION_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not create upload URL" };
  }
  return { ok: true, path, signedToken: data.token };
}

// ============ 7. SUB ACKNOWLEDGEMENT (dispute protection) ============
// The sub confirms the verified record. This is the accountability trail.

export async function acknowledgeViaSecureLink(input: {
  token: string;
  inspectionId: string;
}): Promise<{ ok: true } | AuthFail> {
  const admin = createAdminClient();
  const { data: link } = await admin
    .from("inspection_secure_links")
    .select("id, subcontractor_id, active, expires_at")
    .eq("token", input.token)
    .maybeSingle();
  if (!link || !isLinkUsable(link)) return { ok: false, error: "Invalid link" };

  // The inspection must belong to this token's subcontractor.
  const { data: insp } = await admin
    .from("inspections")
    .select("id, subcontractor_id")
    .eq("id", input.inspectionId)
    .maybeSingle();
  if (!insp || insp.subcontractor_id !== link.subcontractor_id) {
    return { ok: false, error: "Not authorized for this record" };
  }

  const { error } = await admin
    .from("inspections")
    .update({ sub_acknowledged_at: new Date().toISOString() })
    .eq("id", input.inspectionId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
