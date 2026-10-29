"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { subBillingClient } from "@/lib/sub-billing-db";
import type { Json, TablesUpdate } from "@/lib/database.types";
import { todayIso } from "@/lib/schedule-calendar";
import {
  canDecide,
  planApply,
  planUndo,
  planAfpPaidApply,
  planAfpStatusApply,
  planComplianceApply,
  planUndoPayApp,
  readUndoData,
  type AfpRecord,
  type RecordPlan,
  type SubCompliance,
  type Decision,
  type TaskSnapshot,
  type UndoData,
} from "@/lib/email-updates";
import { syncSummaryStatuses } from "../schedule-summary-sync";

export type EmailUpdateResult = { ok: true; note?: string } | { ok: false; error: string };

type Supabase = ReturnType<typeof createClient>;

const TASK_COLUMNS =
  "id, project_id, task_name, task_type, status, pct_complete, start_date, end_date, status_source, date_constraint_type, date_constraint_date, wbs_code";

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
  if (row.target_table === "subcontractors" || row.target_table === "pay_applications") {
    return approveRecord(projectId, row, userId);
  }

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
  if (recorded.table === "sub_pay_apps") return undoPayApp(projectId, row.id, recorded.id, userId);
  if (recorded.table === "subcontractors" || recorded.table === "pay_applications") {
    return undoRecord(projectId, row.id, row.target_id, recorded, userId);
  }
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

/**
 * Take back a sub bill the sweep entered from email. Removing the bill takes
 * its lines and checks with it. Refused once anyone has acted on the bill.
 */
