// Loading a task's records, and the counts the grid needs before anything is
// opened.
//
// Two entry points with deliberately different shapes:
//
//   loadTaskRecordCounts  - the whole schedule, one query per record kind,
//                           called at page load. The badge on 288 rows must
//                           not be 288 queries.
//
//   loadTaskRecords       - one task, everything, called when the popup opens.
//                           This is where signed URLs are minted, because
//                           signing every photo on the project at page load
//                           would be hundreds of URLs nobody looks at, each
//                           expiring in an hour.
//
// Every optional table is probed the way the schedule page probes its optional
// columns: a missing `schedule_task_documents` (migration 0069 not applied
// yet) degrades to an empty list and a flag, rather than 400ing the query and
// taking the popup down with it.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  EMPTY_COUNTS,
  markMovement,
  predecessorsOf,
  successorsOf,
  type TaskConstraintRow,
  type TaskDocument,
  type TaskEvidence,
  type TaskPhoto,
  type TaskPin,
  type TaskPoDelivery,
  type TaskRecordCounts,
  type TaskRecords,
} from "@/lib/schedule-task-records";

const INSPECTION_BUCKET = "inspection-photos";
const DPR_PHOTO_BUCKET = "dpr-photos";
const SIGNED_URL_TTL = 3600;

type Db = SupabaseClient<Database>;


// ---------------------------------------------------------------------------
// Counts for the grid
// ---------------------------------------------------------------------------

/**
 * Photo, document and evidence counts for every task on a project.
 *
 * Four queries total, regardless of how many tasks there are. They select ids
 * and foreign keys only - no captions, no storage paths, nothing that has to
 * be signed - so this stays cheap enough to run on every schedule load.
 */
export async function loadTaskRecordCounts(
  supabase: Db,
  projectId: string,
): Promise<{ counts: Map<string, TaskRecordCounts>; documentsEnabled: boolean }> {
  const counts = new Map<string, TaskRecordCounts>();
  const bump = (taskId: string, key: keyof TaskRecordCounts, by = 1) => {
    const row = counts.get(taskId) ?? { ...EMPTY_COUNTS };
    row[key] += by;
    counts.set(taskId, row);
  };

  // Approved inspections pinned to a task, and their photos. Two queries
  // rather than a join, because the photo count has to be grouped by task and
  // PostgREST cannot group - so the grouping happens here, over ids.
  const { data: inspections } = await supabase
    .from("inspections")
    .select("id, schedule_task_id, status")
    .eq("project_id", projectId)
    .eq("status", "approved")
    .not("schedule_task_id", "is", null);

  const taskByInspection = new Map<string, string>();
  for (const i of inspections ?? []) {
    const taskId = i.schedule_task_id;
    if (!taskId) continue;
    taskByInspection.set(i.id, taskId);
    bump(taskId, "evidence");
  }

  if (taskByInspection.size) {
    const { data: shots } = await supabase
      .from("inspection_photos")
      .select("id, inspection_id")
      .in("inspection_id", Array.from(taskByInspection.keys()));
    for (const s of shots ?? []) {
      const taskId = taskByInspection.get(s.inspection_id);
      if (taskId) bump(taskId, "photos");
    }
  }

  // Field-report photos reach a task through the report that pinned it. A
  // report's photos are not pinned per task, so a DPR that updated three tasks
  // counts its photos against all three - which is true: the photo is evidence
  // of that day's work on any task the report moved.
  const { data: pins } = await supabase
    .from("dpr_task_updates")
    .select("dpr_id, schedule_task_id")
    .not("schedule_task_id", "is", null);

  const tasksByDpr = new Map<string, Set<string>>();
  for (const p of pins ?? []) {
    if (!p.schedule_task_id) continue;
    const set = tasksByDpr.get(p.dpr_id) ?? new Set<string>();
    set.add(p.schedule_task_id);
    tasksByDpr.set(p.dpr_id, set);
  }

  if (tasksByDpr.size) {
    const { data: dprShots } = await supabase
      .from("photos")
      .select("id, dpr_id")
      .eq("project_id", projectId)
      .not("dpr_id", "is", null);
    const perDpr = new Map<string, number>();
    for (const s of dprShots ?? []) {
      if (!s.dpr_id) continue;
      perDpr.set(s.dpr_id, (perDpr.get(s.dpr_id) ?? 0) + 1);
    }
    perDpr.forEach((n, dprId) => {
      const tasks = tasksByDpr.get(dprId);
      if (!tasks) return;
      tasks.forEach((taskId) => bump(taskId, "photos", n));
    });
  }

  // Attached documents. Migration 0069 may not be applied, in which case this
  // errors and the Documents tab says so instead of the page breaking.
  let documentsEnabled = true;
  const docs = await supabase
    .from("schedule_task_documents")
    .select("id, schedule_task_id")
    .eq("project_id", projectId);

  if (docs.error) {
    documentsEnabled = false;
  } else {
    for (const d of docs.data ?? []) bump(d.schedule_task_id, "documents");
  }

  return { counts, documentsEnabled };
}

