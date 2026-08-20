// Shape of an UNSUBMITTED subcontractor Field Report, parked in
// dprs.draft_payload (migration 0039) so a sub can start a report in the
// morning, add to it through the day, and file it at quitting time.
//
// This is deliberately a mirror of the DprForm's own client state rather than
// a normalized record. A draft is a half-finished form, not a report: it holds
// pins with no WBS yet, blank rows the sub is about to fill in, and free text
// in numeric fields. Normalizing it would mean validating it, and there is
// nothing to validate against until submit. The real, normalized rows
// (inspections, dpr_manpower, dpr_equipment, ...) are written once, by
// submitFieldReport, from a payload that has passed the pin editor's checks.
//
// Because the shape is the form's, it changes when the form changes. VERSION
// guards that: a payload written by an older build is discarded rather than
// half-applied, which loses one unsubmitted draft instead of silently
// hydrating a report with fields in the wrong places. Bump it on any
// incompatible field change.

export const FIELD_REPORT_DRAFT_VERSION = 1;

// Photo metadata only. The blob is already in dpr-photos/{projectId}/_drafts/
// - the client uploader puts it there before the draft is ever saved - so a
// draft references storage paths exactly the way submitDpr does. `previewUrl`
// is NOT stored: it is a blob: URL that dies with the browser session, and is
// re-derived as a signed URL when the draft is loaded.
export type DraftReportPhoto = {
  photoId: string;
  fileName: string;
  storagePath: string;
  sizeBytes: number;
  mimeType: string | null;
  caption: string;
  photoType: string;
};

export type DraftPinPhoto = {
  storagePath: string;
  caption: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  takenAt: string;
};

// A work-done map pin mid-edit. `confirmed` false means the sub has not
// finished it - the exact state an `inspections` row could not represent,
// which is why drafts live here instead of there.
export type DraftWorkPin = {
  rowId: string;
  basemapKey: string;
  x: number;
  y: number;
  wbsTaskId: string;
  newStatus: string;
  newPct: string;
  installedQty: string;
  unitOfMeasure: string;
  notes: string;
  photos: DraftPinPhoto[];
  confirmed: boolean;
};

export type DraftTaskUpdate = {
  taskId: string;
  newStatus: string;
  newPct: string;
  installed: string;
  notes: string;
};

export type DraftManpowerRow = {
  rowId: string;
  subcontractorId: string;
  trade: string;
  headcount: string;
  regularHours: string;
  otHours: string;
  notes: string;
};

export type DraftEquipmentRow = {
  rowId: string;
  equipmentName: string;
  quantity: string;
  onRent: boolean;
  rentalCompany: string;
  active: boolean;
  notes: string;
};

export type DraftDeliveryRow = {
  rowId: string;
  vendorName: string;
  materials: string;
  quantity: string;
  unitOfMeasure: string;
  poNumber: string;
  procurementOrderId: string;
  notes: string;
};

export type DraftDelayRow = {
  rowId: string;
  causeCode: string;
  hoursLost: string;
  impactedScheduleTaskId: string;
  narrative: string;
};

export type FieldReportDraft = {
  version: number;
  // Storage prefix the photos were staged under. Carried across sessions so a
  // resumed draft keeps adding photos to one prefix instead of scattering them
  // under a fresh uuid on every visit.
  draftId: string;
  reportDate: string;
  subcontractorId: string;
  narrative: string;
  weather: string;
  crewOverride: string;
  hoursPerDay: string;
  hoursOverride: string;
  sheet: string;
  safetyIncident: boolean;
  nearMiss: boolean;
  safetyNarrative: string;
  workPins: DraftWorkPin[];
  taskUpdates: DraftTaskUpdate[];
  manpower: DraftManpowerRow[];
  equipment: DraftEquipmentRow[];
  deliveries: DraftDeliveryRow[];
  delays: DraftDelayRow[];
  photos: DraftReportPhoto[];
};

// Every storage path a draft references, for signing on load and for sweeping
// blobs when a draft is discarded.
export function draftStoragePaths(draft: FieldReportDraft): string[] {
  const paths = draft.photos.map((p) => p.storagePath);
  for (const pin of draft.workPins) {
    for (const ph of pin.photos) paths.push(ph.storagePath);
  }
  return paths.filter(Boolean);
}

// Narrow a jsonb column to a usable draft. Anything unrecognized - a payload
// from an older build, a hand-edited row, null - comes back null so the caller
// opens a clean form instead of hydrating garbage.
export function parseFieldReportDraft(raw: unknown): FieldReportDraft | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Partial<FieldReportDraft>;
  if (d.version !== FIELD_REPORT_DRAFT_VERSION) return null;
  if (typeof d.reportDate !== "string" || !d.reportDate) return null;
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    version: FIELD_REPORT_DRAFT_VERSION,
    draftId: typeof d.draftId === "string" ? d.draftId : "",
    reportDate: d.reportDate,
    subcontractorId: d.subcontractorId ?? "",
    narrative: d.narrative ?? "",
    weather: d.weather ?? "",
    crewOverride: d.crewOverride ?? "",
    hoursPerDay: d.hoursPerDay ?? "",
    hoursOverride: d.hoursOverride ?? "",
    sheet: d.sheet ?? "",
    safetyIncident: d.safetyIncident === true,
    nearMiss: d.nearMiss === true,
    safetyNarrative: d.safetyNarrative ?? "",
    workPins: arr<DraftWorkPin>(d.workPins),
    taskUpdates: arr<DraftTaskUpdate>(d.taskUpdates),
    manpower: arr<DraftManpowerRow>(d.manpower),
    equipment: arr<DraftEquipmentRow>(d.equipment),
    deliveries: arr<DraftDeliveryRow>(d.deliveries),
    delays: arr<DraftDelayRow>(d.delays),
    photos: arr<DraftReportPhoto>(d.photos),
  };
}
