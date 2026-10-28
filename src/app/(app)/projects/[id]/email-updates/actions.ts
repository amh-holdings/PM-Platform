"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/lib/database.types";
import { todayIso } from "@/lib/schedule-calendar";
import {
  canDecide,
  planApply,
  planUndo,
  readUndoData,
  type Decision,
  type TaskSnapshot,
  type UndoData,
} from "@/lib/email-updates";
import { syncSummaryStatuses } from "../schedule-summary-sync";

export type EmailUpdateResult = { ok: true; note?: string } | { ok: false; error: string };

type Supabase = ReturnType<typeof createClient>;

const TASK_COLUMNS =
  "id, project_id, task_name, task_type, status, pct_complete, end_date, status_source, date_constraint_type, date_constraint_date, wbs_code";

async function loadForDecision(projectId: string, updateId: string, decision: Decision) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const { data: row, error } = await supabase
    .from("email_updates")
    .select("*")
    .eq("id", updateId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) return { ok: false as const, error: error.message };
  if (!row) return { ok: false as const, error: "Update not found" };

  const allowed = canDecide(row, profile?.role, decision);
  if (!allowed.ok) return { ok: false as const, error: allowed.reason };
  return { ok: true as const, supabase, userId: user.id, row };
}

async function readTask(
  supabase: Supabase,
  taskId: string | null,
): Promise<{ task: (TaskSnapshot & { wbs_code: string }) | null; hasChildren: boolean }> {
  if (!taskId) return { task: null, hasChildren: false };
  const { data } = await supabase
    .from("schedule_tasks")
    .select(TASK_COLUMNS)
    .eq("id", taskId)
    .maybeSingle();
  const task = data as (TaskSnapshot & { wbs_code: string }) | null;
  if (!task) return { task: null, hasChildren: false };
  // By WBS prefix, the same way the schedule grid decides a summary row.
  const { count } = await supabase
    .from("schedule_tasks")
    .select("id", { count: "exact", head: true })
    .eq("project_id", task.project_id)
    .like("wbs_code", `${task.wbs_code}.%`);
  return { task, hasChildren: (count ?? 0) > 0 };
}

/**
 * Move the row out of `from` before touching the record, so two people
 * clicking at once cannot both apply it. Returns false when someone else got
 * there first.
 */
async function claim(
  supabase: Supabase,
  id: string,
  from: string,
  patch: TablesUpdate<"email_updates">,
): Promise<boolean> {
  const { data } = await supabase
    .from("email_updates")
    .update(patch)
    .eq("id", id)
    .eq("status", from)
    .select("id");
  return (data ?? []).length === 1;
}

function done(projectId: string, touchedSchedule: boolean) {
  revalidatePath(`/projects/${projectId}/email-updates`);
  revalidatePath(`/projects/${projectId}`, "layout");
  if (touchedSchedule) revalidatePath(`/projects/${projectId}/schedule`);
}

export async function approveEmailUpdate(
  projectId: string,
  updateId: string,
): Promise<EmailUpdateResult> {
  const auth = await loadForDecision(projectId, updateId, "approve");
  if (!auth.ok) return auth;
  const { supabase, row, userId } = auth;

  const { task, hasChildren } = await readTask(supabase, row.target_id);
  const plan = planApply({ row, task, hasChildren, today: todayIso() });
  if (!plan.ok) return { ok: false, error: plan.reason };

  const decided = { decided_by: userId, decided_at: new Date().toISOString() };

  if (plan.table === null) {
    // No applier for this kind yet: approval records that it was handled.
    if (!(await claim(supabase, row.id, "proposed", { status: "approved", ...decided }))) {
      return { ok: false, error: "Someone else already decided this one." };
    }
    done(projectId, false);
    return { ok: true, note: "Marked approved. Nothing was changed in the app for this kind." };
  }

  const undo: UndoData = { table: plan.table, applied: plan.patch, restore: plan.undo };
  if (
    !(await claim(supabase, row.id, "proposed", {
      status: "applied",
      undo_data: undo,
      ...decided,
    }))
  ) {
    return { ok: false, error: "Someone else already decided this one." };
  }

  const { error } = await supabase
    .from("schedule_tasks")
    .update(plan.patch as TablesUpdate<"schedule_tasks">)
    .eq("id", plan.id);
  if (error) {
    // Put the row back so it can be tried again, rather than reading applied
    // while the task never changed.
    await supabase
      .from("email_updates")
      .update({ status: "proposed", undo_data: null, decided_by: null, decided_at: null })
      .eq("id", row.id);
    return { ok: false, error: error.message };
  }

  await syncSummaryStatuses(supabase, projectId);
  done(projectId, true);
  return { ok: true, note: `Applied to ${task?.task_name ?? "the task"}.` };
}

export async function rejectEmailUpdate(
  projectId: string,
  updateId: string,
  note: string | null,
): Promise<EmailUpdateResult> {
  const auth = await loadForDecision(projectId, updateId, "reject");
  if (!auth.ok) return auth;
  const ok = await claim(auth.supabase, auth.row.id, "proposed", {
    status: "rejected",
    decided_by: auth.userId,
    decided_at: new Date().toISOString(),
    decision_note: note?.trim() || null,
  });
  if (!ok) return { ok: false, error: "Someone else already decided this one." };
  done(projectId, false);
  return { ok: true };
}

export async function undoEmailUpdate(
  projectId: string,
  updateId: string,
): Promise<EmailUpdateResult> {
  const auth = await loadForDecision(projectId, updateId, "undo");
  if (!auth.ok) return auth;
  const { supabase, row, userId } = auth;

  const recorded = readUndoData(row.undo_data);
  if (!recorded) return { ok: false, error: "Nothing was recorded to undo." };
  const { task } = await readTask(supabase, row.target_id);
  const plan = planUndo({ applied: recorded.applied, undo: recorded.restore, task });
  if (!plan.ok) return { ok: false, error: plan.reason };

  if (
    !(await claim(supabase, row.id, "applied", {
      status: "undone",
      undone_by: userId,
      undone_at: new Date().toISOString(),
    }))
  ) {
    return { ok: false, error: "Someone else already undid this one." };
  }

  const { error } = await supabase
    .from("schedule_tasks")
    .update(plan.patch as TablesUpdate<"schedule_tasks">)
    .eq("id", row.target_id!);
  if (error) {
    await supabase
      .from("email_updates")
      .update({ status: "applied", undone_by: null, undone_at: null })
      .eq("id", row.id);
    return { ok: false, error: error.message };
  }

  await syncSummaryStatuses(supabase, projectId);
  done(projectId, true);
  return { ok: true, note: `Put ${task?.task_name ?? "the task"} back the way it was.` };
}
