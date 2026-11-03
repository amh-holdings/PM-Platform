"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  CATALOG_BY_KEY,
  DELIVERABLE_STATES,
  EXHIBIT_S,
  REVIEW_DECISIONS,
  deviceIdProblem,
  stateForDecision,
  type DeliverableState,
  type ReviewDecision,
} from "@/lib/exhibit-s";

export type DeliverableResult = { ok: true; note?: string } | { ok: false; error: string };

function friendly(message: string): string {
  if (/project_deliverables|spv_name/i.test(message) && /does not exist|could not find/i.test(message)) {
    return "The Exhibit S checklist is not in the database yet. Run migration 0086 in the Supabase SQL Editor.";
  }
  if (/project_deliverable_revisions/i.test(message) && /does not exist|could not find/i.test(message)) {
    return "Revisions are not in the database yet. Run migration 0087 in the Supabase SQL Editor.";
  }
  if (/duplicate key|project_deliverables_once/i.test(message)) return "That one is already on the list.";
  return message;
}

async function signedIn() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user ? { supabase, userId: user.id } : null;
}

const done = (projectId: string) => revalidatePath(`/projects/${projectId}/deliverables`);

type Db = ReturnType<typeof createClient>;

/** The next number in a recurring report's series. Assigned once, never recomputed. */
async function nextControlNo(db: Db, projectId: string, catalogKey: string): Promise<number> {
  const { data } = await db
    .from("project_deliverables")
    .select("control_no")
    .eq("project_id", projectId)
    .eq("catalog_key", catalogKey)
    .not("control_no", "is", null)
    .order("control_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.control_no ?? 0) + 1;
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Put every Exhibit S item on the project. Safe to press twice: an item
 * already there is left alone. Per-device items start with no device and are
 * added one device at a time.
 */
export async function loadExhibitS(projectId: string): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  const rows = EXHIBIT_S.filter((c) => !c.perDevice).map((c) => ({
    project_id: projectId,
    catalog_key: c.key,
    device_id: "",
    updated_by: auth.userId,
  }));
  const { error } = await auth.supabase
    .from("project_deliverables")
    .upsert(rows, { onConflict: "project_id,catalog_key,device_id", ignoreDuplicates: true });
  if (error) return { ok: false, error: friendly(error.message) };
  done(projectId);
  return { ok: true, note: `${rows.length} Exhibit S items on the list.` };
}

/** One file per device: add the next inverter, transformer, road. */
export async function addDeliverableDevice(
  projectId: string,
  catalogKey: string,
  deviceId: string,
): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  const item = CATALOG_BY_KEY.get(catalogKey);
  if (!item?.perDevice) return { ok: false, error: "That item isn't per device." };
  const problem = deviceIdProblem(item.perDevice, deviceId);
  if (problem) return { ok: false, error: problem };
  // A recurring report takes the next number, and its report date as its
  // doc date until somebody changes it.
  const period = item.perDevice === "period";
  const { error } = await auth.supabase.from("project_deliverables").insert({
    project_id: projectId,
    catalog_key: catalogKey,
    device_id: deviceId.trim(),
    control_no: period ? await nextControlNo(auth.supabase, projectId, catalogKey) : null,
    version_date: period ? deviceId.trim() : null,
    updated_by: auth.userId,
  });
  if (error) return { ok: false, error: friendly(error.message) };
  done(projectId);
  return { ok: true };
}

export type DeliverablePatch = {
  state?: DeliverableState;
  versionDate?: string | null;
  fileUrl?: string | null;
  notes?: string | null;
};

export async function updateDeliverable(
  projectId: string,
  id: string,
  patch: DeliverablePatch,
): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  const update: Record<string, unknown> = { updated_by: auth.userId, updated_at: new Date().toISOString() };
  const { data: current } = await auth.supabase
    .from("project_deliverables")
    .select("catalog_key, control_no, notes")
    .eq("id", id)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!current) return { ok: false, error: "Deliverable not found" };
  if (patch.state !== undefined) {
    if (!DELIVERABLE_STATES.includes(patch.state)) return { ok: false, error: "Unknown status" };
    // A missed report needs its reason; that is the whole point of marking it.
    if (patch.state === "missed" && !(patch.notes ?? current.notes ?? "").trim()) {
      return { ok: false, error: "Write the reason this one was missed in the note first." };
    }
    // A missed week that later goes in after all becomes a numbered report.
    const period = CATALOG_BY_KEY.get(current.catalog_key)?.perDevice === "period";
    if (period && current.control_no == null && patch.state !== "missed" && patch.state !== "not_applicable") {
      update.control_no = await nextControlNo(auth.supabase, projectId, current.catalog_key);
    }
    update.state = patch.state;
    // Uploaded records the day; going back to not started clears it.
    if (patch.state === "submitted") update.submitted_on = new Date().toISOString().slice(0, 10);
    if (patch.state === "not_started" || patch.state === "in_progress") update.submitted_on = null;
  }
  if (patch.versionDate !== undefined) {
    if (patch.versionDate && !ISO.test(patch.versionDate)) return { ok: false, error: "Pick a valid date" };
    update.version_date = patch.versionDate || null;
  }
  if (patch.fileUrl !== undefined) update.file_url = patch.fileUrl?.trim() || null;
  if (patch.notes !== undefined) update.notes = patch.notes?.trim() || null;
  const { error } = await auth.supabase
    .from("project_deliverables")
    .update(update as never)
    .eq("id", id)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: friendly(error.message) };
  done(projectId);
  return { ok: true };
}

