"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

// CM-log photos live in the shared private DPR bucket (see the uploader).
const CM_LOG_PHOTO_BUCKET = "dpr-photos";

// The CM Daily Log is the Construction Manager's own record - only AHC-team
// members (the effective "CM"/"full" roles) may write it. Subs never touch it.
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

export type CmLogPhotoInput = {
  storagePath: string;
  caption: string | null;
};

export type CmLogInput = {
  projectId: string;
  logDate: string;
  weatherConditions: string | null;
  tempHigh: number | null;
  tempLow: number | null;
  siteConditions: string | null;
  progressSummary: string | null;
  safetyNotes: string | null;
  photos?: CmLogPhotoInput[];
};

export type CmLogResult =
  | { ok: true; logId: string }
  | { ok: false; error: string };

export async function createCmLog(input: CmLogInput): Promise<CmLogResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!input.logDate) return { ok: false, error: "Pick a date for the log" };

  const { data: log, error } = await auth.supabase
    .from("cm_daily_logs")
    .insert({
      project_id: input.projectId,
      author_id: auth.userId,
      log_date: input.logDate,
      weather_conditions: input.weatherConditions,
      temp_high: input.tempHigh,
      temp_low: input.tempLow,
      site_conditions: input.siteConditions,
      progress_summary: input.progressSummary,
      safety_notes: input.safetyNotes,
    })
    .select("id")
    .single();

  if (error || !log) {
    // The unique (project_id, log_date) constraint means one log per day.
    if (error?.code === "23505") {
      return {
        ok: false,
        error: "A daily log already exists for that date.",
      };
    }
    return { ok: false, error: error?.message ?? "Could not save the log" };
  }

  // Photos were uploaded by the client to dpr-photos/{projectId}/_drafts/...;
  // record the metadata rows pointing at those paths. The blob stays put (same
  // approach as the DPR uploader).
  if (input.photos && input.photos.length > 0) {
    const rows = input.photos.map((p) => ({
      cm_daily_log_id: log.id,
      storage_path: p.storagePath,
      caption: p.caption,
      uploaded_by: auth.userId,
    }));
    const { error: photoError } = await auth.supabase
      .from("cm_daily_log_photos")
      .insert(rows);
    if (photoError) {
      return { ok: false, error: `Photos failed: ${photoError.message}` };
    }
  }

  revalidatePath(`/projects/${input.projectId}/cm-log`);
  return { ok: true, logId: log.id };
}

export type CmLogUpdateInput = {
  logId: string;
  projectId: string;
  logDate: string;
  weatherConditions: string | null;
  tempHigh: number | null;
  tempLow: number | null;
  siteConditions: string | null;
  progressSummary: string | null;
  safetyNotes: string | null;
  // Photos staged (uploaded to storage) by the client since the last save.
  newPhotos?: CmLogPhotoInput[];
  // Existing photo rows the CM removed in this edit.
  removedPhotoIds?: string[];
  // Caption edits on existing photo rows.
  photoCaptions?: { id: string; caption: string | null }[];
};

// Load a log and confirm it belongs to the project. Returns the row (with
// status) or an error - the caller decides whether a given status is writable.
async function loadOwnedLog(
  supabase: ReturnType<typeof createClient>,
  logId: string,
  projectId: string,
) {
  const { data: log } = await supabase
    .from("cm_daily_logs")
    .select("id, status")
    .eq("id", logId)
    .eq("project_id", projectId)
    .maybeSingle();
  return log;
}

