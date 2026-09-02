"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { proposeProductionForReport } from "@/lib/production-proposal-run";
import type { Database, TablesUpdate } from "@/lib/database.types";

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
  active?: boolean;
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
  // Set when this submit is FILING AN EXISTING DRAFT rather than creating a
  // report from scratch (migration 0039). The row already exists at
  // status='draft', so it is updated in place instead of inserted - inserting
  // would collide with the unique (project_id, subcontractor_id, report_date)
  // index, and deleting-then-inserting would lose the sub's whole day if the
  // insert then failed. The CALLER is responsible for having verified the
  // draft's ownership before passing it (see submitFieldReport).
  promoteDprId?: string | null;
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

  // The report's own fields, identical whether this is a fresh submit or a
  // draft being filed.
  const now = new Date().toISOString();
  const reportFields = {
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
    status: "submitted" as const,
    submitted_at: now,
  };

  let dpr: { id: string } | null = null;
  if (input.promoteDprId) {
    // Filing a draft. Runs through the service-role client for the same reason
    // resubmitFieldReportPin does: a signed-in sub's grants on dprs are not
    // dependable for UPDATE, and the ownership check has already happened in
    // the caller. draft_payload is cleared here - once the report is filed the
    // JSON copy is stale, and the table's CHECK constraint refuses to keep it
    // alongside a non-draft status.
    const admin = createAdminClient();
    const { data: promoted, error: promoteErr } = await admin
      .from("dprs")
      .update({ ...reportFields, draft_payload: null, updated_at: now })
      .eq("id", input.promoteDprId)
      .eq("project_id", input.projectId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();
    if (promoteErr) return { ok: false, error: promoteErr.message };
    if (!promoted) {
      // No row matched: it was filed by another device, or discarded.
      return {
        ok: false,
        error: "This report is no longer a draft - reload to see its status.",
      };
    }
    dpr = promoted;

    // A draft holds everything as JSON and owns no child rows, so there is
    // normally nothing to clear. Sweep anyway, so a retry after a half-failed
    // submit rewrites the children instead of doubling them.
    await Promise.all([
      admin.from("dpr_task_updates").delete().eq("dpr_id", dpr.id),
      admin.from("dpr_manpower").delete().eq("dpr_id", dpr.id),
      admin.from("dpr_equipment").delete().eq("dpr_id", dpr.id),
      admin.from("dpr_deliveries").delete().eq("dpr_id", dpr.id),
      admin.from("dpr_delays").delete().eq("dpr_id", dpr.id),
      admin.from("photos").delete().eq("dpr_id", dpr.id),
    ]);
  } else {
    const { data: created, error: insertErr } = await auth.supabase
      .from("dprs")
      .insert(reportFields)
      .select("id")
      .single();
    if (insertErr || !created) {
      return { ok: false, error: insertErr?.message ?? "Failed to create DPR" };
    }
    dpr = created;
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
        active: e.active ?? true,
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

  revalidatePath(`/projects/${input.projectId}`, "layout");
  revalidatePath(`/projects/${input.projectId}/dprs`);
  return { ok: true, dprId: dpr.id };
}

// AHC users approve a submitted DPR. This applies the proposed task changes
// to schedule_tasks, sets dprs.status='approved', and stamps last_dpr_at on
// each affected task so the dashboard can show recency.
//
// IT ALSO FILLS THE COMMODITY TRACKER, and it has to.
// There are two ways a Field Report reaches 'approved': the pin-by-pin review
// in field-report-actions.ts, and this one. Only that one filled the tracker,
// so any report approved from the DPR review screen produced NO commodity
// production at all - the day read as zero work to the owner's weekly report
// and to bill verification, with nothing on any screen saying why. Sweet
// Springs 2026-08-24 is exactly that: an approved report, a CM log describing
// basin construction, and a blank row.
//
// Approval is approval whichever button was pressed, so the same hook runs
// here. Both paths call the one shared implementation - a second catch-up rule
// would be a second source of truth for the owner's sheet.
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

  // Never throws and never rolls the approval back - a tracker fill is laid on
  // top of a decision that already stands. Same contract as the other path.
  const proposal = await proposeProductionForReport(
    createAdminClient() as unknown as SupabaseClient<Database>,
    { projectId, dprId },
  );
  if (proposal.error) console.error("[production-proposal]", dprId, proposal.error);

  revalidatePath(`/projects/${projectId}`, "layout");
  revalidatePath(`/projects/${projectId}/dprs`);
  revalidatePath(`/projects/${projectId}/dprs/${dprId}`);
  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}/costs`);
  revalidatePath(`/projects/${projectId}/reports/commodity-tracker`);
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