// ---------------------------------------------------------------------------
// Everything for one task
// ---------------------------------------------------------------------------

type TaskShape = {
  id: string;
  wbs_code: string;
  task_name: string;
  predecessors: string | null;
};

/**
 * Sign a batch of storage paths, tolerating a bucket that refuses.
 *
 * createSignedUrls fails the whole batch if any path is missing from the
 * bucket, which on a project with one deleted file would blank every
 * photograph in the gallery. So a failed batch falls back to signing one at a
 * time and the individual failures come back null - a tile with no image and a
 * caption beats no gallery.
 */
async function signPaths(
  supabase: Db,
  bucket: string,
  paths: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!paths.length) return out;

  const unique = Array.from(new Set(paths));
  const batch = await supabase.storage.from(bucket).createSignedUrls(unique, SIGNED_URL_TTL);

  if (!batch.error && batch.data) {
    for (const row of batch.data) {
      if (row.path) out.set(row.path, row.signedUrl ?? null);
    }
    // Anything the batch did not answer for is still missing from the map.
    for (const p of unique) if (!out.has(p)) out.set(p, null);
    return out;
  }

  for (const p of unique) {
    const one = await supabase.storage.from(bucket).createSignedUrl(p, SIGNED_URL_TTL);
    out.set(p, one.error ? null : (one.data?.signedUrl ?? null));
  }
  return out;
}

