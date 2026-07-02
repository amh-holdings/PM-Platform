"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/lib/database.types";

async function assertAhcUser() {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false as const, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || !["phil", "zarina", "ahc_super"].includes(profile.role)) {
    return { ok: false as const, error: "Restricted to AHC team members" };
  }
  return { ok: true as const, supabase, userId: user.id };
}

// Anyone with the sub_foreman or sub_pm role can submit DPRs. AHC users can too.
async function assertSubmitter() {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false as const, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return { ok: false as const, error: "Profile not found" };
  const allowed = ["phil", "zarina", "ahc_super", "sub_pm", "sub_foreman"];
  if (!allowed.includes(profile.role)) {
    return { ok: false as const, error: "Not authorized to submit DPRs" };
  }
  return { ok: true as const, supabase, userId: user.id, role: profile.role };
}

export type DprPhotoInput = {
  photoId: string;
  storagePath: string;
  caption: string | null;
  photoType: string;
};

export type DprManpowerInput = {
  subcontractorId: string | null;
  trade: string | null;
  headcount: number;
  regularHours: number;
  otHours: number;
  notes: string | null;
};

export type DprEquipmentInput = {
  equipmentName: string;
  quantity: number;
  onRent: boolean;
  rentalCompany: string | null;
  notes: string | null;
};

export type DprDeliveryInput = {
  vendorName: string | null;
  materials: string;
  quantity: number | null;
  unitOfMeasure: string | null;
  poNumber: string | null;
  procurementOrderId: string | null;
  notes: string | null;
};

export type DprDelayInput = {
  causeCode: string;
  hoursLost: number | null;
  impactedScheduleTaskId: string | null;
  narrative: string | null;
};

export type DprSubmitInput = {
  projectId: string;
  reportDate: string; // YYYY-MM-DD
  // The subcontractor this report is for. Legacy DPRs left this null; the Field
  // Report flow sets it so map pins can be scoped per sub.
  subcontractorId?: string | null;
  workNarrative: string;
  crewCount?: number | null;
  totalManHours?: number | null;
  weatherConditions?: string | null;
  safetyIncident?: boolean;
  nearMiss?: boolean;
  safetyNarrative?: string | null;
  taskUpdates: Array<{
    scheduleTaskId: string;
    newStatus?: string | null;
    newPctComplete?: number | null;
    installedQuantity?: number | null;
    notes?: string | null;
  }>;
  manpower?: DprManpowerInput[];
  equipment?: DprEquipmentInput[];
  deliveries?: DprDeliveryInput[];
  delays?: DprDelayInput[];
  photos?: DprPhotoInput[];
};

export type DprActionResult =
  | { ok: true; dprId: string }
  | { ok: false; error: string };