async function undoPayApp(
  projectId: string,
  updateId: string,
  appId: string,
  userId: string,
): Promise<EmailUpdateResult> {
  const db = subBillingClient();
  const { data: app } = await db
    .from("sub_pay_apps")
    .select("id, status, app_number, subcontractor_id")
    .eq("id", appId)
    .eq("project_id", projectId)
    .maybeSingle();
  const plan = planUndoPayApp(app);
  if (!plan.ok) return { ok: false, error: plan.reason };

  const supabase = createClient();
  if (
    !(await claim(supabase, updateId, "applied", {
      status: "undone",
      undone_by: userId,
      undone_at: new Date().toISOString(),
    }))
  ) {
    return { ok: false, error: "Someone else already undid this one." };
  }

  const { error } = await db
    .from("sub_pay_apps")
    .delete()
    .eq("id", appId)
    .in("status", ["received", "under_review"]);
  if (error) {
    await supabase
      .from("email_updates")
      .update({ status: "applied", undone_by: null, undone_at: null })
      .eq("id", updateId);
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${projectId}/sub-billing`);
  done(projectId, false);
  return { ok: true, note: `Removed application ${app!.app_number}.` };
}

// ---------------------------------------------------------------------------
// A sub's COI or W-9, or an AFP.
// ---------------------------------------------------------------------------

type EmailUpdateRow = { id: string; kind: string; project_id: string; target_id: string | null; payload: unknown };

const SUB_COLUMNS = "id, project_id, company_name, coi_status, w9_status";
const AFP_COLUMNS = "id, project_id, app_number, status, paid_at, notes, amount_due";

async function readRecord(
  supabase: Supabase,
  table: "subcontractors" | "pay_applications",
  id: string | null,
): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  const { data } =
    table === "subcontractors"
      ? await supabase.from("subcontractors").select(SUB_COLUMNS).eq("id", id).maybeSingle()
      : await supabase.from("pay_applications").select(AFP_COLUMNS).eq("id", id).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

function planRecord(row: EmailUpdateRow, record: Record<string, unknown> | null): RecordPlan {
  if (row.kind === "compliance_doc") return planComplianceApply(row, record as SubCompliance | null);
  if (row.kind === "afp_status") return planAfpStatusApply(row, record as AfpRecord | null, todayIso());
  if (row.kind === "afp_paid") return planAfpPaidApply(row, record as AfpRecord | null, todayIso());
  return { ok: false, reason: "Nothing to apply for this kind." };
}

async function writeRecord(
  supabase: Supabase,
  table: "subcontractors" | "pay_applications",
  id: string,
  patch: Record<string, unknown>,
  entryStatus?: string | null,
) {
  const { error } =
    table === "subcontractors"
      ? await supabase.from("subcontractors").update(patch as TablesUpdate<"subcontractors">).eq("id", id)
      : await supabase.from("pay_applications").update(patch as TablesUpdate<"pay_applications">).eq("id", id);
  if (error) return error;
  // Billing entries mirror their AFP's status, as setPayApplicationStatus does.
  if (table === "pay_applications" && entryStatus) {
    await supabase.from("billing_entries").update({ status: entryStatus }).eq("pay_application_id", id);
  }
  return null;
}

function recordPaths(projectId: string, table: "subcontractors" | "pay_applications", id: string) {
  if (table === "subcontractors") {
    revalidatePath(`/projects/${projectId}/subs`);
    revalidatePath(`/projects/${projectId}/sub-billing`);
  } else {
    revalidatePath(`/projects/${projectId}/pay-apps`);
    revalidatePath(`/projects/${projectId}/pay-apps/${id}`);
    revalidatePath(`/projects/${projectId}/billing`);
  }
}

async function approveRecord(projectId: string, row: EmailUpdateRow & { target_table: string | null }, userId: string): Promise<EmailUpdateResult> {
  const supabase = createClient();
  const table = row.target_table as "subcontractors" | "pay_applications";
  const plan = planRecord(row, await readRecord(supabase, table, row.target_id));
  if (!plan.ok) return { ok: false, error: plan.reason };

  const undo: UndoData = { table: plan.table, applied: plan.patch, restore: plan.undo };
  if (
    !(await claim(supabase, row.id, "proposed", {
      status: "applied",
      undo_data: undo as unknown as Json,
      decided_by: userId,
      decided_at: new Date().toISOString(),
    }))
  ) {
    return { ok: false, error: "Someone else already decided this one." };
  }
  const error = await writeRecord(supabase, plan.table, plan.id, plan.patch, plan.cascadeEntryStatus);
  if (error) {
    await supabase
      .from("email_updates")
      .update({ status: "proposed", undo_data: null, decided_by: null, decided_at: null })
      .eq("id", row.id);
    return { ok: false, error: error.message };
  }
  recordPaths(projectId, plan.table, plan.id);
  done(projectId, false);
  return { ok: true, note: "Applied." };
}

async function undoRecord(
  projectId: string,
  updateId: string,
  targetId: string | null,
  recorded: Extract<UndoData, { table: "subcontractors" | "pay_applications" }>,
  userId: string,
): Promise<EmailUpdateResult> {
  const supabase = createClient();
  const record = await readRecord(supabase, recorded.table, targetId);
  const plan = planUndo({
    applied: recorded.applied,
    undo: recorded.restore,
    task: record,
    noun: recorded.table === "subcontractors" ? "subcontractor" : "AFP",
  });
  if (!plan.ok) return { ok: false, error: plan.reason };
  if (
    !(await claim(supabase, updateId, "applied", {
      status: "undone",
      undone_by: userId,
      undone_at: new Date().toISOString(),
    }))
  ) {
    return { ok: false, error: "Someone else already undid this one." };
  }
  const restoredStatus = "status" in plan.patch ? (plan.patch.status as string | null) : null;
  const error = await writeRecord(supabase, recorded.table, targetId!, plan.patch, restoredStatus);
  if (error) {
    await supabase
      .from("email_updates")
      .update({ status: "applied", undone_by: null, undone_at: null })
      .eq("id", updateId);
    return { ok: false, error: error.message };
  }
  recordPaths(projectId, recorded.table, targetId!);
  done(projectId, false);
  return { ok: true, note: "Put back the way it was." };
}
