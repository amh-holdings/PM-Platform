"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { DOCUMENT_BUCKET } from "./documents-constants";
import { legacyStatus, nextRfiNumber, projectRfiPrefix, rfiState } from "@/lib/rfi-log";

export type RfiActionResult = { ok: true; id: string } | { ok: false; error: string };

function missingTable(message: string): boolean {
  return /relation .*rfis.* does not exist|could not find the table/i.test(message);
}

function friendly(message: string): string {
  if (missingTable(message)) {
    return "The RFI log is not in the database yet. Run migration 0084 in the Supabase SQL Editor.";
  }
  if (/duplicate key|rfis_project_number_key/i.test(message)) {
    return "Two RFIs were logged at once and both took the same number. Try again.";
  }
  return message;
}

export type RfiInput = {
  projectId: string;
  subject: string;
  question: string;
  discipline?: string | null;
  wbsCode?: string | null;
  subcontractorId?: string | null;
  raisedBy?: string | null;
  eorFirm?: string | null;
  eorContact?: string | null;
  receivedAt: string;
  responseNeededBy?: string | null;
  costImpact?: boolean;
  scheduleImpact?: boolean;
  referenceDoc?: string | null;
  suggestedAnswer?: string | null;
  location?: string | null;
  priority?: string | null;
};

/**
 * The next number on this project.
 *
 * Assigned here rather than typed. Zarina: "you should be generating an RFI
 * number to track all RFIs" - and a number somebody types is a number two
 * people type the same on the same morning. The unique index catches that,
 * but the person who loses the race loses their typing with it.
 *
 * Still a read-then-write, so two at the exact same instant can still collide.
 * That is what the retry in createRfi is for: the index is the guarantee, this
 * is the common path.
 */
async function assignNumber(
  supabase: ReturnType<typeof createClient>,
  projectId: string,
): Promise<string> {
  const [{ data }, { data: project }] = await Promise.all([
    supabase.from("rfis").select("rfi_number").eq("project_id", projectId),
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
  ]);
  const used = (data ?? [])
    .map((r) => r.rfi_number)
    .filter((n): n is string => !!n);
  // The prefix only decides the FIRST number. After that nextRfiNumber carries
  // forward whatever the log already uses, so renaming a project never splits
  // an existing series.
  return nextRfiNumber(used, projectRfiPrefix(project?.name));
}

export async function createRfi(input: RfiInput): Promise<RfiActionResult> {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false, error: "Not authenticated" };

  if (!input.subject.trim()) return { ok: false, error: "Subject is required" };
  if (!input.question.trim()) return { ok: false, error: "The question is required" };

  const priority =
    input.priority === "High" || input.priority === "Low"
      ? input.priority
      : "Normal";

  // Two attempts. The second re-reads the numbers, so a race that took RFI-004
  // while we were typing lands on RFI-005 rather than failing in the person's
  // face over something they did not choose and cannot fix.
  for (let attempt = 0; attempt < 2; attempt++) {
    const rfiNumber = await assignNumber(supabase, input.projectId);

    const { data, error } = await supabase
      .from("rfis")
      .insert({
        project_id: input.projectId,
        rfi_number: rfiNumber,
        subject: input.subject.trim(),
        question: input.question.trim(),
        discipline: input.discipline?.trim() || null,
        wbs_code: input.wbsCode?.trim() || null,
        subcontractor_id: input.subcontractorId || null,
        raised_by: input.raisedBy?.trim() || null,
        eor_firm: input.eorFirm?.trim() || null,
        eor_contact: input.eorContact?.trim() || null,
        received_at: input.receivedAt,
        // The skeleton's own date, kept in step so the dashboard's stale-RFI
        // query keeps working without being rewritten.
        date_issued: input.receivedAt,
        date_needed: input.responseNeededBy || null,
        status: "open",
        cost_impact: input.costImpact ?? false,
        schedule_impact: input.scheduleImpact ?? false,
        reference_doc: input.referenceDoc?.trim() || null,
        suggested_answer: input.suggestedAnswer?.trim() || null,
        location: input.location?.trim() || null,
        priority,
        created_by_id: user.id,
      })
      .select("id")
      .single();

    if (!error) {
      revalidatePath(`/projects/${input.projectId}/rfis`);
      return { ok: true, id: data.id };
    }

    const taken = /duplicate key|rfis_project_number_key/i.test(error.message);
    if (!taken || attempt === 1) {
      return { ok: false, error: friendly(error.message) };
    }
  }

  return { ok: false, error: "Could not assign an RFI number" };
}

