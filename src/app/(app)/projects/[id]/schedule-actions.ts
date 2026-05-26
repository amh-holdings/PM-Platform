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
  return { ok: true as const, supabase };
}

export type ScheduleTaskResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

function getStr(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function getDate(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value;
}

function getInt(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

export async function updateScheduleTask(
  taskId: string,
  projectId: string,
  formData: FormData,
): Promise<ScheduleTaskResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const update: TablesUpdate<"schedule_tasks"> = {
    task_name: getStr(formData.get("task_name")) ?? undefined,
    description: getStr(formData.get("description")),
    phase: getStr(formData.get("phase")),
    assigned_to: getStr(formData.get("assigned_to")),
    status: getStr(formData.get("status")),
    duration_days: getInt(formData.get("duration_days")),
    start_date: getDate(formData.get("start_date")),
    end_date: getDate(formData.get("end_date")),
    predecessors: getStr(formData.get("predecessors")),
    is_at_risk: formData.get("is_at_risk") === "on",
    is_internal: formData.get("is_internal") === "on",
    non_ahc_delay: formData.get("non_ahc_delay") === "on",
  };

  const { error } = await auth.supabase
    .from("schedule_tasks")
    .update(update)
    .eq("id", taskId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

export async function deleteScheduleTask(
  taskId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("schedule_tasks")
    .delete()
    .eq("id", taskId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}
