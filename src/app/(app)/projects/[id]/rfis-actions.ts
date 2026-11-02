"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { legacyStatus, rfiState } from "@/lib/rfi-log";

export type RfiActionResult = { ok: true; id: string } | { ok: false; error: string };

function missingTable(message: string): boolean {
  return /relation .*rfis.* does not exist|could not find the table/i.test(message);
}

function friendly(message: string): string {
  if (missingTable(message)) {
    return "The RFI log is not in the database yet. Run migration 0084 in the Supabase SQL Editor.";
  }
  if (/duplicate key|rfis_project_id_rfi_number_key/i.test(message)) {
    return "That RFI number is already used on this project.";
  }
  return message;
}

export type RfiInput = {
  projectId: string;
  rfiNumber: string;
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
};

export async function createRfi(input: RfiInput): Promise<RfiActionResult> {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false, error: "Not authenticated" };

  if (!input.rfiNumber.trim()) return { ok: false, error: "RFI number is required" };
  if (!input.subject.trim()) return { ok: false, error: "Subject is required" };
  if (!input.question.trim()) return { ok: false, error: "The question is required" };

  const { data, error } = await supabase
    .from("rfis")
    .insert({
      project_id: input.projectId,
      rfi_number: input.rfiNumber.trim(),
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
      created_by_id: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: friendly(error.message) };

  revalidatePath(`/projects/${input.projectId}/rfis`);
  return { ok: true, id: data.id };
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