/**
 * Move an RFI along, by recording the date the thing happened.
 *
 * One action for all four steps rather than four, because they are the same
 * write and the state is derived from the dates. Passing null clears a step,
 * which is how a mis-click is undone - there is no other way back once a date
 * is set, and "I forwarded the wrong one" is a Tuesday.
 */
export type RfiStep = "sent_to_eor_at" | "answered_at" | "closed_at";

export async function setRfiStep(
  rfiId: string,
  projectId: string,
  step: RfiStep,
  date: string | null,
  answer?: string | null,
): Promise<RfiActionResult> {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false, error: "Not authenticated" };

  // Read the row first: the derived state needs all three dates, not just the
  // one being set, and `status` has to be written from the result.
  const { data: current, error: readError } = await supabase
    .from("rfis")
    .select("sent_to_eor_at, date_answered, closed_at")
    .eq("id", rfiId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (readError) return { ok: false, error: friendly(readError.message) };
  if (!current) return { ok: false, error: "RFI not found on this project" };

  const dates = {
    sent_to_eor_at: current.sent_to_eor_at,
    answered_at: current.date_answered,
    closed_at: current.closed_at,
  };
  dates[step] = date || null;

  // Spelled out rather than built from a computed key: a typed update refuses
  // an index signature, and a typo in a column name should fail here rather
  // than silently write nothing.
  const status = legacyStatus(rfiState(dates));
  const patch =
    step === "sent_to_eor_at"
      ? { sent_to_eor_at: date || null, status }
      : step === "closed_at"
        ? { closed_at: date || null, status }
        : {
            date_answered: date || null,
            status,
            ...(answer !== undefined
              ? { response: answer?.trim() || null }
              : {}),
          };

  const { data, error } = await supabase
    .from("rfis")
    .update(patch)
    .eq("id", rfiId)
    .eq("project_id", projectId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: friendly(error.message) };
  if (!data) return { ok: false, error: "RFI not found on this project" };

  revalidatePath(`/projects/${projectId}/rfis`);
  return { ok: true, id: data.id };
}

export type DeleteRfiResult = { ok: true } | { ok: false; error: string };

export async function deleteRfi(
  rfiId: string,
  projectId: string,
): Promise<DeleteRfiResult> {
  const supabase = createClient();
  const { error } = await supabase
    .from("rfis")
    .delete()
    .eq("id", rfiId)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: friendly(error.message) };
  revalidatePath(`/projects/${projectId}/rfis`);
  return { ok: true };
}

// ============ ATTACHMENTS ============
//
// Zarina: "add option where we can add photo or we can mark up from the plan
// sets". The file goes into project_documents like any other upload and
// carries rfi_id, so it is on the Documents page too rather than buried in
// the log. 0085 adds that column.

function missingAttachmentColumn(message: string): boolean {
  return /rfi_id/i.test(message) && /does not exist|schema cache/i.test(message);
}

function friendlyAttach(message: string): string {
  if (missingAttachmentColumn(message)) {
    return "Run migration 0085 in the Supabase SQL Editor to attach files to an RFI.";
  }
  return message;
}

export type AttachResult = { ok: true } | { ok: false; error: string };

/**
 * Point an existing document at an RFI.
 *
 * Both ids are checked against the project before the write. The client sends
 * them, and a client is a suggestion: without this, a document id from another
 * job would attach cleanly and show up on this one's log.
 */