// Edit an existing draft log: fields, plus adding/removing/re-captioning photos.
// A finalized log is locked - it must be reopened first.
export async function updateCmLog(
  input: CmLogUpdateInput,
): Promise<CmLogResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!input.logDate) return { ok: false, error: "Pick a date for the log" };

  const log = await loadOwnedLog(auth.supabase, input.logId, input.projectId);
  if (!log) return { ok: false, error: "Log not found" };
  if (log.status === "final") {
    return {
      ok: false,
      error: "This log is finalized. Reopen it before editing.",
    };
  }

  const { error: updateError } = await auth.supabase
    .from("cm_daily_logs")
    .update({
      log_date: input.logDate,
      weather_conditions: input.weatherConditions,
      temp_high: input.tempHigh,
      temp_low: input.tempLow,
      site_conditions: input.siteConditions,
      progress_summary: input.progressSummary,
      safety_notes: input.safetyNotes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", log.id);

  if (updateError) {
    if (updateError.code === "23505") {
      return { ok: false, error: "A daily log already exists for that date." };
    }
    return { ok: false, error: updateError.message };
  }

  // Remove photos the CM deleted: drop the blobs, then the metadata rows.
  if (input.removedPhotoIds && input.removedPhotoIds.length > 0) {
    const { data: toRemove } = await auth.supabase
      .from("cm_daily_log_photos")
      .select("id, storage_path")
      .eq("cm_daily_log_id", log.id)
      .in("id", input.removedPhotoIds);
    const paths = (toRemove ?? []).map((r) => r.storage_path);
    if (paths.length > 0) {
      await auth.supabase.storage.from(CM_LOG_PHOTO_BUCKET).remove(paths);
      const { error: delError } = await auth.supabase
        .from("cm_daily_log_photos")
        .delete()
        .eq("cm_daily_log_id", log.id)
        .in("id", input.removedPhotoIds);
      if (delError) {
        return { ok: false, error: `Removing photos failed: ${delError.message}` };
      }
    }
  }

  // Caption edits on photos that are staying.
  if (input.photoCaptions && input.photoCaptions.length > 0) {
    for (const c of input.photoCaptions) {
      const { error: capError } = await auth.supabase
        .from("cm_daily_log_photos")
        .update({ caption: c.caption })
        .eq("id", c.id)
        .eq("cm_daily_log_id", log.id);
      if (capError) {
        return { ok: false, error: `Updating a caption failed: ${capError.message}` };
      }
    }
  }

  // Add newly staged photos.
  if (input.newPhotos && input.newPhotos.length > 0) {
    const rows = input.newPhotos.map((p) => ({
      cm_daily_log_id: log.id,
      storage_path: p.storagePath,
      caption: p.caption,
      uploaded_by: auth.userId,
    }));
    const { error: photoError } = await auth.supabase
      .from("cm_daily_log_photos")
      .insert(rows);
    if (photoError) {
      return { ok: false, error: `Photos failed: ${photoError.message}` };
    }
  }

  revalidatePath(`/projects/${input.projectId}/cm-log`);
  revalidatePath(`/projects/${input.projectId}/cm-log/${log.id}`);
  return { ok: true, logId: log.id };
}

// Lock a draft log as the day's official record.
export async function finalizeCmLog(
  logId: string,
  projectId: string,
): Promise<CmLogResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const log = await loadOwnedLog(auth.supabase, logId, projectId);
  if (!log) return { ok: false, error: "Log not found" };

  const now = new Date().toISOString();
  const { error } = await auth.supabase
    .from("cm_daily_logs")
    .update({ status: "final", finalized_at: now, updated_at: now })
    .eq("id", log.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/cm-log`);
  revalidatePath(`/projects/${projectId}/cm-log/${log.id}`);
  return { ok: true, logId: log.id };
}

// Reopen a finalized log so it can be edited again.
export async function reopenCmLog(
  logId: string,
  projectId: string,
): Promise<CmLogResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return { ok: false, error: auth.error };

  const log = await loadOwnedLog(auth.supabase, logId, projectId);
  if (!log) return { ok: false, error: "Log not found" };

  const { error } = await auth.supabase
    .from("cm_daily_logs")
    .update({ status: "draft", finalized_at: null, updated_at: new Date().toISOString() })
    .eq("id", log.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/cm-log`);
  revalidatePath(`/projects/${projectId}/cm-log/${log.id}`);
  return { ok: true, logId: log.id };
}
