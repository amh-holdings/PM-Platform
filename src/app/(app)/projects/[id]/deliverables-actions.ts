"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { driveConfigured, driveFolderName, folderIdFromLink, uploadPdfToDrive } from "@/lib/google-drive";
import { createClient } from "@/lib/supabase/server";
import { buildPackage, packageFileName } from "@/lib/submittal-package";
import {
  CATALOG_BY_KEY,
  DELIVERABLE_STATES,
  EXHIBIT_S,
  REVIEW_DECISIONS,
  TRANSMITTED_FOR,
  submittalNumber,
  deviceIdProblem,
  deliverableFileName,
  CATALOG_BY_KEY as CATALOG,
  stateForDecision,
  type DeliverableState,
  type ReviewDecision,
  type TransmittedFor,
} from "@/lib/exhibit-s";

import { DOCUMENT_BUCKET } from "./documents-constants";

export type DeliverableResult = { ok: true; note?: string; id?: string } | { ok: false; error: string };

function friendly(message: string): string {
  if (/project_deliverables|spv_name/i.test(message) && /does not exist|could not find/i.test(message)) {
    return "The Exhibit S checklist is not in the database yet. Run migration 0086 in the Supabase SQL Editor.";
  }
  if (/project_deliverable_revisions/i.test(message) && /does not exist|could not find/i.test(message)) {
    return "Revisions are not in the database yet. Run migration 0087 in the Supabase SQL Editor.";
  }
  if (/project_submittals|submittal_id|submittal_prefix/i.test(message) && /does not exist|could not find/i.test(message)) {
    return "Submittals are not in the database yet. Run migration 0093 in the Supabase SQL Editor.";
  }
  if (/document_id|package_document_id|drive_file_id|submittal_drive_folder_id/i.test(message) && /does not exist|could not find/i.test(message)) {
    return "Submittal packages are not in the database yet. Run migration 0094 in the Supabase SQL Editor.";
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
  const { data, error } = await auth.supabase.from("project_deliverables").insert({
    project_id: projectId,
    catalog_key: catalogKey,
    device_id: deviceId.trim(),
    control_no: period ? await nextControlNo(auth.supabase, projectId, catalogKey) : null,
    version_date: period ? deviceId.trim() : null,
    updated_by: auth.userId,
  }).select("id").single();
  if (error) return { ok: false, error: friendly(error.message) };
  done(projectId);
  return { ok: true, id: data.id };
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

// --------------------------------- submittals --------------------------------

export type SubmittalInput = {
  items: { deliverableId: string; versionDate: string; note?: string | null }[];
  submittedOn: string;
  transmittedFor: TransmittedFor;
  transmittedOther?: string | null;
  projectLabel?: string | null;
  toName?: string | null;
  fromName?: string | null;
  cc?: string | null;
  subject?: string | null;
  notes?: string | null;
  requestedResponseDate?: string | null;
};

// project_submittals and submittal_prefix arrive with 0093, after the
// generated types; this client is untyped for them.
const untyped = (db: Db) => db as unknown as SupabaseClient;

/**
 * Send one or more documents to the owner under one cover. The submittal
 * takes the project's next number; each document gets its next revision
 * (Rev 0 the first time), tied to this submittal, and goes to Uploaded.
 */
export async function createSubmittal(projectId: string, input: SubmittalInput): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  if (input.items.length === 0) return { ok: false, error: "Pick at least one document." };
  if (!ISO.test(input.submittedOn)) return { ok: false, error: "Pick the submittal date" };
  if (!TRANSMITTED_FOR.includes(input.transmittedFor)) return { ok: false, error: "Pick what it is transmitted for" };
  if (input.requestedResponseDate && !ISO.test(input.requestedResponseDate)) return { ok: false, error: "Pick a valid response date" };
  for (const it of input.items) if (!ISO.test(it.versionDate)) return { ok: false, error: "Every document needs a doc date" };
  const db = untyped(auth.supabase);

  const ids = input.items.map((i) => i.deliverableId);
  const { data: owned } = await auth.supabase
    .from("project_deliverables").select("id").eq("project_id", projectId).in("id", ids);
  if ((owned ?? []).length !== new Set(ids).size) return { ok: false, error: "A document is not on this project." };

  const clean = (v?: string | null) => v?.trim() || null;
  // The next number. Two people submitting at once collide on the unique
  // key; the second tries the number after.
  let submittal: { id: string; submittal_no: number } | null = null;
  for (let attempt = 0; attempt < 3 && !submittal; attempt++) {
    const { data: last, error: lastErr } = await db
      .from("project_submittals").select("submittal_no").eq("project_id", projectId)
      .order("submittal_no", { ascending: false }).limit(1).maybeSingle();
    if (lastErr) return { ok: false, error: friendly(lastErr.message) };
    const { data, error } = await db.from("project_submittals").insert({
      project_id: projectId,
      submittal_no: (last?.submittal_no ?? 0) + 1,
      submitted_on: input.submittedOn,
      transmitted_for: input.transmittedFor,
      transmitted_other: input.transmittedFor === "other" ? clean(input.transmittedOther) : null,
      project_label: clean(input.projectLabel),
      to_name: clean(input.toName),
      from_name: clean(input.fromName),
      cc: clean(input.cc),
      subject: clean(input.subject),
      notes: clean(input.notes),
      requested_response_date: input.requestedResponseDate || null,
      created_by: auth.userId,
    }).select("id, submittal_no").single();
    if (!error) submittal = data;
    else if (!/duplicate key/i.test(error.message)) return { ok: false, error: friendly(error.message) };
  }
  if (!submittal) return { ok: false, error: "Couldn't get a submittal number. Try again." };

  for (const it of input.items) {
    const { data: lastRev } = await auth.supabase
      .from("project_deliverable_revisions").select("rev_no").eq("deliverable_id", it.deliverableId)
      .order("rev_no", { ascending: false }).limit(1).maybeSingle();
    const { error } = await db.from("project_deliverable_revisions").insert({
      deliverable_id: it.deliverableId,
      rev_no: lastRev ? lastRev.rev_no + 1 : 0,
      version_date: it.versionDate,
      submitted_on: input.submittedOn,
      notes: clean(it.note),
      submittal_id: submittal.id,
      created_by: auth.userId,
    });
    if (error) return { ok: false, error: friendly(error.message) };
    await auth.supabase.from("project_deliverables").update({
      state: "submitted", submitted_on: input.submittedOn, version_date: it.versionDate,
      updated_by: auth.userId, updated_at: new Date().toISOString(),
    }).eq("id", it.deliverableId);
  }
  done(projectId);
  const { data: proj } = await db.from("projects").select("submittal_prefix").eq("id", projectId).maybeSingle();
  return { ok: true, id: submittal.id, note: submittalNumber(proj?.submittal_prefix, submittal.submittal_no) };
}

/** The letters in front of the submittal number, e.g. SUS. */
export async function setSubmittalPrefix(projectId: string, prefix: string): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  const p = prefix.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(p)) return { ok: false, error: "Use 1 to 8 letters or digits, e.g. SUS" };
  const { error } = await untyped(auth.supabase).from("projects").update({ submittal_prefix: p }).eq("id", projectId);
  if (error) return { ok: false, error: friendly(error.message) };
  done(projectId);
  return { ok: true };
}

