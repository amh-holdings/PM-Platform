"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  CATALOG_BY_KEY,
  DELIVERABLE_STATES,
  EXHIBIT_S,
  deviceIdProblem,
  type DeliverableState,
} from "@/lib/exhibit-s";

export type DeliverableResult = { ok: true; note?: string } | { ok: false; error: string };

function friendly(message: string): string {
  if (/project_deliverables|spv_name/i.test(message) && /does not exist|could not find/i.test(message)) {
    return "The Exhibit S checklist is not in the database yet. Run migration 0086 in the Supabase SQL Editor.";
  }
  if (/duplicate key|project_deliverables_once/i.test(message)) return "That device is already on the list.";
  return message;
}

async function signedIn() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user ? { supabase, userId: user.id } : null;
}

const done = (projectId: string) => revalidatePath(`/projects/${projectId}/deliverables`);
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
  const { error } = await auth.supabase.from("project_deliverables").insert({
    project_id: projectId,
    catalog_key: catalogKey,
    device_id: deviceId.trim(),
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
  if (patch.state !== undefined) {
    if (!DELIVERABLE_STATES.includes(patch.state)) return { ok: false, error: "Unknown status" };
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
