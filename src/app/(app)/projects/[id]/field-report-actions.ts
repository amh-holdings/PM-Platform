"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { proposeProductionForReport } from "@/lib/production-proposal-run";
import type { Json, TablesUpdate } from "@/lib/database.types";
import {
  canReview,
  PHOTO_SIDE_CM,
  PHOTO_SIDE_SUB,
} from "@/lib/inspection-status";
import { isBasemapKey } from "@/lib/inspection-map";
import { joinPinNotes, splitPinNotes } from "@/lib/pin-notes";
import {
  draftStoragePaths,
  parseFieldReportDraft,
  type FieldReportDraft,
} from "@/lib/field-report-draft";
import { submitDpr, type DprSubmitInput } from "./dpr-actions";
import type { InspectionPhotoInput } from "./inspections/inspection-actions";
import { INSPECTION_BUCKET } from "./inspections/inspection-constants";

// Draft photo blobs are staged in the shared private DPR bucket before the
// draft is ever saved (same convention as submitDpr).
const DPR_PHOTO_BUCKET = "dpr-photos";

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
  // Set when the sub is filing a draft they saved earlier (migration 0039).
  // Ownership is re-checked here before it reaches submitDpr.
  dprId?: string | null;
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

  // 1. If this is a saved draft being filed, confirm the caller owns it and
  //    that it is still a draft BEFORE handing the id to submitDpr - that is
  //    where it gets promoted through the service-role client, which bypasses
  //    RLS, so this check is the only thing standing between one sub and
  //    another sub's report.
  if (input.dprId) {
    const guard = await assertOwnedDraft(input.dprId, input.projectId);
    if (!guard.ok) return guard;
    if (guard.subcontractorId && guard.subcontractorId !== input.subcontractorId) {
      return {
        ok: false,
        error: "This draft belongs to a different subcontractor.",
      };
    }
  }

  // 2. Write the DPR container (reuses the single DPR-writing path). This sets
  //    subcontractor_id and stamps status='submitted'.
  const dprRes = await submitDpr({
    projectId: input.projectId,
    promoteDprId: input.dprId ?? null,
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

  // 3. Insert each work-done pin as an inspection linked to this DPR. RLS lets
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
  // The nav count lives in the project layout, which "page" revalidation misses.
  revalidatePath(`/projects/${input.projectId}`, "layout");
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
  // Approving or returning a report changes the "awaiting review" count in the
  // rail, and that is rendered by the project layout.
  revalidatePath(`/projects/${projectId}`, "layout");
}

// ===== Resubmit one pin (subcontractor) =====
// A returned report is fixed in place, one flagged pin at a time. The sub
// reopens the flagged card, CORRECTS IT IN FULL - which WBS activity it is
// against, the progress it claims, the quantity, the notes, even where the pin
// sits on the sheet - attaches photos, says what changed, and that single pin
// goes back to 'submitted' while the others are left alone. The parent report's
// status is then re-derived from all its pins, so it stays 'returned' until the
// LAST red pin is resubmitted, then clears itself.
//
// It used to accept photos and a note only. The common rejection is "wrong
// activity", and a photo cannot fix a wrong activity: the sub had to ask AHC to
// delete the report so they could refile the whole day. Everything the pin
// editor collects is editable here instead.
//
// Signed-in subs have no UPDATE grant on inspections/dprs (RLS is insert-only
// for them), so - like the no-login secure-link path - this runs through the
// service-role client after an explicit ownership check.

// The correctable half of a work pin: exactly the fields the sub filled in when
// they dropped it. Omitted keys are left as they were, so a caller that only
// wants the old photos-and-a-note behaviour can send nothing.
export type PinCorrection = {
  scheduleTaskId?: string | null;
  taskNewStatus?: string | null;
  taskNewPct?: number | null;
  installedQuantity?: number | null;
  unitOfMeasure?: string | null;
  notes?: string | null;
  basemapKey?: string | null;
  pinX?: number | null;
  pinY?: number | null;
};

export async function resubmitFieldReportPin(input: {
  pinId: string;
  projectId: string;
  fixNotes: string;
  photos: InspectionPhotoInput[];
  // Field corrections. Absent = resubmit the pin as-is.
  corrections?: PinCorrection | null;
  // Sub-side photos to drop (wrong picture attached). CM verification photos
  // are never removable from here.
  removePhotoIds?: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await getReportProfile();
  if (!auth.ok) return auth;
  if (!input.fixNotes?.trim())
    return { ok: false, error: "Describe what you fixed before resubmitting." };

  const admin = createAdminClient();
  const { data: pin, error: pinErr } = await admin
    .from("inspections")
    .select(
      "id, project_id, dpr_id, origin, status, subcontractor_id, title, notes, schedule_task_id, task_new_status, task_new_pct, quantity, unit_of_measure, resubmission_count",
    )
    .eq("id", input.pinId)
    .maybeSingle();
  if (pinErr) return { ok: false, error: pinErr.message };
  if (!pin || pin.project_id !== input.projectId)
    return { ok: false, error: "Work item not found" };
  if (pin.origin === "cm")
    return { ok: false, error: "Not a subcontractor work item" };
  if (pin.status !== "rejected")
    return { ok: false, error: "Only a rejected item can be resubmitted" };

  const isAhc = canReview(auth.role);
  const isOwner =
    auth.subcontractorId != null &&
    pin.subcontractor_id === auth.subcontractorId;
  if (!isAhc && !isOwner)
    return { ok: false, error: "Not authorized to resubmit this item" };

  const c = input.corrections ?? {};
  const patch: TablesUpdate<"inspections"> = {};
  // Human-readable record of what actually changed, appended to the notes so
  // the CM re-reviewing the pin can see it without diffing anything.
  const changeLines: string[] = [];

  // --- Activity (WBS task). The pin's title IS its schedule task, so a moved
  //     pin gets a retitled card too, exactly as the report form derives it.
  if (c.scheduleTaskId !== undefined) {
    const nextTaskId = c.scheduleTaskId || null;
    if (!nextTaskId)
      return { ok: false, error: "Pick the WBS activity this work is against." };
    if (nextTaskId !== pin.schedule_task_id) {
      const task = await loadPinnableTask(admin, nextTaskId, input.projectId);
      if (!task.ok) return task;
      const oldLabel = pin.title;
      patch.schedule_task_id = nextTaskId;
      patch.title = task.label;
      changeLines.push(`Activity: ${oldLabel} -> ${task.label}`);
    }
  }

  // --- Progress claimed against that activity. These are the numbers that
  //     reach the schedule and then the pay application, so every change is
  //     written into the trail: the CM approving round two must be able to see
  //     that 40% became 90% without holding round one in their head.
  if (c.taskNewStatus !== undefined) {
    const next = c.taskNewStatus?.trim() || null;
    if (!next) return { ok: false, error: "Pick a status for the work item." };
    patch.task_new_status = next;
    if (next !== pin.task_new_status)
      changeLines.push(`Status: ${pin.task_new_status ?? "-"} -> ${next}`);
  }
  if (c.taskNewPct !== undefined) {
    const next = c.taskNewPct;
    if (next == null || !Number.isFinite(next) || next < 0 || next > 100)
      return { ok: false, error: "Percent complete must be between 0 and 100." };
    patch.task_new_pct = next;
    if (next !== pin.task_new_pct)
      changeLines.push(`Percent complete: ${pin.task_new_pct ?? "-"}% -> ${next}%`);
  }
  if (c.installedQuantity !== undefined) {
    const next = c.installedQuantity;
    if (next == null || !Number.isFinite(next) || next < 0)
      return { ok: false, error: "Installed quantity must be zero or more." };
    patch.quantity = next;
    if (next !== pin.quantity)
      changeLines.push(`Installed qty: ${pin.quantity ?? "-"} -> ${next}`);
  }
  if (c.unitOfMeasure !== undefined) {
    const next = c.unitOfMeasure?.trim() || null;
    if (!next) return { ok: false, error: "Pick a unit for the quantity." };
    patch.unit_of_measure = next;
    if (next !== pin.unit_of_measure)
      changeLines.push(`Unit: ${pin.unit_of_measure ?? "-"} -> ${next}`);
  }

  // --- Where the pin sits. Both coordinates travel together; a sheet change
  //     without a fresh tap would leave the old sheet's coordinates behind.
  if (c.basemapKey !== undefined || c.pinX !== undefined || c.pinY !== undefined) {
    const key = c.basemapKey?.trim() || "";
    if (!isBasemapKey(key))
      return { ok: false, error: "Pick a valid drawing sheet for the pin." };
    if (
      c.pinX == null ||
      c.pinY == null ||
      !Number.isFinite(c.pinX) ||
      !Number.isFinite(c.pinY) ||
      c.pinX < 0 ||
      c.pinX > 1 ||
      c.pinY < 0 ||
      c.pinY > 1
    ) {
      return { ok: false, error: "Tap the map to place the pin." };
    }
    patch.basemap_key = key;
    patch.pin_x = c.pinX;
    patch.pin_y = c.pinY;
    changeLines.push("Pin moved on the map");
  }

  // --- Notes. The sub edits the body only. The fix trail already in the column
  //     is carried over here rather than round-tripped through the form, so a
  //     correction cannot erase the history the CM re-reviews against.
  const existing = splitPinNotes(pin.notes);
  const nextBody = c.notes !== undefined ? (c.notes ?? "").trim() : existing.body;

  // --- Photos. Removals first, so the "at least one photo survives" check
  //     below sees the real end state.
  const removeIds = (input.removePhotoIds ?? []).filter(Boolean);
  let removedPaths: string[] = [];
  if (removeIds.length > 0) {
    const { data: doomed, error: doomedErr } = await admin
      .from("inspection_photos")
      .select("id, storage_path, side")
      .eq("inspection_id", pin.id)
      .in("id", removeIds);
    if (doomedErr) return { ok: false, error: doomedErr.message };
    if ((doomed ?? []).some((p) => p.side === PHOTO_SIDE_CM))
      return { ok: false, error: "CM verification photos cannot be removed." };
    if ((doomed ?? []).length !== removeIds.length)
      return { ok: false, error: "One of those photos is no longer on this item." };
    removedPaths = (doomed ?? []).map((p) => p.storage_path);
  }

  const { count: subPhotoCount } = await admin
    .from("inspection_photos")
    .select("id", { count: "exact", head: true })
    .eq("inspection_id", pin.id)
    .eq("side", PHOTO_SIDE_SUB);
  const remaining =
    (subPhotoCount ?? 0) - removeIds.length + (input.photos?.length ?? 0);
  if (remaining < 1) {
    return {
      ok: false,
      error: "The work item needs at least one photo. Add one before resubmitting.",
    };
  }

  const now = new Date().toISOString();
  // Record the fix as a stamped line appended to the pin's notes. (No dedicated
  // sub-fix column yet; this keeps a readable, multi-round trail the CM sees on
  // re-review.)
  const fixBlock = [
    `[Fix ${now.slice(0, 10)}] ${input.fixNotes.trim()}`,
    ...changeLines,
  ].join("\n");
  const nextNotes = joinPinNotes(nextBody, [...existing.trail, fixBlock]);

  const { error: updErr } = await admin
    .from("inspections")
    .update({
      ...patch,
      status: "submitted",
      resubmission_count: (pin.resubmission_count ?? 0) + 1,
      submitted_at: now,
      review_started_at: null,
      decided_by: null,
      decided_at: null,
      decision_notes: null,
      notes: nextNotes,
    })
    .eq("id", pin.id);
  if (updErr) return { ok: false, error: updErr.message };

  if (removeIds.length > 0) {
    const { error: delErr } = await admin
      .from("inspection_photos")
      .delete()
      .eq("inspection_id", pin.id)
      .in("id", removeIds);
    if (delErr) return { ok: false, error: delErr.message };
    // Best-effort: an orphaned blob is dead weight, not a correctness bug.
    if (removedPaths.length > 0) {
      await admin.storage.from(INSPECTION_BUCKET).remove(removedPaths);
    }
  }

  if (input.photos?.length) {
    const rows = input.photos.map((ph) => ({
      inspection_id: pin.id,
      side: PHOTO_SIDE_SUB,
      storage_path: ph.storagePath,
      caption: ph.caption ?? null,
      gps_lat: ph.gpsLat ?? null,
      gps_lng: ph.gpsLng ?? null,
      taken_at: ph.takenAt ?? now,
      uploaded_by: auth.userId,
    }));
    const { error: photoErr } = await admin
      .from("inspection_photos")
      .insert(rows);
    if (photoErr) return { ok: false, error: photoErr.message };
  }

  if (pin.dpr_id) {
    await rollupReportStatusAdmin(admin, pin.dpr_id, auth.userId);
    revalidateReport(input.projectId, pin.dpr_id);
  }
  return { ok: true };
}

// A pin may only point at a leaf task on this project. Pinning to a summary row
// writes a rollup percent straight onto the schedule (see schedule-picker.ts),
// which is why the report form hides them - the correction path has to hide
// them too or it becomes the back door.
async function loadPinnableTask(
  admin: ReturnType<typeof createAdminClient>,
  taskId: string,
  projectId: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const { data: task, error } = await admin
    .from("schedule_tasks")
    .select("id, project_id, wbs_code, task_name")
    .eq("id", taskId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!task || task.project_id !== projectId)
    return { ok: false, error: "That WBS activity is not on this project." };

  const { count } = await admin
    .from("schedule_tasks")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("parent_wbs_code", task.wbs_code);
  if ((count ?? 0) > 0) {
    return {
      ok: false,
      error: `${task.wbs_code} is a summary line. Pick the specific work item under it.`,
    };
  }
  return { ok: true, label: `${task.wbs_code} ${task.task_name}` };
}

// Re-derive a report's status from its sub pins using the service-role client.
// Mirrors rollupReportStatus in inspection-actions (which runs on the CM's
// client during review); this variant is for the sub's admin-client resubmit,
// since the sub can't write dprs directly. Keep the two in sync.
async function rollupReportStatusAdmin(
  admin: ReturnType<typeof createAdminClient>,
  dprId: string,
  userId: string,
): Promise<void> {
  const { data: pins } = await admin
    .from("inspections")
    .select("status, title, decision_notes")
    .eq("dpr_id", dprId)
    .eq("origin", "sub");
  const rows = pins ?? [];
  const statuses = rows.map((p) => p.status);
  const total = statuses.length;
  const rejected = statuses.some((s) => s === "rejected");
  const allApproved = total > 0 && statuses.every((s) => s === "approved");
  const nextStatus = rejected
    ? "returned"
    : allApproved
      ? "approved"
      : "submitted";

  const patch: TablesUpdate<"dprs"> = { status: nextStatus };
  if (nextStatus === "returned") {
    // Rebuild the return summary from whatever pins are STILL rejected (the one
    // just resubmitted cleared its decision_notes, so it drops out).
    const reasons = rows
      .filter((p) => p.status === "rejected")
      .map((p) => {
        const reason = p.decision_notes?.trim();
        return reason ? `${p.title}: ${reason}` : p.title;
      });
    patch.review_notes = reasons.length ? reasons.join("\n") : null;
  } else {
    // Back in the queue (or fully approved): clear the stale return note.
    patch.review_notes = null;
    if (nextStatus === "approved") {
      patch.reviewed_by = userId;
      patch.reviewed_at = new Date().toISOString();
    }
  }
  await admin.from("dprs").update(patch).eq("id", dprId);

  // Same trigger as the CM-side rollup: an approved report proposes the day's
  // commodity production. This path is reached when a sub resubmits the LAST
  // flagged pin on a returned report and that clears it to approved, so the
  // tracker must fill from here too or those days stay invisible.
  if (nextStatus === "approved") {
    const { data: dpr } = await admin
      .from("dprs")
      .select("project_id")
      .eq("id", dprId)
      .maybeSingle();
    if (dpr?.project_id) {
      const result = await proposeProductionForReport(admin, {
        projectId: dpr.project_id,
        dprId,
      });
      if (result.error) console.error("[production-proposal]", dprId, result.error);
      revalidatePath(`/projects/${dpr.project_id}/reports/commodity-tracker`);
    }
  }
}

// ===== Draft lifecycle (migration 0039) =====
// The sub's Field Report used to be create-once, which meant a report had to be
// filled and filed in a single sitting. It now mirrors the CM Daily Log: start
// it, save it as often as you like, and it LOCKS the moment you submit - from
// there it is the CM's to review, and the sub can only touch it through the
// per-pin resubmit flow above.
//
// Everything unsubmitted lives in dprs.draft_payload as JSON and owns no child
// rows, so a draft cannot appear on the review board, on the pin map, or in a
// pay application. See src/lib/field-report-draft.ts for why that shape.
//
// Like resubmitFieldReportPin, these run through the service-role client after
// an explicit ownership check rather than leaning on a sub's RLS grants.

type DraftGuard =
  | {
      ok: true;
      admin: ReturnType<typeof createAdminClient>;
      userId: string;
      dprId: string;
      subcontractorId: string | null;
      draft: FieldReportDraft | null;
    }
  | { ok: false; error: string };

// Confirm the signed-in user may write this draft, and that it IS still a
// draft. A sub may only reach their own company's report; AHC reviewers may
// reach any of them.
async function assertOwnedDraft(
  dprId: string,
  projectId: string,
): Promise<DraftGuard> {
  const auth = await getReportProfile();
  if (!auth.ok) return auth;

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("dprs")
    .select("id, project_id, status, subcontractor_id, draft_payload")
    .eq("id", dprId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!row || row.project_id !== projectId)
    return { ok: false, error: "Report not found" };
  if (row.status !== "draft") {
    return {
      ok: false,
      error: "This report was already submitted and can no longer be edited.",
    };
  }

  const isAhc = canReview(auth.role);
  const isOwner =
    auth.subcontractorId != null &&
    row.subcontractor_id === auth.subcontractorId;
  if (!isAhc && !isOwner)
    return { ok: false, error: "Not authorized to edit this report" };

  return {
    ok: true,
    admin,
    userId: auth.userId,
    dprId: row.id,
    subcontractorId: row.subcontractor_id,
    draft: parseFieldReportDraft(row.draft_payload),
  };
}

export type SaveFieldReportDraftInput = {
  projectId: string;
  // Absent on the first save of a new report; set on every save after that.
  dprId?: string | null;
  subcontractorId: string;
  draft: FieldReportDraft;
};

// Free-text numeric fields are coerced only for the summary columns below;
// the draft's own copy stays exactly as typed so the form round-trips.
function numOrNull(v: string): number | null {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : null;
}

export async function saveFieldReportDraft(
  input: SaveFieldReportDraftInput,
): Promise<FieldReportResult> {
  const auth = await getReportProfile();
  if (!auth.ok) return auth;
  if (!input.subcontractorId)
    return { ok: false, error: "Select which subcontractor this report is for" };
  if (!input.draft?.reportDate)
    return { ok: false, error: "Pick a date for the report" };

  // A sub may only file under their own company. AHC reviewers are unrestricted
  // so they can pick a report up on a sub's behalf.
  if (
    !canReview(auth.role) &&
    (auth.subcontractorId == null ||
      auth.subcontractorId !== input.subcontractorId)
  ) {
    return { ok: false, error: "You can only save reports for your own company" };
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();
  // Mirror the headline fields into their real columns as well as the payload,
  // so the reports list and the coverage view can read a draft without parsing
  // JSON. The payload stays authoritative for the form.
  const summary = {
    project_id: input.projectId,
    subcontractor_id: input.subcontractorId,
    report_date: input.draft.reportDate,
    work_narrative: input.draft.narrative.trim() || null,
    crew_count: numOrNull(input.draft.crewOverride),
    weather_conditions: input.draft.weather.trim() || null,
    safety_incident: input.draft.safetyIncident,
    near_miss: input.draft.nearMiss,
    safety_narrative: input.draft.safetyNarrative.trim() || null,
    // The draft is a plain object of strings/booleans/arrays, so it satisfies
    // Json; TS just cannot see that through the declared interface.
    draft_payload: input.draft as unknown as Json,
    updated_at: now,
  };

  let dprId = input.dprId ?? null;

  if (dprId) {
    const guard = await assertOwnedDraft(dprId, input.projectId);
    if (!guard.ok) return guard;
    const { error } = await admin.from("dprs").update(summary).eq("id", dprId);
    if (error) {
      // The sub moved this draft onto a date their company already has a
      // report for - the unique (project, sub, date) index. Say which date,
      // because the raw constraint message means nothing in the field.
      if (error.code === "23505") {
        return {
          ok: false,
          error: `Your company already has a report for ${input.draft.reportDate}. Pick a different date.`,
        };
      }
      return { ok: false, error: error.message };
    }
  } else {
    // No id yet. One report per sub per day (the unique index on
    // project/sub/report_date), so an existing row for that date is the same
    // report - resume it rather than colliding. If it is already submitted,
    // say so instead of silently overwriting the filed record.
    const { data: existing } = await admin
      .from("dprs")
      .select("id, status")
      .eq("project_id", input.projectId)
      .eq("subcontractor_id", input.subcontractorId)
      .eq("report_date", input.draft.reportDate)
      .maybeSingle();

    if (existing && existing.status !== "draft") {
      return {
        ok: false,
        error: `A report for ${input.draft.reportDate} was already submitted.`,
      };
    }
    if (existing) {
      const { error } = await admin
        .from("dprs")
        .update(summary)
        .eq("id", existing.id);
      if (error) return { ok: false, error: error.message };
      dprId = existing.id;
    } else {
      const { data: created, error } = await admin
        .from("dprs")
        .insert({ ...summary, foreman_id: auth.userId, status: "draft" })
        .select("id")
        .single();
      if (error?.code === "23505") {
        // Raced with another device saving the same day's report.
        return {
          ok: false,
          error: `A report for ${input.draft.reportDate} was just created elsewhere. Reload to pick it up.`,
        };
      }
      if (error || !created)
        return { ok: false, error: error?.message ?? "Could not save the draft" };
      dprId = created.id;
    }
  }

  revalidatePath(`/projects/${input.projectId}/field-reports`);
  revalidatePath(`/projects/${input.projectId}/field-reports/${dprId}`);
  return { ok: true, dprId };
}

// Throw a draft away: its staged photo blobs, then the row. Only ever reachable
// for status='draft', so this can never delete a filed report.
export async function discardFieldReportDraft(
  dprId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = await assertOwnedDraft(dprId, projectId);
  if (!guard.ok) return guard;

  if (guard.draft) {
    const paths = draftStoragePaths(guard.draft);
    if (paths.length > 0) {
      // Best-effort: a blob left behind is dead weight, not a correctness bug.
      await guard.admin.storage.from(DPR_PHOTO_BUCKET).remove(paths);
    }
  }

  const { error } = await guard.admin
    .from("dprs")
    .delete()
    .eq("id", guard.dprId)
    .eq("status", "draft");
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/field-reports`);
  return { ok: true };
}
