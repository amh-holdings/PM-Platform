"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  canReview,
  PHOTO_SIDE_CM,
  PHOTO_SIDE_SUB,
} from "@/lib/inspection-status";
import { submitDpr, type DprSubmitInput } from "./dpr-actions";
import type { InspectionPhotoInput } from "./inspections/inspection-actions";

// One map-pinned "work done today" item on a Field Report. It becomes an
// inspection row (origin='sub') linked to the day's DPR, inheriting the
// submitted -> under_review -> approved/rejected review workflow.
export type WorkPinInput = {
  title: string;
  inspectionType?: string | null;
  scheduleTaskId?: string | null; // WBS link to a schedule task
  // Progress for that WBS task, applied to the schedule when the CM approves
  // this pin. installedQuantity reuses inspections.quantity.
  taskNewStatus?: string | null;
  taskNewPct?: number | null;
  installedQuantity?: number | null;
  unitOfMeasure?: string | null;
  notes?: string | null;
  basemapKey: string;
  pinX: number | null;
  pinY: number | null;
  photos?: InspectionPhotoInput[];
};

// A Field Report = the DPR fields (minus the container plumbing) + the sub's
// work-done pins. subcontractorId is required here (unlike a bare DPR).
export type FieldReportInput = Omit<DprSubmitInput, "subcontractorId"> & {
  subcontractorId: string;
  workPins: WorkPinInput[];
};

export type FieldReportResult =
  | { ok: true; dprId: string }
  | { ok: false; error: string };

export async function submitFieldReport(
  input: FieldReportInput,
): Promise<FieldReportResult> {
  if (!input.subcontractorId)
    return { ok: false, error: "Subcontractor is required" };
  if (!input.workPins?.length)
    return { ok: false, error: "Mark at least one work item on the map" };
  for (const p of input.workPins) {
    if (!p.title?.trim())
      return { ok: false, error: "Every work item needs a short title" };
    if (p.pinX == null || p.pinY == null)
      return { ok: false, error: `Drop a map pin for "${p.title.trim()}"` };
  }

  // 1. Write the DPR container (reuses the single DPR-writing path). This sets
  //    subcontractor_id and stamps status='submitted'.
  const dprRes = await submitDpr({
    projectId: input.projectId,
    subcontractorId: input.subcontractorId,
    reportDate: input.reportDate,
    workNarrative: input.workNarrative,
    crewCount: input.crewCount,
    totalManHours: input.totalManHours,
    weatherConditions: input.weatherConditions,
    safetyIncident: input.safetyIncident,
    nearMiss: input.nearMiss,
    safetyNarrative: input.safetyNarrative,
    taskUpdates: input.taskUpdates ?? [],
    manpower: input.manpower,
    equipment: input.equipment,
    deliveries: input.deliveries,
    delays: input.delays,
    photos: input.photos,
  });
  if (!dprRes.ok) return dprRes;
  const dprId = dprRes.dprId;

  // 2. Insert each work-done pin as an inspection linked to this DPR. RLS lets
  //    a signed-in sub insert inspections scoped to their own subcontractor_id.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userId = user?.id ?? null;
  const now = new Date().toISOString();

  for (const p of input.workPins) {
    const { data: insp, error: inspErr } = await supabase
      .from("inspections")
      .insert({
        project_id: input.projectId,
        subcontractor_id: input.subcontractorId,
        dpr_id: dprId,
        origin: "sub",
        title: p.title.trim(),
        inspection_type: p.inspectionType?.trim() || null,
        schedule_task_id: p.scheduleTaskId || null,
        task_new_status: p.taskNewStatus || null,
        task_new_pct: p.taskNewPct ?? null,
        quantity: p.installedQuantity ?? null,
        unit_of_measure: p.unitOfMeasure || null,
        notes: p.notes?.trim() || null,
        basemap_key: p.basemapKey,
        pin_x: p.pinX,
        pin_y: p.pinY,
        submitted_by: userId,
        status: "submitted",
        submitted_at: now,
      })
      .select("id")
      .single();
    if (inspErr || !insp) {
      return {
        ok: false,
        error: `Report saved, but a work pin failed: ${inspErr?.message ?? "unknown"}`,
      };
    }

    if (p.photos?.length) {
      const rows = p.photos.map((ph) => ({
        inspection_id: insp.id,
        side: PHOTO_SIDE_SUB,
        storage_path: ph.storagePath,
        caption: ph.caption ?? null,
        gps_lat: ph.gpsLat ?? null,
        gps_lng: ph.gpsLng ?? null,
        taken_at: ph.takenAt ?? now,
        uploaded_by: userId,
      }));
      const { error: photoErr } = await supabase
        .from("inspection_photos")
        .insert(rows);
      if (photoErr) {
        return { ok: false, error: `Work pin photos failed: ${photoErr.message}` };
      }
    }
  }

  revalidatePath(`/projects/${input.projectId}/field-reports`);
  revalidatePath(`/projects/${input.projectId}/field-reports/${dprId}`);
  revalidatePath(`/projects/${input.projectId}/inspections`);
  return { ok: true, dprId };
}

// ===== CM own-check =====
// The Construction Manager drops his own independent inspection pin against a
// Field Report (origin='cm'). Same map + photos as a sub pin, but authored by
// the CM. Photos are stored on the 'ahc' side (CM/AHC eyes).
export type CmCheckInput = {
  projectId: string;
  dprId: string;
  subcontractorId: string | null;
  title: string;
  inspectionType?: string | null;
  scheduleTaskId?: string | null;
  notes?: string | null;
  basemapKey: string;
  pinX: number | null;
  pinY: number | null;
  photos?: InspectionPhotoInput[];
};