export async function loadTaskRecords(
  supabase: Db,
  projectId: string,
  task: TaskShape,
  allTasks: Array<{ wbs_code: string; task_name: string; predecessors?: string | null }>,
): Promise<TaskRecords> {
  const [
    inspectionQuery,
    pinQuery,
    constraintQuery,
    poQuery,
    docQuery,
  ] = await Promise.all([
    supabase
      .from("inspections")
      .select(
        "id, title, inspection_type, status, submitted_at, decided_at, quantity, unit_of_measure, task_new_pct, notes, decision_notes, dpr_id",
      )
      .eq("project_id", projectId)
      .eq("schedule_task_id", task.id)
      .order("decided_at", { ascending: false, nullsFirst: false }),

    supabase
      .from("dpr_task_updates")
      .select(
        "id, dpr_id, previous_pct_complete, new_pct_complete, previous_status, new_status, notes",
      )
      .eq("schedule_task_id", task.id),

    supabase
      .from("schedule_constraints")
      .select("id, category, title, owner, need_by, status, cleared_at, resolution")
      .eq("project_id", projectId)
      .eq("wbs_code", task.wbs_code)
      .order("need_by", { ascending: true, nullsFirst: false }),

    supabase
      .from("procurement_orders")
      .select(
        "id, po_number, vendor_name, description, expected_delivery_date, actual_delivery_date",
      )
      .eq("project_id", projectId)
      .eq("linked_delivery_task_wbs_code", task.wbs_code),

    supabase
      .from("schedule_task_documents")
      .select(
        "id, document_id, note, project_documents(id, file_name, category, description, size_bytes, uploaded_at)",
      )
      .eq("schedule_task_id", task.id)
      .order("created_at", { ascending: true }),
  ]);

  // ---- report dates, which are what every record is keyed to in the field --
  // An inspection and a pin both carry a dpr_id, and the DPR's report_date is
  // the date the work happened. decided_at is when somebody clicked approve,
  // which on a Monday review of Friday's work is the wrong day to show.
  const dprIds = new Set<string>();
  for (const i of inspectionQuery.data ?? []) if (i.dpr_id) dprIds.add(i.dpr_id);
  for (const p of pinQuery.data ?? []) if (p.dpr_id) dprIds.add(p.dpr_id);

  const reportDates = new Map<string, string>();
  if (dprIds.size) {
    const { data } = await supabase
      .from("dprs")
      .select("id, report_date")
      .in("id", Array.from(dprIds));
    for (const d of data ?? []) reportDates.set(d.id, d.report_date);
  }

  // ---- inspection photos -------------------------------------------------
  const inspectionIds = (inspectionQuery.data ?? []).map((i) => i.id);
  let inspectionShots: Array<{
    id: string;
    inspection_id: string;
    storage_path: string;
    caption: string | null;
    taken_at: string | null;
  }> = [];
  if (inspectionIds.length) {
    const { data } = await supabase
      .from("inspection_photos")
      .select("id, inspection_id, storage_path, caption, taken_at")
      .in("inspection_id", inspectionIds)
      .order("created_at", { ascending: true });
    inspectionShots = data ?? [];
  }

  // ---- field-report photos ------------------------------------------------
  const pinDprIds = Array.from(
    new Set((pinQuery.data ?? []).map((p) => p.dpr_id).filter(Boolean) as string[]),
  );
  let dprShots: Array<{
    id: string;
    dpr_id: string | null;
    storage_path: string;
    caption: string | null;
    taken_at: string | null;
  }> = [];
  if (pinDprIds.length) {
    const { data } = await supabase
      .from("photos")
      .select("id, dpr_id, storage_path, caption, taken_at")
      .in("dpr_id", pinDprIds)
      .order("created_at", { ascending: true });
    dprShots = data ?? [];
  }

  const [inspectionUrls, dprUrls] = await Promise.all([
    signPaths(supabase, INSPECTION_BUCKET, inspectionShots.map((s) => s.storage_path)),
    signPaths(supabase, DPR_PHOTO_BUCKET, dprShots.map((s) => s.storage_path)),
  ]);

  // ---- assemble ----------------------------------------------------------
  const base = `/projects/${projectId}`;

  const photosByInspection = new Map<string, TaskPhoto[]>();
  for (const s of inspectionShots) {
    const list = photosByInspection.get(s.inspection_id) ?? [];
    list.push({
      id: s.id,
      url: inspectionUrls.get(s.storage_path) ?? null,
      caption: s.caption,
      takenAt: s.taken_at,
      source: "inspection",
      sourceLabel: "Approved inspection",
      href: `${base}/inspections/${s.inspection_id}`,
    });
    photosByInspection.set(s.inspection_id, list);
  }

  const evidence: TaskEvidence[] = (inspectionQuery.data ?? [])
    .filter((i) => i.status === "approved")
    .map((i) => ({
      id: i.id,
      title: i.title,
      inspectionType: i.inspection_type,
      status: i.status,
      submittedAt: i.submitted_at,
      decidedAt: i.decided_at,
      reportDate: i.dpr_id ? (reportDates.get(i.dpr_id) ?? null) : null,
      quantity: i.quantity,
      unitOfMeasure: i.unit_of_measure,
      pinnedPct: i.task_new_pct,
      notes: i.notes,
      decisionNotes: i.decision_notes,
      photos: photosByInspection.get(i.id) ?? [],
      href: `${base}/inspections/${i.id}`,
    }));

  const rawPins = (pinQuery.data ?? []).map((p) => ({
    id: p.id,
    dprId: p.dpr_id,
    reportDate: p.dpr_id ? (reportDates.get(p.dpr_id) ?? null) : null,
    previousPct: p.previous_pct_complete,
    newPct: p.new_pct_complete,
    previousStatus: p.previous_status,
    newStatus: p.new_status,
    notes: p.notes,
  }));
  const moved = markMovement(rawPins);
  const pins: TaskPin[] = rawPins
    .map((p, i) => ({
      id: p.id,
      reportDate: p.reportDate,
      previousPct: p.previousPct,
      newPct: p.newPct,
      previousStatus: p.previousStatus,
      newStatus: p.newStatus,
      notes: p.notes,
      moved: moved[i],
      href: `${base}/field-reports/${p.dprId}`,
    }))
    .sort((a, b) => (b.reportDate ?? "").localeCompare(a.reportDate ?? ""));

  // The pooled gallery: inspection photos first, because those are the ones
  // somebody approved, then the rest of the day's record behind them.
  const photos: TaskPhoto[] = [
    ...evidence.flatMap((e) =>
      e.photos.map((p) => ({
        ...p,
        sourceLabel: `Inspection · ${fmtShort(e.reportDate ?? e.decidedAt)}`,
      })),
    ),
    ...dprShots.map((s) => ({
      id: s.id,
      url: dprUrls.get(s.storage_path) ?? null,
      caption: s.caption,
      takenAt: s.taken_at,
      source: "field_report" as const,
      sourceLabel: `Field report · ${fmtShort(
        s.dpr_id ? (reportDates.get(s.dpr_id) ?? null) : null,
      )}`,
      href: s.dpr_id ? `${base}/field-reports/${s.dpr_id}` : null,
    })),
  ];

  const constraints: TaskConstraintRow[] = (constraintQuery.data ?? []).map((c) => ({
    id: c.id,
    category: c.category,
    title: c.title,
    owner: c.owner,
    needBy: c.need_by,
    status: c.status,
    clearedAt: c.cleared_at,
    resolution: c.resolution,
  }));

  const deliveries: TaskPoDelivery[] = (poQuery.data ?? []).map((p) => ({
    id: p.id,
    poNumber: p.po_number,
    vendor: p.vendor_name,
    description: p.description,
    promisedDate: p.expected_delivery_date,
    deliveredDate: p.actual_delivery_date,
    href: `${base}/procurement/${p.id}`,
  }));

  const documentsEnabled = !docQuery.error;
  const documents: TaskDocument[] = documentsEnabled
    ? (docQuery.data ?? []).flatMap((row) => {
        // PostgREST returns the embedded row as an object, or null when the
        // document has been deleted out from under a link that cascade has not
        // caught up with. A link to nothing is not a document.
        const doc = row.project_documents;
        if (!doc) return [];
        return [
          {
            linkId: row.id,
            documentId: doc.id,
            fileName: doc.file_name,
            category: doc.category,
            description: doc.description,
            sizeBytes: doc.size_bytes,
            uploadedAt: doc.uploaded_at,
            note: row.note,
          },
        ];
      })
    : [];

  return {
    taskId: task.id,
    wbsCode: task.wbs_code,
    evidence,
    pins,
    photos,
    documents,
    predecessors: predecessorsOf(task.predecessors, allTasks),
    successors: successorsOf(task.wbs_code, allTasks),
    constraints,
    deliveries,
    notes: { documentsEnabled },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtShort(iso: string | null): string {
  if (!iso) return "no date";
  const d = iso.slice(0, 10).split("-");
  const m = MONTHS[Number(d[1]) - 1];
  if (!m) return iso.slice(0, 10);
  return `${Number(d[2])} ${m} ${d[0].slice(2)}`;
}