export async function attachDocumentToRfi(
  projectId: string,
  rfiId: string,
  documentId: string,
): Promise<AttachResult> {
  const supabase = createClient();

  const { data: rfi, error: rfiError } = await supabase
    .from("rfis")
    .select("id")
    .eq("id", rfiId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (rfiError) return { ok: false, error: friendly(rfiError.message) };
  if (!rfi) return { ok: false, error: "That RFI is not on this project" };

  const { data, error } = await supabase
    .from("project_documents")
    .update({ rfi_id: rfiId })
    .eq("id", documentId)
    .eq("project_id", projectId)
    .select("id");

  if (error) return { ok: false, error: friendlyAttach(error.message) };
  if (!data || data.length === 0) {
    return { ok: false, error: "That file is not in this project's library" };
  }

  revalidatePath(`/projects/${projectId}/rfis`);
  revalidatePath(`/projects/${projectId}/documents`);
  return { ok: true };
}

/**
 * Unhook a document from its RFI. The file stays in the library - "this photo
 * is on the wrong RFI" is a different problem from "delete this photo", and
 * guessing wrong on that one loses the only picture of the condition.
 */
export async function detachDocumentFromRfi(
  projectId: string,
  documentId: string,
): Promise<AttachResult> {
  const supabase = createClient();

  const { error } = await supabase
    .from("project_documents")
    .update({ rfi_id: null })
    .eq("id", documentId)
    .eq("project_id", projectId);

  if (error) return { ok: false, error: friendlyAttach(error.message) };

  revalidatePath(`/projects/${projectId}/rfis`);
  revalidatePath(`/projects/${projectId}/documents`);
  return { ok: true };
}

export type AttachableDoc = {
  id: string;
  fileName: string;
  category: string;
  uploadedAt: string | null;
  mimeType: string | null;
};

export type AttachableResult =
  | { ok: true; enabled: boolean; documents: AttachableDoc[] }
  | { ok: false; error: string };

/**
 * What is already in the library and not yet on this RFI.
 *
 * The plan sets are the point: the sheet the question is about is usually
 * already uploaded, and re-uploading it to attach it would put a second copy
 * of a 40 MB drawing set in the bucket.
 */
export async function getAttachableRfiDocuments(
  projectId: string,
  rfiId: string,
): Promise<AttachableResult> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from("project_documents")
    .select("id, file_name, category, uploaded_at, mime_type, rfi_id")
    .eq("project_id", projectId)
    .order("uploaded_at", { ascending: false, nullsFirst: false });

  // 0085 not applied. The picker says so rather than offering to attach
  // something that cannot be saved.
  if (error && missingAttachmentColumn(error.message)) {
    return { ok: true, enabled: false, documents: [] };
  }
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    enabled: true,
    documents: (data ?? [])
      .filter((d) => d.rfi_id !== rfiId)
      .map((d) => ({
        id: d.id,
        fileName: d.file_name,
        category: d.category,
        uploadedAt: d.uploaded_at,
        mimeType: d.mime_type,
      })),
  };
}

export type MarkupSource =
  | { ok: true; url: string; fileName: string; mimeType: string | null }
  | { ok: false; error: string };

/**
 * A signed URL for one document, so the browser can render it to mark it up.
 *
 * Scoped to the project before signing. The bucket is private, and a signed
 * URL is a key: minting one from an id the client supplied without checking
 * which project it belongs to would hand out files from other jobs.
 */
export async function getDocumentForMarkup(
  projectId: string,
  documentId: string,
): Promise<MarkupSource> {
  const supabase = createClient();

  const { data: doc, error } = await supabase
    .from("project_documents")
    .select("file_name, mime_type, storage_path")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!doc) return { ok: false, error: "That file is not in this project's library" };

  const signed = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .createSignedUrl(doc.storage_path, 3600);

  if (signed.error || !signed.data?.signedUrl) {
    return { ok: false, error: signed.error?.message ?? "Could not open the file" };
  }

  return {
    ok: true,
    url: signed.data.signedUrl,
    fileName: doc.file_name,
    mimeType: doc.mime_type,
  };
}