// ------------------------------ submittal packages ----------------------------


/** Tie an uploaded PDF (a Documents row) to the document's revision on a submittal. */
export async function attachSubmittalFile(
  projectId: string,
  submittalId: string,
  deliverableId: string,
  documentId: string,
): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  const db = untyped(auth.supabase);
  const { data: sub } = await db.from("project_submittals").select("id").eq("id", submittalId).eq("project_id", projectId).maybeSingle();
  if (!sub) return { ok: false, error: "Submittal not found" };
  const { data: doc } = await auth.supabase
    .from("project_documents").select("id").eq("id", documentId).eq("project_id", projectId).maybeSingle();
  if (!doc) return { ok: false, error: "Upload not found" };
  const { error } = await db.from("project_deliverable_revisions")
    .update({ document_id: documentId }).eq("submittal_id", submittalId).eq("deliverable_id", deliverableId);
  if (error) return { ok: false, error: friendly(error.message) };
  done(projectId);
  return { ok: true };
}

const mdY = (iso: string | null | undefined) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
};

/**
 * Fill the cover, merge the documents behind it, keep the package on the
 * Documents page, and save it to the project's Drive folder as Phil when
 * Drive is set up. Building again replaces the previous package.
 */
export async function buildSubmittalPackage(projectId: string, submittalId: string): Promise<DeliverableResult & { url?: string; driveUrl?: string }> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  const db = untyped(auth.supabase);
  const { data: sub, error: subErr } = await db.from("project_submittals").select("*")
    .eq("id", submittalId).eq("project_id", projectId).maybeSingle();
  if (subErr) return { ok: false, error: friendly(subErr.message) };
  if (!sub) return { ok: false, error: "Submittal not found" };
  const { data: project } = await db.from("projects")
    .select("name, spv_name, submittal_prefix, submittal_drive_folder_id").eq("id", projectId).maybeSingle();
  const { data: revs, error: revErr } = await db.from("project_deliverable_revisions")
    .select("deliverable_id, rev_no, version_date, notes, document_id").eq("submittal_id", submittalId);
  if (revErr) return { ok: false, error: friendly(revErr.message) };
  if (!revs?.length) return { ok: false, error: "No documents on this submittal." };

  const { data: delivs } = await auth.supabase.from("project_deliverables")
    .select("id, catalog_key, device_id").in("id", revs.map((r: { deliverable_id: string }) => r.deliverable_id));
  const byId = new Map((delivs ?? []).map((d) => [d.id, d]));
  const spv = project?.spv_name || project?.name || "";
  type Rev = { deliverable_id: string; rev_no: number; version_date: string; notes: string | null; document_id: string | null };
  const items = (revs as Rev[]).map((r) => {
    const d = byId.get(r.deliverable_id);
    const c = d ? CATALOG.get(d.catalog_key) : undefined;
    const name = c && d ? deliverableFileName({ spv, item: c, versionDate: r.version_date, deviceId: d.device_id || null }) : "Document";
    return { r, name };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const missing = items.filter((i) => !i.r.document_id).map((i) => i.name);
  if (missing.length) return { ok: false, error: `Attach the PDF first: ${missing.join(", ")}` };
  const { data: docs } = await auth.supabase.from("project_documents")
    .select("id, storage_path, mime_type, file_name").in("id", items.map((i) => i.r.document_id!));
  const docById = new Map((docs ?? []).map((d) => [d.id, d]));

  const files: Uint8Array[] = [];
  for (const it of items) {
    const d = docById.get(it.r.document_id!);
    if (!d) return { ok: false, error: `The file for ${it.name} is gone. Attach it again.` };
    if (!/pdf/i.test(d.mime_type ?? "") && !/\.pdf$/i.test(d.file_name)) {
      return { ok: false, error: `${d.file_name} is not a PDF. Only PDFs can go behind the cover.` };
    }
    const { data: blob, error } = await auth.supabase.storage.from(DOCUMENT_BUCKET).download(d.storage_path);
    if (error || !blob) return { ok: false, error: `Couldn't read ${d.file_name}: ${error?.message ?? "missing"}` };
    files.push(new Uint8Array(await blob.arrayBuffer()));
  }

  const number = submittalNumber(project?.submittal_prefix, sub.submittal_no);
  let bytes: Uint8Array;
  try {
    bytes = await buildPackage({
      project: sub.project_label || project?.name || "",
      date: mdY(sub.submitted_on),
      submittalNo: number,
      to: sub.to_name ?? "",
      from: sub.from_name ?? "",
      subject: sub.subject ?? "",
      cc: sub.cc ?? "",
      transmittedFor: sub.transmitted_for,
      transmittedOther: sub.transmitted_other,
      items: items.map((i) => (i.r.rev_no > 0 ? `${i.name} (Rev ${i.r.rev_no}${i.r.notes ? `: ${i.r.notes}` : ""})` : i.name)),
      notes: sub.notes ?? "",
      requestedResponseDate: mdY(sub.requested_response_date),
    }, files);
  } catch (e) {
    return { ok: false, error: `Couldn't merge the PDFs: ${(e as Error).message}` };
  }
  // One document keeps its Exhibit S name; a bundle takes the subject and
  // the submittal date in the same SPV_Item_vYYYY-MM-DD shape.
  const exhibitName = items.length === 1
    ? items[0].name
    : `${spv}_${(sub.subject || "Submittal").replace(/[\\/:*?"<>|]+/g, "-")}_v${sub.submitted_on}`;
  const fileName = packageFileName(number, exhibitName);

  // Keep it on the Documents page, replacing an earlier build.
  const docId = crypto.randomUUID();
  const storagePath = `${projectId}/${docId}/${fileName.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
  const up = await auth.supabase.storage.from(DOCUMENT_BUCKET)
    .upload(storagePath, new Blob([Buffer.from(bytes)], { type: "application/pdf" }), { contentType: "application/pdf", upsert: false });
  if (up.error) return { ok: false, error: `Couldn't save the package: ${up.error.message}` };
  const { data: row, error: insErr } = await auth.supabase.from("project_documents").insert({
    project_id: projectId,
    uploaded_by_id: auth.userId,
    file_name: fileName,
    storage_path: storagePath,
    mime_type: "application/pdf",
    size_bytes: bytes.byteLength,
    category: "submittal",
    description: `Submittal ${number} package: cover and ${items.length} document${items.length === 1 ? "" : "s"}`,
    text_status: "pending",
  }).select("id").single();
  if (insErr) {
    await auth.supabase.storage.from(DOCUMENT_BUCKET).remove([storagePath]);
    return { ok: false, error: friendly(insErr.message) };
  }
  if (sub.package_document_id) {
    const { data: old } = await auth.supabase.from("project_documents").select("storage_path").eq("id", sub.package_document_id).maybeSingle();
    await auth.supabase.from("project_documents").delete().eq("id", sub.package_document_id);
    if (old?.storage_path) await auth.supabase.storage.from(DOCUMENT_BUCKET).remove([old.storage_path]);
  }

  let drive: { id: string; url: string } | null = null;
  let note = `${fileName} is ready.`;
  if (driveConfigured() && project?.submittal_drive_folder_id) {
    try {
      drive = await uploadPdfToDrive(project.submittal_drive_folder_id, fileName, bytes);
      note = `${fileName} saved to Drive.`;
    } catch (e) {
      note = `${fileName} is ready, but Drive didn't take it: ${(e as Error).message}`;
    }
  } else if (!driveConfigured()) {
    note = `${fileName} is ready. Drive isn't connected yet, so download it and drop it in the folder.`;
  } else {
    note = `${fileName} is ready. Set the Drive folder on this page to have it saved there.`;
  }
  await db.from("project_submittals").update({
    package_document_id: row.id,
    package_built_at: new Date().toISOString(),
    ...(drive ? { drive_file_id: drive.id, drive_url: drive.url } : {}),
  }).eq("id", submittalId);

  const { data: signed } = await auth.supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(storagePath, 3600, { download: fileName });
  done(projectId);
  return { ok: true, note, url: signed?.signedUrl, driveUrl: drive?.url };
}

/** A short-lived download link for a submittal's package. */
export async function packageDownloadUrl(projectId: string, submittalId: string): Promise<DeliverableResult & { url?: string }> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  const db = untyped(auth.supabase);
  const { data: sub } = await db.from("project_submittals").select("package_document_id")
    .eq("id", submittalId).eq("project_id", projectId).maybeSingle();
  if (!sub?.package_document_id) return { ok: false, error: "No package built yet." };
  const { data: doc } = await auth.supabase.from("project_documents").select("storage_path, file_name").eq("id", sub.package_document_id).maybeSingle();
  if (!doc) return { ok: false, error: "The package file is gone. Build it again." };
  const { data: signed, error } = await auth.supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(doc.storage_path, 3600, { download: doc.file_name });
  if (error || !signed) return { ok: false, error: error?.message ?? "Couldn't make a link" };
  return { ok: true, url: signed.signedUrl };
}

/** The Drive folder this project's submittal packages are saved to. */
export async function setSubmittalDriveFolder(projectId: string, link: string): Promise<DeliverableResult> {
  const auth = await signedIn();
  if (!auth) return { ok: false, error: "Not signed in" };
  const id = link.trim() ? folderIdFromLink(link) : null;
  if (link.trim() && !id) return { ok: false, error: "Paste the Drive folder's link, from the address bar." };
  let note: string | undefined;
  if (id && driveConfigured()) {
    const name = await driveFolderName(id);
    if (!name) return { ok: false, error: "Phil's Drive can't open that folder. Check the link, and that it is a folder." };
    note = `Saving to "${name}".`;
  }
  const { error } = await untyped(auth.supabase).from("projects").update({ submittal_drive_folder_id: id }).eq("id", projectId);
  if (error) return { ok: false, error: friendly(error.message) };
  done(projectId);
  return { ok: true, note };
}