/** A week with no report: record it as missed, with the reason. */
export async function recordMissedPeriod(
  projectId: string,
  catalogKey: string,
  date: string,
  reason: string,
): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  if (CATALOG_BY_KEY.get(catalogKey)?.perDevice !== "period") return { ok: false, error: "Not a recurring report." };
  if (!ISO.test(date)) return { ok: false, error: "Pick the week" };
  if (!reason.trim()) return { ok: false, error: "Write the reason this week was missed." };
  const { error } = await auth.supabase.from("project_deliverables").insert({
    project_id: projectId,
    catalog_key: catalogKey,
    device_id: date,
    state: "missed",
    notes: reason.trim(),
    updated_by: auth.userId,
  });
  if (error) return { ok: false, error: friendly(error.message) };
  done(projectId);
  return { ok: true };
}

export async function removeDeliverableDevice(projectId: string, id: string): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  // Only device rows come off. The catalog items themselves stay; mark one
  // N/A instead, so the checklist always shows the whole exhibit.
  const { error } = await auth.supabase
    .from("project_deliverables")
    .delete()
    .eq("id", id)
    .eq("project_id", projectId)
    .neq("device_id", "");
  if (error) return { ok: false, error: friendly(error.message) };
  done(projectId);
  return { ok: true };
}

/** The Project SPV name every file name starts with. */
export async function setSpvName(projectId: string, spvName: string): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  const name = spvName.trim();
  if (!name) return { ok: false, error: "Enter the Project SPV name" };
  const { error } = await auth.supabase.from("projects").update({ spv_name: name }).eq("id", projectId);
  if (error) return { ok: false, error: friendly(error.message) };
  done(projectId);
  return { ok: true };
}

// --------------------------------- revisions ---------------------------------

/**
 * Log a submission: Rev 0 the first time, the next rev number after that.
 * The item goes to Uploaded, since a new revision is waiting on review.
 */
export async function addRevision(
  projectId: string,
  deliverableId: string,
  input: { versionDate: string; notes?: string | null },
): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  if (!ISO.test(input.versionDate)) return { ok: false, error: "Pick the document date" };
  const { data: owner } = await auth.supabase
    .from("project_deliverables").select("id").eq("id", deliverableId).eq("project_id", projectId).maybeSingle();
  if (!owner) return { ok: false, error: "Deliverable not found" };
  const { data: last } = await auth.supabase
    .from("project_deliverable_revisions")
    .select("rev_no")
    .eq("deliverable_id", deliverableId)
    .order("rev_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await auth.supabase.from("project_deliverable_revisions").insert({
    deliverable_id: deliverableId,
    rev_no: last ? last.rev_no + 1 : 0,
    version_date: input.versionDate,
    submitted_on: today,
    notes: input.notes?.trim() || null,
    created_by: auth.userId,
  });
  if (error) return { ok: false, error: friendly(error.message) };
  await auth.supabase.from("project_deliverables").update({
    state: "submitted", submitted_on: today, version_date: input.versionDate,
    updated_by: auth.userId, updated_at: new Date().toISOString(),
  }).eq("id", deliverableId);
  done(projectId);
  return { ok: true };
}

/** Record the reviewer's answer on a revision, and on the item if it is the latest. */
export async function setRevisionDecision(
  projectId: string,
  revisionId: string,
  decision: ReviewDecision,
): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  if (!REVIEW_DECISIONS.includes(decision)) return { ok: false, error: "Unknown decision" };
  const { data: rev } = await auth.supabase
    .from("project_deliverable_revisions").select("id, deliverable_id, rev_no").eq("id", revisionId).maybeSingle();
  if (!rev) return { ok: false, error: "Revision not found" };
  const { data: owner } = await auth.supabase
    .from("project_deliverables").select("id").eq("id", rev.deliverable_id).eq("project_id", projectId).maybeSingle();
  if (!owner) return { ok: false, error: "Deliverable not found" };
  const { error } = await auth.supabase.from("project_deliverable_revisions").update({
    decision,
    decided_on: decision === "submitted" ? null : new Date().toISOString().slice(0, 10),
  }).eq("id", revisionId);
  if (error) return { ok: false, error: friendly(error.message) };
  const { data: latest } = await auth.supabase
    .from("project_deliverable_revisions").select("rev_no").eq("deliverable_id", rev.deliverable_id)
    .order("rev_no", { ascending: false }).limit(1).maybeSingle();
  if (latest?.rev_no === rev.rev_no) {
    await auth.supabase.from("project_deliverables").update({
      state: stateForDecision(decision), updated_by: auth.userId, updated_at: new Date().toISOString(),
    }).eq("id", rev.deliverable_id);
  }
  done(projectId);
  return { ok: true };
}