export async function submitCmCheck(
  input: CmCheckInput,
): Promise<FieldReportResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || !canReview(profile.role)) {
    return { ok: false, error: "Restricted to the Construction Manager" };
  }
  if (!input.title?.trim())
    return { ok: false, error: "Give the check a short title" };
  if (input.pinX == null || input.pinY == null)
    return { ok: false, error: "Drop a pin on the map for this check" };

  const now = new Date().toISOString();
  const { data: insp, error: inspErr } = await supabase
    .from("inspections")
    .insert({
      project_id: input.projectId,
      subcontractor_id: input.subcontractorId,
      dpr_id: input.dprId,
      origin: "cm",
      title: input.title.trim(),
      inspection_type: input.inspectionType?.trim() || null,
      schedule_task_id: input.scheduleTaskId || null,
      notes: input.notes?.trim() || null,
      basemap_key: input.basemapKey,
      pin_x: input.pinX,
      pin_y: input.pinY,
      submitted_by: user.id,
      status: "submitted",
      submitted_at: now,
    })
    .select("id")
    .single();
  if (inspErr || !insp) {
    return { ok: false, error: inspErr?.message ?? "Failed to add check" };
  }

  if (input.photos?.length) {
    const rows = input.photos.map((ph) => ({
      inspection_id: insp.id,
      side: PHOTO_SIDE_CM,
      storage_path: ph.storagePath,
      caption: ph.caption ?? null,
      gps_lat: ph.gpsLat ?? null,
      gps_lng: ph.gpsLng ?? null,
      taken_at: ph.takenAt ?? now,
      uploaded_by: user.id,
    }));
    const { error: photoErr } = await supabase
      .from("inspection_photos")
      .insert(rows);
    if (photoErr) return { ok: false, error: `Photos failed: ${photoErr.message}` };
  }

  revalidatePath(`/projects/${input.projectId}/field-reports/${input.dprId}`);
  revalidatePath(`/projects/${input.projectId}/inspections`);
  return { ok: true, dprId: input.dprId };
}

// ===== Report-level auth helper =====
// There is no separate "finalize" step: the report's status is rolled up from
// its work pins automatically as the CM approves/rejects each one (see
// rollupReportStatus in inspection-actions). This helper backs the sub's
// resubmit action below.

type FinalizeAuth =
  | {
      ok: true;
      supabase: ReturnType<typeof createClient>;
      userId: string;
      role: string;
      subcontractorId: string | null;
    }
  | { ok: false; error: string };

async function getReportProfile(): Promise<FinalizeAuth> {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, subcontractor_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return { ok: false, error: "Profile not found" };
  return {
    ok: true,
    supabase,
    userId: user.id,
    role: profile.role,
    subcontractorId: profile.subcontractor_id ?? null,
  };
}

function revalidateReport(projectId: string, dprId: string) {
  revalidatePath(`/projects/${projectId}/review-board`);
  revalidatePath(`/projects/${projectId}/field-reports`);
  revalidatePath(`/projects/${projectId}/field-reports/${dprId}`);
}

// ===== Resubmit (subcontractor) =====
// A returned report is fixed in place: the sub's rejected pins go back to
// 'submitted' and the report re-enters the CM's queue. Signed-in subs have no
// UPDATE grant on inspections/dprs (RLS is insert-only for them), so - like the
// no-login secure-link path - this runs through the service-role client after
// an explicit ownership check. Only the owning sub (or an AHC user) may call it.

export async function resubmitFieldReport(
  dprId: string,
  projectId: string,
): Promise<{ ok: true; resubmittedPins: number } | { ok: false; error: string }> {
  const auth = await getReportProfile();
  if (!auth.ok) return auth;

  const admin = createAdminClient();
  const { data: dpr, error: dprErr } = await admin
    .from("dprs")
    .select("id, project_id, status, subcontractor_id")
    .eq("id", dprId)
    .maybeSingle();
  if (dprErr) return { ok: false, error: dprErr.message };
  if (!dpr || dpr.project_id !== projectId)
    return { ok: false, error: "Report not found" };

  const isAhc = canReview(auth.role);
  const isOwner =
    auth.subcontractorId != null &&
    dpr.subcontractor_id === auth.subcontractorId;
  if (!isAhc && !isOwner) {
    return { ok: false, error: "Not authorized to resubmit this report" };
  }
  if (dpr.status !== "returned") {
    return { ok: false, error: "Only a returned report can be resubmitted" };
  }

  // Rejected sub pins -> submitted, clearing the prior decision and bumping the
  // resubmission counter (the dispute-protection trail).
  const { data: rejected, error: rejErr } = await admin
    .from("inspections")
    .select("id, resubmission_count")
    .eq("dpr_id", dprId)
    .eq("origin", "sub")
    .eq("status", "rejected");
  if (rejErr) return { ok: false, error: rejErr.message };

  const now = new Date().toISOString();
  for (const p of rejected ?? []) {
    const { error } = await admin
      .from("inspections")
      .update({
        status: "submitted",
        resubmission_count: (p.resubmission_count ?? 0) + 1,
        submitted_at: now,
        review_started_at: null,
        decided_by: null,
        decided_at: null,
        decision_notes: null,
      })
      .eq("id", p.id);
    if (error) return { ok: false, error: error.message };
  }

  const { error: dprUpdErr } = await admin
    .from("dprs")
    .update({ status: "submitted", submitted_at: now })
    .eq("id", dprId);
  if (dprUpdErr) return { ok: false, error: dprUpdErr.message };

  revalidateReport(projectId, dprId);
  return { ok: true, resubmittedPins: (rejected ?? []).length };
}
