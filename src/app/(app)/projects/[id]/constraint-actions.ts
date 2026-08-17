"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  CONSTRAINT_CATEGORIES,
  CONSTRAINT_STATUSES,
  type ConstraintCategory,
  type ConstraintStatus,
} from "@/lib/schedule-constraints";

// Subs can raise a constraint but not clear one. The foreman is the first to
// know the pipe is not on site, and making him phone it in so somebody else
// types it is how constraints go unlogged. Clearing is a decision, and it
// stays with AHC.
const RAISE_ROLES = ["phil", "zarina", "ahc_super", "sub_pm", "sub_foreman"];
const MANAGE_ROLES = ["phil", "zarina", "ahc_super"];

async function assertRole(allowed: string[]) {
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
  if (!profile || !allowed.includes(profile.role)) {
    return { ok: false as const, error: "Not permitted" };
  }
  return { ok: true as const, supabase, userId: user.id, role: profile.role };
}

export type ConstraintResult =
  | { ok: true; id?: string }
  | { ok: false; error: string };

function str(v: FormDataEntryValue | null): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  return v.trim();
}

export async function createConstraint(
  projectId: string,
  formData: FormData,
): Promise<ConstraintResult> {
  const auth = await assertRole(RAISE_ROLES);
  if (!auth.ok) return auth;

  const title = str(formData.get("title"));
  if (!title) return { ok: false, error: "A constraint needs a title." };

  const category = str(formData.get("category")) as ConstraintCategory | null;
  if (!category || !CONSTRAINT_CATEGORIES.includes(category)) {
    return { ok: false, error: "Pick a category." };
  }

  const { data, error } = await auth.supabase
    .from("schedule_constraints")
    .insert({
      project_id: projectId,
      wbs_code: str(formData.get("wbs_code")),
      category,
      title,
      description: str(formData.get("description")),
      owner: str(formData.get("owner")),
      need_by: str(formData.get("need_by")),
      // A sub can only raise it open, which the RLS policy also enforces.
      status: "open",
      source: "manual",
      created_by: auth.userId,
    })
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true, id: (data as { id?: string } | null)?.id };
}

export async function updateConstraint(
  projectId: string,
  constraintId: string,
  formData: FormData,
): Promise<ConstraintResult> {
  const auth = await assertRole(MANAGE_ROLES);
  if (!auth.ok) return auth;

  const category = str(formData.get("category")) as ConstraintCategory | null;
  if (category && !CONSTRAINT_CATEGORIES.includes(category)) {
    return { ok: false, error: "Unknown category." };
  }

  const { error } = await auth.supabase
    .from("schedule_constraints")
    .update({
      wbs_code: str(formData.get("wbs_code")),
      category: category ?? undefined,
      title: str(formData.get("title")) ?? undefined,
      description: str(formData.get("description")),
      owner: str(formData.get("owner")),
      need_by: str(formData.get("need_by")),
      updated_at: new Date().toISOString(),
    })
    .eq("id", constraintId)
    .eq("project_id", projectId);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

// Status changes are separate from edits because they are the thing that
// actually happens day to day: somebody clears a constraint, or accepts that
// it will not clear and the plan has to change instead. A resolution note is
// required to close one - "cleared" with no explanation tells the next person
// nothing and is worthless in a look-back.
export async function setConstraintStatus(
  projectId: string,
  constraintId: string,
  status: ConstraintStatus,
  resolution: string | null,
): Promise<ConstraintResult> {
  const auth = await assertRole(MANAGE_ROLES);
  if (!auth.ok) return auth;

  if (!CONSTRAINT_STATUSES.includes(status)) {
    return { ok: false, error: "Unknown status." };
  }
  const closing = status === "cleared" || status === "wont_clear";
  if (closing && !resolution?.trim()) {
    return {
      ok: false,
      error: "Say how it was resolved. A constraint closed with no note is not a record of anything.",
    };
  }

  const { error } = await auth.supabase
    .from("schedule_constraints")
    .update({
      status,
      resolution: resolution?.trim() || null,
      cleared_at: closing ? new Date().toISOString() : null,
      cleared_by: closing ? auth.userId : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", constraintId)
    .eq("project_id", projectId);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

export async function deleteConstraint(
  projectId: string,
  constraintId: string,
): Promise<ConstraintResult> {
  const auth = await assertRole(MANAGE_ROLES);
  if (!auth.ok) return auth;

  const { error } = await auth.supabase
    .from("schedule_constraints")
    .delete()
    .eq("id", constraintId)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}