export async function submitDpr(input: DprSubmitInput): Promise<DprActionResult> {
  const auth = await assertSubmitter();
  if (!auth.ok) return auth;

  if (!input.reportDate) return { ok: false, error: "Report date is required" };
  if (!input.workNarrative?.trim())
    return { ok: false, error: "Work narrative is required" };

  // Insert the DPR row in submitted state. The foreman_id is the current user.
  const { data: dpr, error: insertErr } = await auth.supabase
    .from("dprs")
    .insert({
      project_id: input.projectId,
      foreman_id: auth.userId,
      subcontractor_id: input.subcontractorId ?? null,
      report_date: input.reportDate,
      work_narrative: input.workNarrative.trim(),
      crew_count: input.crewCount ?? null,
      total_man_hours: input.totalManHours ?? null,
      weather_conditions: input.weatherConditions ?? null,
      safety_incident: input.safetyIncident ?? false,
      near_miss: input.nearMiss ?? false,
      safety_narrative: input.safetyNarrative ?? null,
      status: "submitted",
      submitted_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insertErr || !dpr) {
    return { ok: false, error: insertErr?.message ?? "Failed to create DPR" };
  }

  // ===== task updates with before-snapshot =====
  const taskIds = input.taskUpdates.map((u) => u.scheduleTaskId);
  let prevByTask: Map<string, { status: string | null; pct: number | null }> =
    new Map();
  if (taskIds.length > 0) {
    const { data: prev } = await auth.supabase
      .from("schedule_tasks")
      .select("id, status, pct_complete")
      .in("id", taskIds);
    prevByTask = new Map(
      (prev ?? []).map((t) => [
        t.id,
        { status: t.status ?? null, pct: Number(t.pct_complete ?? 0) || null },
      ]),
    );
  }

  if (input.taskUpdates.length > 0) {
    const rows = input.taskUpdates
      .filter((u) => u.scheduleTaskId)
      .map((u) => {
        const prev = prevByTask.get(u.scheduleTaskId) ?? { status: null, pct: null };
        return {
          dpr_id: dpr.id,
          schedule_task_id: u.scheduleTaskId,
          previous_status: prev.status,
          new_status: u.newStatus ?? null,
          previous_pct_complete: prev.pct,
          new_pct_complete: u.newPctComplete ?? null,
          installed_quantity: u.installedQuantity ?? null,
          notes: u.notes ?? null,
        };
      });
    if (rows.length > 0) {
      const { error: updErr } = await auth.supabase
        .from("dpr_task_updates")
        .upsert(rows, { onConflict: "dpr_id,schedule_task_id" });
      if (updErr) {
        return { ok: false, error: `Task updates failed: ${updErr.message}` };
      }
    }
  }

  // ===== manpower =====
  if (input.manpower && input.manpower.length > 0) {
    const rows = input.manpower.map((m) => ({
      dpr_id: dpr.id,
      subcontractor_id: m.subcontractorId,
      trade: m.trade,
      headcount: m.headcount,
      regular_hours: m.regularHours,
      ot_hours: m.otHours,
      notes: m.notes,
    }));
    const { error } = await auth.supabase.from("dpr_manpower").insert(rows);
    if (error) return { ok: false, error: `Manpower failed: ${error.message}` };
  }

  // ===== equipment =====
  if (input.equipment && input.equipment.length > 0) {
    const rows = input.equipment
      .filter((e) => e.equipmentName.trim())
      .map((e) => ({
        dpr_id: dpr.id,
        equipment_name: e.equipmentName.trim(),
        quantity: e.quantity,
        on_rent: e.onRent,
        rental_company: e.rentalCompany,
        notes: e.notes,
      }));
    if (rows.length > 0) {
      const { error } = await auth.supabase.from("dpr_equipment").insert(rows);
      if (error) return { ok: false, error: `Equipment failed: ${error.message}` };
    }
  }

  // ===== deliveries =====
  if (input.deliveries && input.deliveries.length > 0) {
    const rows = input.deliveries
      .filter((d) => d.materials.trim())
      .map((d) => ({
        dpr_id: dpr.id,
        vendor_name: d.vendorName,
        materials: d.materials.trim(),
        quantity: d.quantity,
        unit_of_measure: d.unitOfMeasure,
        po_number: d.poNumber,
        procurement_order_id: d.procurementOrderId,
        notes: d.notes,
      }));
    if (rows.length > 0) {
      const { error } = await auth.supabase.from("dpr_deliveries").insert(rows);
      if (error) return { ok: false, error: `Deliveries failed: ${error.message}` };
    }
  }

  // ===== delays =====
  if (input.delays && input.delays.length > 0) {
    const rows = input.delays
      .filter((d) => d.causeCode.trim())
      .map((d) => ({
        dpr_id: dpr.id,
        cause_code: d.causeCode.trim(),
        hours_lost: d.hoursLost,
        impacted_schedule_task_id: d.impactedScheduleTaskId,
        narrative: d.narrative,
      }));
    if (rows.length > 0) {
      const { error } = await auth.supabase.from("dpr_delays").insert(rows);
      if (error) return { ok: false, error: `Delays failed: ${error.message}` };
    }
  }

  // ===== photos =====
  // Photos were uploaded by the client to dpr-photos/{projectId}/_drafts/...;
  // here we record the metadata row pointing at that path. We leave the blob
  // where it is (cheap enough). A nightly cleanup job can sweep abandoned
  // draft prefixes later if needed.
  if (input.photos && input.photos.length > 0) {
    const rows = input.photos.map((p) => ({
      project_id: input.projectId,
      dpr_id: dpr.id,
      uploaded_by_id: auth.userId,
      photo_type: p.photoType as
        | "progress"
        | "safety"
        | "delivery"
        | "issue"
        | "eod"
        | "other",
      storage_path: p.storagePath,
      caption: p.caption,
      taken_at: new Date().toISOString(),
    }));
    const { error } = await auth.supabase.from("photos").insert(rows);
    if (error) return { ok: false, error: `Photos failed: ${error.message}` };
  }

  revalidatePath(`/projects/${input.projectId}`);
  revalidatePath(`/projects/${input.projectId}/dprs`);
  return { ok: true, dprId: dpr.id };
}

// AHC users approve a submitted DPR. This applies the proposed task changes
// to schedule_tasks, sets dprs.status='approved', and stamps last_dpr_at on
// each affected task so the dashboard can show recency.
export async function approveDpr(
  dprId: string,
  projectId: string,
  reviewNotes?: string,
): Promise<{ ok: true; appliedTaskCount: number } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data: dpr, error: dprErr } = await auth.supabase
    .from("dprs")
    .select("id, project_id, status, report_date")
    .eq("id", dprId)
    .maybeSingle();
  if (dprErr) return { ok: false, error: dprErr.message };
  if (!dpr) return { ok: false, error: "DPR not found" };
  if (dpr.status === "approved") {
    return { ok: false, error: "DPR is already approved" };
  }
  if (dpr.project_id !== projectId) {
    return { ok: false, error: "DPR does not belong to this project" };
  }

  // Pull task updates
  const { data: updates, error: upErr } = await auth.supabase
    .from("dpr_task_updates")
    .select("schedule_task_id, new_status, new_pct_complete, installed_quantity")
    .eq("dpr_id", dprId);
  if (upErr) return { ok: false, error: upErr.message };

  const now = new Date().toISOString();
  let applied = 0;
  for (const u of updates ?? []) {
    const patch: TablesUpdate<"schedule_tasks"> = {
      status_source: "dpr",
      last_dpr_at: now,
    };
    if (u.new_status) patch.status = u.new_status;
    if (u.new_pct_complete != null) patch.pct_complete = u.new_pct_complete;
    if (u.installed_quantity != null) patch.installed_quantity = u.installed_quantity;
    const { error: tErr } = await auth.supabase
      .from("schedule_tasks")
      .update(patch)
      .eq("id", u.schedule_task_id);
    if (tErr) {
      return {
        ok: false,
        error: `Failed to apply update to task ${u.schedule_task_id}: ${tErr.message}`,
      };
    }
    applied += 1;
  }

  const { error: stampErr } = await auth.supabase
    .from("dprs")
    .update({
      status: "approved",
      reviewed_by: auth.userId,
      reviewed_at: now,
      review_notes: reviewNotes?.trim() || null,
    })
    .eq("id", dprId);
  if (stampErr) return { ok: false, error: stampErr.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/dprs`);
  revalidatePath(`/projects/${projectId}/dprs/${dprId}`);
  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}/costs`);
  return { ok: true, appliedTaskCount: applied };
}

export async function returnDpr(
  dprId: string,
  projectId: string,
  reviewNotes: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  if (!reviewNotes?.trim())
    return { ok: false, error: "Review notes required to return a DPR" };
  const { error } = await auth.supabase
    .from("dprs")
    .update({
      status: "returned",
      reviewed_by: auth.userId,
      reviewed_at: new Date().toISOString(),
      review_notes: reviewNotes.trim(),
    })
    .eq("id", dprId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}/dprs`);
  revalidatePath(`/projects/${projectId}/dprs/${dprId}`);
  return { ok: true };
}
