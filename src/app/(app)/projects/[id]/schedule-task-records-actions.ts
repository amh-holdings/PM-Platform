"use server";

// Server actions behind the task records popup.
//
// The read is an action rather than page data on purpose. Loading every task's
// photos at page load would mint hundreds of signed URLs that expire in an
// hour and that nobody opens; the grid gets counts at load and the records
// arrive when a row is actually opened.
//
// Everything here is read-only except the two document actions, and those
// write to the join table only. No action in this file can touch a percent, a
// date or a predecessor: progress still belongs to approved field reports and
// the schedule still belongs to the edit dialog.

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { loadTaskRecords } from "@/lib/schedule-task-records-load";
import type { TaskRecords } from "@/lib/schedule-task-records";

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

export type TaskRecordsResult =
  | { ok: true; records: TaskRecords }
  | { ok: false; error: string };

/**
 * Everything the platform knows about one task.
 *
 * `allTasks` is loaded here rather than passed in from the browser, because
 * the successor list has to be derived over every task on the PROJECT, not the
 * ones currently in scope. Filtering to Civil and then asking what Build
 * Basin 1 drives would silently omit any successor outside civil - the same
 * class of bug as the CPM running on the scope filter, which is already fixed
 * in the engine and would have come straight back here.
 */
export async function getTaskRecords(
  projectId: string,
  taskId: string,
): Promise<TaskRecordsResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { supabase } = auth;

  const { data: task, error } = await supabase
    .from("schedule_tasks")
    .select("id, wbs_code, task_name, predecessors, project_id")
    .eq("id", taskId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!task) return { ok: false, error: "That task is not on this project." };

  const { data: allTasks } = await supabase
    .from("schedule_tasks")
    .select("wbs_code, task_name, predecessors")
    .eq("project_id", projectId);

  try {
    const records = await loadTaskRecords(
      supabase,
      projectId,
      {
        id: task.id,
        wbs_code: task.wbs_code,
        task_name: task.task_name,
        predecessors: task.predecessors,
      },
      allTasks ?? [],
    );
    return { ok: true, records };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not load this task's records.",
    };
  }
}

export type AttachableDocument = {
  id: string;
  fileName: string;
  category: string;
  uploadedAt: string | null;
  sizeBytes: number | null;
};

export type AttachableResult =
  | { ok: true; documents: AttachableDocument[]; enabled: boolean }
  | { ok: false; error: string };

/**
 * The project's document library, minus what is already on this task.
 *
 * Not paginated. Sweet Springs has well under a hundred documents and the
 * picker filters client-side, which is faster than a round trip per keystroke.
 * If a project ever carries enough that this matters, the fix is a search
 * argument here rather than a scroll in the browser.
 */
export async function getAttachableDocuments(
  projectId: string,
  taskId: string,
): Promise<AttachableResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { supabase } = auth;

  const attached = await supabase
    .from("schedule_task_documents")
    .select("document_id")
    .eq("schedule_task_id", taskId);

  // 0069 not applied. The picker says so rather than offering to attach
  // something that cannot be saved.
  if (attached.error) return { ok: true, documents: [], enabled: false };

  const taken = new Set((attached.data ?? []).map((r) => r.document_id));

  const { data, error } = await supabase
    .from("project_documents")
    .select("id, file_name, category, uploaded_at, size_bytes")
    .eq("project_id", projectId)
    .order("uploaded_at", { ascending: false, nullsFirst: false });

  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    enabled: true,
    documents: (data ?? [])
      .filter((d) => !taken.has(d.id))
      .map((d) => ({
        id: d.id,
        fileName: d.file_name,
        category: d.category,
        uploadedAt: d.uploaded_at,
        sizeBytes: d.size_bytes,
      })),
  };
}

export type AttachResult = { ok: true } | { ok: false; error: string };

export async function attachDocumentToTask(
  projectId: string,
  taskId: string,
  documentId: string,
  note?: string | null,
): Promise<AttachResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { supabase, userId } = auth;

  // project_id is set authoritatively by the 0069 trigger, which also refuses
  // a task and a document from different projects. It is sent here because the
  // column is not null; the trigger overwrites whatever arrives.
  const { error } = await supabase.from("schedule_task_documents").insert({
    schedule_task_id: taskId,
    document_id: documentId,
    project_id: projectId,
    note: note?.trim() || null,
    created_by: userId,
  });

  if (error) {
    if (error.code === "23505" || /duplicate key/i.test(error.message)) {
      return { ok: false, error: "That document is already attached to this task." };
    }
    if (error.code === "42P01") {
      return {
        ok: false,
        error:
          "Attaching documents to a task needs migration 0069 run first. Everything else on this popup works without it.",
      };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}

export async function detachDocumentFromTask(
  projectId: string,
  linkId: string,
): Promise<AttachResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { supabase } = auth;

  // Deletes the LINK, never the document. The file stays in the library, which
  // is the whole reason this is a join table - detaching a drawing from one
  // task must not remove it from the eleven others it also covers, let alone
  // from the project.
  const { error } = await supabase
    .from("schedule_task_documents")
    .delete()
    .eq("id", linkId)
    .eq("project_id", projectId);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/schedule`);
  return { ok: true };
}
