"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

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
