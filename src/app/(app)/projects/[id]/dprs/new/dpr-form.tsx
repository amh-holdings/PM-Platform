"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { BASEMAPS, type BasemapKey, type NormalizedPin } from "@/lib/inspection-map";
import { submitDpr, getPreviousReportScaffold } from "../../dpr-actions";
import { submitFieldReport } from "../../field-report-actions";
import { InspectionMap } from "../../inspections/inspection-map";
import {
  PhotoUploader,
  type UploadedPhoto,
} from "../../inspections/photo-uploader";

import { DprPhotoUploader, type StagedPhoto } from "./dpr-photo-uploader";

// A work-done pin the sub drops on the site map in a Field Report. Becomes an
// inspection (origin='sub') on submit. Each pin remembers which sheet it was
// placed on and links to a WBS/schedule task.
type WorkPin = {
  rowId: string;
  basemapKey: BasemapKey;
  x: number;
  y: number;
  // The pin IS the work on a WBS task; its title/type derive from that task.
  wbsTaskId: string;
  // Progress for the linked WBS task, applied to the schedule on CM approval.
  newStatus: string;
  newPct: string;
  installedQty: string;
  unitOfMeasure: string;
  notes: string;
  photos: UploadedPhoto[];
  // A pin must be saved (all required fields filled) before the report can go.
  confirmed: boolean;
  rowError: string | null;
};

const STATUS_OPTIONS = [
  "Not Started",
  "In Progress",
  "Complete",
  "Awaiting",
  "Approved",
  "Rejected",
];

// Units a work item's installed quantity can be reported in. Solar-first units
// (piles, modules, rows, strings, MW) lead so field crews reach them quickly;
// MODULE counts roll up into MW installed on the dashboard.
const UNIT_OPTIONS = [
  "PILE",
  "MODULE",
  "ROW",
  "STRING",
  "MW",
  "MWDC",
  "EA",
  "LF",
  "SF",
  "SY",
  "CY",
  "LB",
  "TON",
  "GAL",
  "HR",
  "KW",
  "LS",
];

const DELAY_CAUSE_CODES = [
  "weather",
  "manpower",
  "materials",
  "equipment",
  "design",
  "owner",
  "inspection",
  "permitting",
  "utility",
  "safety",
  "other",
] as const;

type Task = {
  id: string;
  wbsCode: string;
  taskName: string;
  phase: string | null;
  currentStatus: string | null;
  currentPct: number | null;
  endDate: string | null;
};

type Sub = { id: string; companyName: string; trade: string | null };
type Po = {
  id: string;
  vendorName: string;
  poNumber: string | null;
  description: string | null;
};

type Props = {
  projectId: string;
  tasks: Task[];
  subs: Sub[];
  procurementOrders: Po[];
  // "dpr" (default) = the classic Daily Progress Report. "fieldReport" = the
  // combined daily Field Report: DPR fields PLUS work-done pins on the site map,
  // reviewed by the Construction Manager the next day.
  variant?: "dpr" | "fieldReport";
  // Already-filed reports for this project, used to warn (not block) when the
  // user picks a date/sub that already has a report - a likely accidental
  // duplicate, though a same-day correction is legitimate.
  existingReports?: Array<{ reportDate: string; subcontractorId: string | null }>;
};

type TaskUpdate = {
  taskId: string;
  newStatus: string;
  newPct: string;
  installed: string;
  notes: string;
};

type ManpowerRow = {
  rowId: string;
  subcontractorId: string;
  trade: string;
  headcount: string;
  regularHours: string;
  otHours: string;
  notes: string;
};

type EquipmentRow = {
  rowId: string;
  equipmentName: string;
  quantity: string;
  onRent: boolean;
  rentalCompany: string;
  active: boolean;
  notes: string;
};

type DeliveryRow = {
  rowId: string;
  vendorName: string;
  materials: string;
  quantity: string;
  unitOfMeasure: string;
  poNumber: string;
  procurementOrderId: string;
  notes: string;
};

type DelayRow = {
  rowId: string;
  causeCode: string;
  hoursLost: string;
  impactedScheduleTaskId: string;
  narrative: string;
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function newRowId(): string {
  return crypto.randomUUID();
}

export function DprForm({
  projectId,
  tasks,
  subs,
  procurementOrders,
  variant = "dpr",
  existingReports = [],
}: Props) {
  const router = useRouter();
  const isFieldReport = variant === "fieldReport";
  const [draftId] = useState(() => crypto.randomUUID());

  // Autosave: the whole form is mirrored to localStorage so a refresh, an
  // accidental back-nav, or a failed submit never loses a half-filled report.
  // Photos are already uploaded to storage by the uploader, so only their
  // (serializable) metadata is persisted here.
  const draftKey = `dpr-draft:${projectId}:${variant}`;
  const hydratedRef = useRef(false);
  const [restored, setRestored] = useState(false);

  const [reportDate, setReportDate] = useState(todayIso());
  const [narrative, setNarrative] = useState("");
  const [weather, setWeather] = useState("");
  const [crewOverride, setCrewOverride] = useState("");
  const [hoursOverride, setHoursOverride] = useState("");
  // Field Report: total man-hours = crew count x hours per day.
  const [hoursPerDay, setHoursPerDay] = useState("");

  // Field Report only: which sub is filing, which sheet, and the work-done pins.
  const [reportSubId, setReportSubId] = useState("");
  const [sheet, setSheet] = useState<BasemapKey>("C2-01");
  const [workPins, setWorkPins] = useState<WorkPin[]>([]);

  const [safetyIncident, setSafetyIncident] = useState(false);
  const [nearMiss, setNearMiss] = useState(false);
  const [safetyNarrative, setSafetyNarrative] = useState("");

  const [photos, setPhotos] = useState<StagedPhoto[]>([]);
  const [manpower, setManpower] = useState<ManpowerRow[]>([]);
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [delays, setDelays] = useState<DelayRow[]>([]);

  const [search, setSearch] = useState("");
  const [updates, setUpdates] = useState<Map<string, TaskUpdate>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Copy-previous-day: pull the last report's equipment fleet (and, for a
  // classic DPR, the crew roster) so they are not re-typed every morning. Counts
  // come back blank to force a fresh entry.
  async function copyPrevious() {
    setCopying(true);
    setCopyNote(null);
    setError(null);
    const res = await getPreviousReportScaffold({
      projectId,
      subcontractorId: isFieldReport ? reportSubId || null : null,
    });
    setCopying(false);
    if (!res) {
      setCopyNote("No previous report to copy from.");
      return;
    }
    if (res.equipment.length > 0) {
      setEquipment(res.equipment.map((e) => ({ rowId: newRowId(), ...e })));
    }
    if (isFieldReport && !reportSubId && res.reportSubId) {
      setReportSubId(res.reportSubId);
    }
    if (!isFieldReport && res.manpower.length > 0) {
      setManpower(res.manpower.map((m) => ({ rowId: newRowId(), ...m })));
    }
    setCopyNote(
      `Copied equipment${isFieldReport ? "" : " and crew roster"} from ${formatDate(
        res.fromDate,
      )}. Re-enter today's counts and hours.`,
    );
  }

  // Hydrate once from any saved draft. Runs client-only (localStorage is
  // undefined during SSR), so it lives in an effect rather than a lazy state
  // initializer.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const d = JSON.parse(raw) as Record<string, unknown>;
        if (typeof d.reportDate === "string") setReportDate(d.reportDate);
        if (typeof d.narrative === "string") setNarrative(d.narrative);
        if (typeof d.weather === "string") setWeather(d.weather);
        if (typeof d.crewOverride === "string") setCrewOverride(d.crewOverride);
        if (typeof d.hoursOverride === "string")
          setHoursOverride(d.hoursOverride);
        if (typeof d.hoursPerDay === "string") setHoursPerDay(d.hoursPerDay);
        if (typeof d.reportSubId === "string") setReportSubId(d.reportSubId);
        if (typeof d.sheet === "string" && d.sheet in BASEMAPS)
          setSheet(d.sheet as BasemapKey);
        if (Array.isArray(d.workPins)) setWorkPins(d.workPins as WorkPin[]);
        if (typeof d.safetyIncident === "boolean")
          setSafetyIncident(d.safetyIncident);
        if (typeof d.nearMiss === "boolean") setNearMiss(d.nearMiss);
        if (typeof d.safetyNarrative === "string")
          setSafetyNarrative(d.safetyNarrative);
        if (Array.isArray(d.photos))
          // The blob: previewUrl does not survive a reload; blank it so the
          // uploader shows a "Saved" placeholder instead of a broken image. The
          // storagePath is intact, so the photo still submits.
          setPhotos(
            (d.photos as StagedPhoto[]).map((p) => ({ ...p, previewUrl: "" })),
          );
        if (Array.isArray(d.manpower)) setManpower(d.manpower as ManpowerRow[]);
        if (Array.isArray(d.equipment))
          setEquipment(d.equipment as EquipmentRow[]);
        if (Array.isArray(d.deliveries))
          setDeliveries(d.deliveries as DeliveryRow[]);
        if (Array.isArray(d.delays)) setDelays(d.delays as DelayRow[]);
        if (Array.isArray(d.updates))
          setUpdates(new Map(d.updates as [string, TaskUpdate][]));
        // Only surface the "restored" banner if the draft actually held work.
        const meaningful =
          (typeof d.narrative === "string" && d.narrative.trim() !== "") ||
          (Array.isArray(d.workPins) && d.workPins.length > 0) ||
          (Array.isArray(d.updates) && d.updates.length > 0) ||
          (Array.isArray(d.manpower) && d.manpower.length > 0) ||
          (Array.isArray(d.photos) && d.photos.length > 0);
        if (meaningful) setRestored(true);
      }
    } catch {
      // Corrupt draft - ignore and start clean.
    }
    hydratedRef.current = true;
  }, [draftKey]);

  // Persist the form on every change (debounced), but never before hydration
  // has had its chance - otherwise the initial empty state would clobber a saved
  // draft on mount.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            reportDate,
            narrative,
            weather,
            crewOverride,
            hoursOverride,
            hoursPerDay,
            reportSubId,
            sheet,
            workPins,
            safetyIncident,
            nearMiss,
            safetyNarrative,
            photos,
            manpower,
            equipment,
            deliveries,
            delays,
            updates: Array.from(updates.entries()),
          }),
        );
      } catch {
        // Storage full or unavailable - autosave is best-effort.
      }
    }, 500);
    return () => clearTimeout(t);
  }, [
    draftKey,
    reportDate,
    narrative,
    weather,
    crewOverride,
    hoursOverride,
    hoursPerDay,
    reportSubId,
    sheet,
    workPins,
    safetyIncident,
    nearMiss,
    safetyNarrative,
    photos,
    manpower,
    equipment,
    deliveries,
    delays,
    updates,
  ]);

  function clearDraft() {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // ignore
    }
  }

  // Throw away the restored draft and reset the form to a clean slate.
  function discardDraft() {
    clearDraft();
    setReportDate(todayIso());
    setNarrative("");
    setWeather("");
    setCrewOverride("");
    setHoursOverride("");
    setHoursPerDay("");
    setReportSubId("");
    setSheet("C2-01");
    setWorkPins([]);
    setSafetyIncident(false);
    setNearMiss(false);
    setSafetyNarrative("");
    setPhotos([]);
    setManpower([]);
    setEquipment([]);
    setDeliveries([]);
    setDelays([]);
    setUpdates(new Map());
    setRestored(false);
    setError(null);
  }

  // ===== rollups =====
  const manpowerTotals = useMemo(() => {
    let headcount = 0;
    let hours = 0;
    for (const m of manpower) {
      headcount += Number(m.headcount) || 0;
      hours += (Number(m.regularHours) || 0) + (Number(m.otHours) || 0);
    }
    return { headcount, hours };
  }, [manpower]);

  const effectiveCrewCount = crewOverride
    ? Number(crewOverride)
    : manpowerTotals.headcount;
  const effectiveHours = hoursOverride
    ? Number(hoursOverride)
    : manpowerTotals.hours;

  // Field Report: total man-hours is derived from crew count x hours per day.
  const fieldReportHours =
    (Number(crewOverride) || 0) * (Number(hoursPerDay) || 0);

  // Warn (do not block) when a report already exists for this date. For a Field
  // Report we key on date + sub; for a classic DPR, on the date alone.
  const duplicateReport = useMemo(() => {
    if (!reportDate) return false;
    return existingReports.some(
      (r) =>
        r.reportDate === reportDate &&
        (isFieldReport ? r.subcontractorId === (reportSubId || null) : true),
    );
  }, [existingReports, reportDate, reportSubId, isFieldReport]);

  // Client-side validation run before submit: a required, non-future report
  // date and non-negative numeric fields. Returns the first problem, or null.
  function validateInputs(): string | null {
    if (!reportDate) return "Report date is required";
    if (reportDate > todayIso()) return "Report date cannot be in the future";
    const bad = (v: string) => v.trim() !== "" && !Number.isFinite(Number(v));
    const neg = (v: string) => v.trim() !== "" && Number(v) < 0;
    const nonNeg = (v: string, label: string) =>
      bad(v) || neg(v) ? `${label} must be zero or more` : null;

    return (
      nonNeg(crewOverride, "Crew count") ??
      nonNeg(hoursPerDay, "Hours per day") ??
      nonNeg(hoursOverride, "Total man-hours") ??
      manpower.reduce<string | null>(
        (err, m) =>
          err ??
          nonNeg(m.headcount, "Manpower headcount") ??
          nonNeg(m.regularHours, "Manpower regular hours") ??
          nonNeg(m.otHours, "Manpower OT hours"),
        null,
      ) ??
      equipment.reduce<string | null>(
        (err, e) => err ?? nonNeg(e.quantity, "Equipment quantity"),
        null,
      ) ??
      deliveries.reduce<string | null>(
        (err, d) => err ?? nonNeg(d.quantity, "Delivery quantity"),
        null,
      ) ??
      delays.reduce<string | null>(
        (err, d) => err ?? nonNeg(d.hoursLost, "Delay hours lost"),
        null,
      ) ??
      workPins.reduce<string | null>((err, p) => {
        if (err) return err;
        if (p.newPct.trim() !== "") {
          const n = Number(p.newPct);
          if (!Number.isFinite(n) || n < 0 || n > 100)
            return "Pin % complete must be between 0 and 100";
        }
        return nonNeg(p.installedQty, "Pin installed quantity");
      }, null)
    );
  }

  // ===== task updates =====
  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.wbsCode.toLowerCase().includes(q) ||
        t.taskName.toLowerCase().includes(q) ||
        (t.phase ?? "").toLowerCase().includes(q),
    );
  }, [tasks, search]);

  function toggleTask(t: Task) {
    setUpdates((prev) => {
      const next = new Map(prev);
      if (next.has(t.id)) {
        next.delete(t.id);
      } else {
        next.set(t.id, {
          taskId: t.id,
          newStatus: t.currentStatus === "Complete" ? "Complete" : "In Progress",
          newPct: t.currentPct != null ? String(t.currentPct) : "",
          installed: "",
          notes: "",
        });
      }
      return next;
    });
  }

  function patchUpdate(taskId: string, patch: Partial<TaskUpdate>) {
    setUpdates((prev) => {
      const next = new Map(prev);
      const cur = next.get(taskId);
      if (!cur) return prev;
      next.set(taskId, { ...cur, ...patch });
      return next;
    });
  }

  // ===== manpower row helpers =====
  function addManpowerRow() {
    setManpower((prev) => [
      ...prev,
      {
        rowId: newRowId(),
        subcontractorId: "",
        trade: "",
        headcount: "",
        regularHours: "",
        otHours: "",
        notes: "",
      },
    ]);
  }
  function patchManpower(rowId: string, patch: Partial<ManpowerRow>) {
    setManpower((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  }
  function removeManpower(rowId: string) {
    setManpower((prev) => prev.filter((r) => r.rowId !== rowId));
  }

  // ===== equipment row helpers =====
  function addEquipmentRow() {
    setEquipment((prev) => [
      ...prev,
      {
        rowId: newRowId(),
        equipmentName: "",
        quantity: "1",
        onRent: false,
        rentalCompany: "",
        active: true,
        notes: "",
      },
    ]);
  }
  function patchEquipment(rowId: string, patch: Partial<EquipmentRow>) {
    setEquipment((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  }
  function removeEquipment(rowId: string) {
    setEquipment((prev) => prev.filter((r) => r.rowId !== rowId));
  }

  // ===== delivery row helpers =====
  function addDeliveryRow() {
    setDeliveries((prev) => [
      ...prev,
      {
        rowId: newRowId(),
        vendorName: "",
        materials: "",
        quantity: "",
        unitOfMeasure: "",
        poNumber: "",
        procurementOrderId: "",
        notes: "",
      },
    ]);
  }
  function patchDelivery(rowId: string, patch: Partial<DeliveryRow>) {
    setDeliveries((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  }
  function removeDelivery(rowId: string) {
    setDeliveries((prev) => prev.filter((r) => r.rowId !== rowId));
  }

  // ===== delay row helpers =====
  function addDelayRow() {
    setDelays((prev) => [
      ...prev,
      {
        rowId: newRowId(),
        causeCode: "weather",
        hoursLost: "",
        impactedScheduleTaskId: "",
        narrative: "",
      },
    ]);
  }
  function patchDelay(rowId: string, patch: Partial<DelayRow>) {
    setDelays((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  }
  function removeDelay(rowId: string) {
    setDelays((prev) => prev.filter((r) => r.rowId !== rowId));
  }

  // ===== work-done pins (Field Report) =====
  // The pin's identity is its WBS task; label comes from the schedule item.
  const taskLabel = useMemo(
    () => new Map(tasks.map((t) => [t.id, `${t.wbsCode} ${t.taskName}`])),
    [tasks],
  );
  function pinLabel(p: WorkPin): string {
    return taskLabel.get(p.wbsTaskId) ?? "Work item";
  }

  // Tapping the map drops a new work item at that spot; fill in its row below.
  function addWorkPin(pin: NormalizedPin) {
    setWorkPins((prev) => [
      ...prev,
      {
        rowId: newRowId(),
        basemapKey: sheet,
        x: pin.x,
        y: pin.y,
        wbsTaskId: "",
        newStatus: "In Progress",
        newPct: "",
        installedQty: "",
        unitOfMeasure: "EA",
        notes: "",
        photos: [],
        confirmed: false,
        rowError: null,
      },
    ]);
  }
  function patchWorkPin(rowId: string, patch: Partial<WorkPin>) {
    setWorkPins((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  }
  function removeWorkPin(rowId: string) {
    setWorkPins((prev) => prev.filter((r) => r.rowId !== rowId));
  }

  // Every pin must have a WBS, status, % complete, installed qty, and a photo.
  function pinIncompleteReason(p: WorkPin): string | null {
    if (!p.wbsTaskId) return "Pick a WBS item";
    if (!p.newStatus) return "Pick a status";
    if (p.newPct.trim() === "") return "Enter % complete";
    if (p.installedQty.trim() === "") return "Enter installed quantity";
    if (!p.unitOfMeasure) return "Pick a unit";
    if (p.photos.length === 0) return "Add at least one photo";
    return null;
  }
  function savePin(rowId: string) {
    setWorkPins((prev) =>
      prev.map((r) => {
        if (r.rowId !== rowId) return r;
        const reason = pinIncompleteReason(r);
        return reason
          ? { ...r, rowError: reason, confirmed: false }
          : { ...r, rowError: null, confirmed: true };
      }),
    );
  }
  function editPin(rowId: string) {
    patchWorkPin(rowId, { confirmed: false });
  }

  async function onSubmit() {
    setError(null);
    const invalid = validateInputs();
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!narrative.trim()) {
      setError("Work narrative is required");
      return;
    }
    if (isFieldReport) {
      if (!reportSubId) {
        setError("Select which subcontractor this report is for");
        return;
      }
      if (workPins.length === 0) {
        setError("Mark at least one work item on the map");
        return;
      }
      if (workPins.some((p) => !p.confirmed)) {
        setError(
          "Save every pin first - each needs a WBS, status, % complete, installed quantity, and a photo.",
        );
        return;
      }
      await submitAsFieldReport();
      return;
    }
    if (updates.size === 0) {
      setError("Pick at least one schedule task that was worked on");
      return;
    }
    setSubmitting(true);
    const res = await submitDpr({
      projectId,
      reportDate,
      workNarrative: narrative,
      crewCount: effectiveCrewCount || null,
      totalManHours: effectiveHours || null,
      weatherConditions: weather || null,
      safetyIncident,
      nearMiss,
      safetyNarrative: safetyNarrative || null,
      taskUpdates: Array.from(updates.values()).map((u) => ({
        scheduleTaskId: u.taskId,
        newStatus: u.newStatus || null,
        newPctComplete: u.newPct ? Number(u.newPct) : null,
        installedQuantity: u.installed ? Number(u.installed) : null,
        notes: u.notes || null,
      })),
      manpower: manpower
        .filter((m) => Number(m.headcount) > 0 || Number(m.regularHours) > 0)
        .map((m) => ({
          subcontractorId: m.subcontractorId || null,
          trade: m.trade.trim() || null,
          headcount: Number(m.headcount) || 0,
          regularHours: Number(m.regularHours) || 0,
          otHours: Number(m.otHours) || 0,
          notes: m.notes.trim() || null,
        })),
      equipment: equipment.map((e) => ({
        equipmentName: e.equipmentName,
        quantity: Number(e.quantity) || 1,
        onRent: e.onRent,
        rentalCompany: e.rentalCompany.trim() || null,
        active: e.active,
        notes: e.notes.trim() || null,
      })),
      deliveries: deliveries.map((d) => ({
        vendorName: d.vendorName.trim() || null,
        materials: d.materials,
        quantity: d.quantity ? Number(d.quantity) : null,
        unitOfMeasure: d.unitOfMeasure.trim() || null,
        poNumber: d.poNumber.trim() || null,
        procurementOrderId: d.procurementOrderId || null,
        notes: d.notes.trim() || null,
      })),
      delays: delays.map((d) => ({
        causeCode: d.causeCode,
        hoursLost: d.hoursLost ? Number(d.hoursLost) : null,
        impactedScheduleTaskId: d.impactedScheduleTaskId || null,
        narrative: d.narrative.trim() || null,
      })),
      photos: photos.map((p) => ({
        photoId: p.photoId,
        storagePath: p.storagePath,
        caption: p.caption.trim() || null,
        photoType: p.photoType,
      })),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    clearDraft();
    startTransition(() => {
      router.push(`/projects/${projectId}/dprs/${res.dprId}`);
    });
  }

  // Field Report submit: DPR fields + subcontractor + work-done map pins.
  async function submitAsFieldReport() {
    setSubmitting(true);
    const res = await submitFieldReport({
      projectId,
      subcontractorId: reportSubId,
      reportDate,
      workNarrative: narrative,
      crewCount: effectiveCrewCount || null,
      totalManHours: fieldReportHours || null,
      weatherConditions: weather || null,
      safetyIncident,
      nearMiss,
      safetyNarrative: safetyNarrative || null,
      taskUpdates: Array.from(updates.values()).map((u) => ({
        scheduleTaskId: u.taskId,
        newStatus: u.newStatus || null,
        newPctComplete: u.newPct ? Number(u.newPct) : null,
        installedQuantity: u.installed ? Number(u.installed) : null,
        notes: u.notes || null,
      })),
      manpower: manpower
        .filter((m) => Number(m.headcount) > 0 || Number(m.regularHours) > 0)
        .map((m) => ({
          subcontractorId: m.subcontractorId || null,
          trade: m.trade.trim() || null,
          headcount: Number(m.headcount) || 0,
          regularHours: Number(m.regularHours) || 0,
          otHours: Number(m.otHours) || 0,
          notes: m.notes.trim() || null,
        })),
      equipment: equipment.map((e) => ({
        equipmentName: e.equipmentName,
        quantity: Number(e.quantity) || 1,
        onRent: e.onRent,
        rentalCompany: e.rentalCompany.trim() || null,
        active: e.active,
        notes: e.notes.trim() || null,
      })),
      deliveries: deliveries.map((d) => ({
        vendorName: d.vendorName.trim() || null,
        materials: d.materials,
        quantity: d.quantity ? Number(d.quantity) : null,
        unitOfMeasure: d.unitOfMeasure.trim() || null,
        poNumber: d.poNumber.trim() || null,
        procurementOrderId: d.procurementOrderId || null,
        notes: d.notes.trim() || null,
      })),
      delays: delays.map((d) => ({
        causeCode: d.causeCode,
        hoursLost: d.hoursLost ? Number(d.hoursLost) : null,
        impactedScheduleTaskId: d.impactedScheduleTaskId || null,
        narrative: d.narrative.trim() || null,
      })),
      photos: photos.map((p) => ({
        photoId: p.photoId,
        storagePath: p.storagePath,
        caption: p.caption.trim() || null,
        photoType: p.photoType,
      })),
      workPins: workPins.map((p) => ({
        title: pinLabel(p),
        inspectionType: null,
        scheduleTaskId: p.wbsTaskId || null,
        taskNewStatus: p.wbsTaskId ? p.newStatus || null : null,
        taskNewPct: p.wbsTaskId && p.newPct ? Number(p.newPct) : null,
        installedQuantity: p.installedQty ? Number(p.installedQty) : null,
        unitOfMeasure: p.installedQty ? p.unitOfMeasure || null : null,
        notes: p.notes.trim() || null,
        basemapKey: p.basemapKey,
        pinX: p.x,
        pinY: p.y,
        photos: p.photos,
      })),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    clearDraft();
    startTransition(() => {
      router.push(`/projects/${projectId}/field-reports/${res.dprId}`);
    });
  }

  return (
    <div className="space-y-6">
      {restored && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span>
            Restored your unsaved report from this device. Keep editing, or start
            over.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={discardDraft}
          >
            Discard draft
          </Button>
        </div>
      )}

      {/* ===== Day details ===== */}
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Day details</h3>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={copying}
            onClick={copyPrevious}
            title="Bring forward equipment and crew from the last report"
          >
            {copying ? "Copying..." : "Copy last report"}
          </Button>
        </div>
        {copyNote && (
          <p className="mt-1 text-[11px] text-muted-foreground">{copyNote}</p>
        )}
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="dpr-date">Report date</Label>
            <Input
              id="dpr-date"
              type="date"
              max={todayIso()}
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
            />
            {duplicateReport && (
              <p className="mt-1 text-[11px] text-amber-600">
                A report already exists for this date
                {isFieldReport ? " and subcontractor" : ""}. You can still file
                a correction.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="dpr-crew">
              Crew count
              {!crewOverride && manpowerTotals.headcount > 0 && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  (auto: {manpowerTotals.headcount})
                </span>
              )}
            </Label>
            <Input
              id="dpr-crew"
              type="number"
              value={crewOverride}
              onChange={(e) => setCrewOverride(e.target.value)}
              placeholder={
                manpowerTotals.headcount > 0
                  ? `auto ${manpowerTotals.headcount}`
                  : "e.g. 8"
              }
            />
          </div>
          {isFieldReport ? (
            <>
              <div>
                <Label htmlFor="dpr-hpd">Hours per day</Label>
                <Input
                  id="dpr-hpd"
                  type="number"
                  step="0.25"
                  value={hoursPerDay}
                  onChange={(e) => setHoursPerDay(e.target.value)}
                  placeholder="e.g. 8"
                />
              </div>
              <div>
                <Label>Total man-hours</Label>
                <div className="flex h-9 items-center rounded-md border border-input bg-muted/40 px-2 text-sm tabular-nums">
                  {fieldReportHours || 0}
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    (crew x hours/day)
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div>
              <Label htmlFor="dpr-hours">
                Total man-hours
                {!hoursOverride && manpowerTotals.hours > 0 && (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    (auto: {manpowerTotals.hours})
                  </span>
                )}
              </Label>
              <Input
                id="dpr-hours"
                type="number"
                step="0.25"
                value={hoursOverride}
                onChange={(e) => setHoursOverride(e.target.value)}
                placeholder={
                  manpowerTotals.hours > 0
                    ? `auto ${manpowerTotals.hours}`
                    : "e.g. 64"
                }
              />
            </div>
          )}
          <div className="sm:col-span-3">
            <Label htmlFor="dpr-weather">Weather</Label>
            <Input
              id="dpr-weather"
              value={weather}
              onChange={(e) => setWeather(e.target.value)}
              placeholder="e.g. Sunny 78F, light wind"
            />
          </div>
          <div className="sm:col-span-3">
            <Label htmlFor="dpr-narrative">Work narrative</Label>
            <textarea
              id="dpr-narrative"
              className={cn(
                "h-24 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
              placeholder="Crew installed 320 LF of trench, ran AC wire pulls to inverter pad..."
            />
          </div>
        </div>
      </section>

      {/* ===== Work done on the map (Field Report) ===== */}
      {isFieldReport && (
        <section className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">
                Work done - mark it on the map ({workPins.length})
              </h3>
              <p className="text-xs text-muted-foreground">
                Tap the site plan wherever you worked today. Each pin becomes an
                item the Construction Manager reviews and approves.
              </p>
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="fr-sub">Subcontractor filing this report</Label>
              <select
                id="fr-sub"
                value={reportSubId}
                onChange={(e) => setReportSubId(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">- Select sub -</option>
                {subs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.companyName}
                    {s.trade ? ` (${s.trade})` : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap gap-1">
              {(Object.keys(BASEMAPS) as BasemapKey[]).map((k) => {
                const count = workPins.filter(
                  (p) => p.basemapKey === k,
                ).length;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSheet(k)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium",
                      k === sheet
                        ? "border-foreground bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {BASEMAPS[k].key}
                    {count > 0 && (
                      <span
                        className={cn(
                          "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px]",
                          k === sheet
                            ? "bg-background/20"
                            : "bg-muted text-foreground",
                        )}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <InspectionMap
              basemapKey={sheet}
              pins={workPins
                .filter((p) => p.basemapKey === sheet)
                .map((p) => ({
                  id: p.rowId,
                  pinX: p.x,
                  pinY: p.y,
                  status: "submitted" as const,
                  title: pinLabel(p),
                }))}
              onPlace={addWorkPin}
            />
            <p className="text-xs text-muted-foreground">
              {BASEMAPS[sheet].label}. Each sheet keeps its own pins - switch
              sheets to log work on a different plan.
            </p>
          </div>

          {workPins.filter((p) => p.basemapKey === sheet).length > 0 && (
            <div className="mt-3 space-y-3">
              {workPins
                .filter((p) => p.basemapKey === sheet)
                .map((p) => {
                  const idx = workPins.findIndex((w) => w.rowId === p.rowId);
                  return (
                    <div
                      key={p.rowId}
                      className={cn(
                        "rounded-md border p-3",
                        p.confirmed
                          ? "border-emerald-300 bg-emerald-50/50"
                          : "bg-background",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">
                          {BASEMAPS[p.basemapKey].key} · Pin {idx + 1}
                          {p.confirmed && (
                            <span className="ml-2 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                              Saved
                            </span>
                          )}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeWorkPin(p.rowId)}
                        >
                          Remove
                        </Button>
                      </div>

                      {p.confirmed ? (
                        <div className="mt-1 space-y-1">
                          <div className="text-sm font-medium">
                            {pinLabel(p)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {p.newStatus} · {p.newPct}% · {p.installedQty}{" "}
                            {p.unitOfMeasure} installed · {p.photos.length} photo
                            {p.photos.length === 1 ? "" : "s"}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => editPin(p.rowId)}
                          >
                            Edit
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="mt-2">
                            <Label className="text-[10px]">
                              WBS / schedule item *
                            </Label>
                            <select
                              value={p.wbsTaskId}
                              onChange={(e) =>
                                patchWorkPin(p.rowId, {
                                  wbsTaskId: e.target.value,
                                })
                              }
                              className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                            >
                              <option value="">- Select the work item -</option>
                              {tasks.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.wbsCode} {t.taskName}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Progress on the WBS task - applied to the schedule
                              when the CM approves this pin. */}
                          <div className="mt-2 grid gap-2 sm:grid-cols-3">
                            <div>
                              <Label className="text-[10px]">Status *</Label>
                              <select
                                value={p.newStatus}
                                onChange={(e) =>
                                  patchWorkPin(p.rowId, {
                                    newStatus: e.target.value,
                                  })
                                }
                                className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                              >
                                {STATUS_OPTIONS.map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <Label className="text-[10px]">% complete *</Label>
                              <Input
                                type="number"
                                min="0"
                                max="100"
                                value={p.newPct}
                                onChange={(e) =>
                                  patchWorkPin(p.rowId, {
                                    newPct: e.target.value,
                                  })
                                }
                                placeholder="0-100"
                              />
                            </div>
                            <div>
                              <Label className="text-[10px]">
                                Installed qty *
                              </Label>
                              <div className="flex gap-1">
                                <Input
                                  type="number"
                                  step="0.001"
                                  value={p.installedQty}
                                  onChange={(e) =>
                                    patchWorkPin(p.rowId, {
                                      installedQty: e.target.value,
                                    })
                                  }
                                  placeholder="required"
                                  className="min-w-0 flex-1"
                                />
                                <select
                                  aria-label="Unit"
                                  value={p.unitOfMeasure}
                                  onChange={(e) =>
                                    patchWorkPin(p.rowId, {
                                      unitOfMeasure: e.target.value,
                                    })
                                  }
                                  className="h-9 rounded-md border border-input bg-background px-1 text-xs"
                                >
                                  {UNIT_OPTIONS.map((u) => (
                                    <option key={u} value={u}>
                                      {u}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          </div>

                          <Input
                            value={p.notes}
                            onChange={(e) =>
                              patchWorkPin(p.rowId, { notes: e.target.value })
                            }
                            placeholder="Notes (optional)"
                            className="mt-2"
                          />

                          <div className="mt-2">
                            <Label className="text-[10px]">
                              Photos * ({p.photos.length})
                            </Label>
                            <PhotoUploader
                              projectId={projectId}
                              side="sub"
                              onChange={(ph) =>
                                patchWorkPin(p.rowId, { photos: ph })
                              }
                            />
                          </div>

                          {p.rowError && (
                            <p className="mt-2 text-xs text-destructive">
                              {p.rowError}
                            </p>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            className="mt-2"
                            onClick={() => savePin(p.rowId)}
                          >
                            Save pin
                          </Button>
                        </>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </section>
      )}

      {/* ===== Photos (classic DPR only - Field Report photos live on each pin) ===== */}
      {!isFieldReport && (
        <section className="rounded-lg border bg-card p-4 shadow-sm">
          <h3 className="text-sm font-semibold">Photos ({photos.length})</h3>
          <p className="text-xs text-muted-foreground">
            Progress, safety, deliveries, issues, end-of-day. Foreman pics are
            the proof behind any status change.
          </p>
          <div className="mt-3">
            <DprPhotoUploader
              projectId={projectId}
              draftId={draftId}
              photos={photos}
              onChange={setPhotos}
            />
          </div>
        </section>
      )}

      {/* ===== Manpower (classic DPR only - Field Report uses crew count +
           total man-hours in Day details) ===== */}
      {!isFieldReport && (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              Manpower by sub / trade ({manpower.length})
            </h3>
            <p className="text-xs text-muted-foreground">
              Headcount and hours per sub. Rolls up into crew count and total
              man-hours unless you override above.
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={addManpowerRow}>
            Add row
          </Button>
        </div>
        {manpower.length > 0 && (
          <div className="mt-3 space-y-2">
            {manpower.map((m) => (
              <div
                key={m.rowId}
                className="grid gap-2 rounded-md border bg-background p-2 sm:grid-cols-[1fr_1fr_90px_90px_90px_auto]"
              >
                <select
                  value={m.subcontractorId}
                  onChange={(e) =>
                    patchManpower(m.rowId, { subcontractorId: e.target.value })
                  }
                  className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">- Sub (optional) -</option>
                  {subs.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.companyName}
                      {s.trade ? ` (${s.trade})` : ""}
                    </option>
                  ))}
                </select>
                <Input
                  value={m.trade}
                  onChange={(e) => patchManpower(m.rowId, { trade: e.target.value })}
                  placeholder="Trade (e.g. ironworker)"
                />
                <Input
                  type="number"
                  value={m.headcount}
                  onChange={(e) =>
                    patchManpower(m.rowId, { headcount: e.target.value })
                  }
                  placeholder="Heads"
                />
                <Input
                  type="number"
                  step="0.25"
                  value={m.regularHours}
                  onChange={(e) =>
                    patchManpower(m.rowId, { regularHours: e.target.value })
                  }
                  placeholder="Reg hrs"
                />
                <Input
                  type="number"
                  step="0.25"
                  value={m.otHours}
                  onChange={(e) =>
                    patchManpower(m.rowId, { otHours: e.target.value })
                  }
                  placeholder="OT hrs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeManpower(m.rowId)}
                >
                  Remove
                </Button>
                <Input
                  value={m.notes}
                  onChange={(e) => patchManpower(m.rowId, { notes: e.target.value })}
                  placeholder="Notes (optional)"
                  className="sm:col-span-6"
                />
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {/* ===== Equipment ===== */}
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Equipment on site ({equipment.length})</h3>
            <p className="text-xs text-muted-foreground">
              {isFieldReport
                ? "Equipment on site today. Mark each active or inactive."
                : "Owned or rented. Flag on-rent so we can track standby vs idle days."}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={addEquipmentRow}>
            Add row
          </Button>
        </div>
        {equipment.length > 0 && (
          <div className="mt-3 space-y-2">
            {equipment.map((e) => (
              <div
                key={e.rowId}
                className={cn(
                  "grid gap-2 rounded-md border bg-background p-2",
                  isFieldReport
                    ? "sm:grid-cols-[1fr_80px_120px_auto]"
                    : "sm:grid-cols-[1fr_80px_auto_1fr_auto]",
                )}
              >
                <Input
                  value={e.equipmentName}
                  onChange={(ev) =>
                    patchEquipment(e.rowId, { equipmentName: ev.target.value })
                  }
                  placeholder="e.g. 40-ton crane"
                />
                <Input
                  type="number"
                  value={e.quantity}
                  onChange={(ev) =>
                    patchEquipment(e.rowId, { quantity: ev.target.value })
                  }
                  placeholder="Qty"
                />
                {isFieldReport ? (
                  <select
                    value={e.active ? "active" : "inactive"}
                    onChange={(ev) =>
                      patchEquipment(e.rowId, {
                        active: ev.target.value === "active",
                      })
                    }
                    className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                ) : (
                  <>
                    <label className="flex items-center gap-2 px-2 text-xs">
                      <input
                        type="checkbox"
                        checked={e.onRent}
                        onChange={(ev) =>
                          patchEquipment(e.rowId, { onRent: ev.target.checked })
                        }
                      />
                      On rent
                    </label>
                    <Input
                      value={e.rentalCompany}
                      onChange={(ev) =>
                        patchEquipment(e.rowId, {
                          rentalCompany: ev.target.value,
                        })
                      }
                      placeholder="Rental company"
                    />
                  </>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeEquipment(e.rowId)}
                >
                  Remove
                </Button>
                <Input
                  value={e.notes}
                  onChange={(ev) => patchEquipment(e.rowId, { notes: ev.target.value })}
                  placeholder="Notes (optional)"
                  className={isFieldReport ? "sm:col-span-4" : "sm:col-span-5"}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ===== Deliveries ===== */}
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Deliveries ({deliveries.length})</h3>
            <p className="text-xs text-muted-foreground">
              Materials received today.
              {!isFieldReport &&
                " Link to a PO so the procurement page sees actual arrival."}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={addDeliveryRow}>
            Add row
          </Button>
        </div>
        {deliveries.length > 0 && (
          <div className="mt-3 space-y-2">
            {deliveries.map((d) => (
              <div
                key={d.rowId}
                className={cn(
                  "grid gap-2 rounded-md border bg-background p-2",
                  isFieldReport
                    ? "sm:grid-cols-[1fr_1fr_90px_80px_auto]"
                    : "sm:grid-cols-[1fr_1fr_90px_80px_1fr_auto]",
                )}
              >
                <Input
                  value={d.vendorName}
                  onChange={(ev) =>
                    patchDelivery(d.rowId, { vendorName: ev.target.value })
                  }
                  placeholder="Vendor"
                />
                <Input
                  value={d.materials}
                  onChange={(ev) =>
                    patchDelivery(d.rowId, { materials: ev.target.value })
                  }
                  placeholder="Materials"
                />
                <Input
                  type="number"
                  step="0.01"
                  value={d.quantity}
                  onChange={(ev) =>
                    patchDelivery(d.rowId, { quantity: ev.target.value })
                  }
                  placeholder="Qty"
                />
                <select
                  aria-label="Unit of measure"
                  value={d.unitOfMeasure}
                  onChange={(ev) =>
                    patchDelivery(d.rowId, { unitOfMeasure: ev.target.value })
                  }
                  className="h-9 rounded-md border border-input bg-background px-1 text-xs"
                >
                  <option value="">UoM</option>
                  {UNIT_OPTIONS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
                {!isFieldReport && (
                  <select
                    value={d.procurementOrderId}
                    onChange={(ev) =>
                      patchDelivery(d.rowId, {
                        procurementOrderId: ev.target.value,
                      })
                    }
                    className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="">- Link PO (optional) -</option>
                    {procurementOrders.map((po) => (
                      <option key={po.id} value={po.id}>
                        {po.poNumber ? `${po.poNumber} - ` : ""}
                        {po.vendorName}
                        {po.description ? ` (${po.description})` : ""}
                      </option>
                    ))}
                  </select>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeDelivery(d.rowId)}
                >
                  Remove
                </Button>
                {!isFieldReport && (
                  <Input
                    value={d.poNumber}
                    onChange={(ev) =>
                      patchDelivery(d.rowId, { poNumber: ev.target.value })
                    }
                    placeholder="PO # (if no link)"
                    className="sm:col-span-2"
                  />
                )}
                <Input
                  value={d.notes}
                  onChange={(ev) => patchDelivery(d.rowId, { notes: ev.target.value })}
                  placeholder="Notes (optional)"
                  className={isFieldReport ? "sm:col-span-5" : "sm:col-span-4"}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ===== Delays ===== */}
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Delays ({delays.length})</h3>
            <p className="text-xs text-muted-foreground">
              Anything that cost time today. Cause code + hours lost lets us
              report total weather/manpower/owner delay by month.
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={addDelayRow}>
            Add row
          </Button>
        </div>
        {delays.length > 0 && (
          <div className="mt-3 space-y-2">
            {delays.map((d) => (
              <div
                key={d.rowId}
                className="grid gap-2 rounded-md border bg-background p-2 sm:grid-cols-[150px_100px_1fr_auto]"
              >
                <select
                  value={d.causeCode}
                  onChange={(ev) =>
                    patchDelay(d.rowId, { causeCode: ev.target.value })
                  }
                  className="h-9 rounded-md border border-input bg-background px-2 text-xs capitalize"
                >
                  {DELAY_CAUSE_CODES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <Input
                  type="number"
                  step="0.25"
                  value={d.hoursLost}
                  onChange={(ev) =>
                    patchDelay(d.rowId, { hoursLost: ev.target.value })
                  }
                  placeholder="Hours lost"
                />
                <select
                  value={d.impactedScheduleTaskId}
                  onChange={(ev) =>
                    patchDelay(d.rowId, { impactedScheduleTaskId: ev.target.value })
                  }
                  className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">- Impacted task (optional) -</option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.wbsCode} {t.taskName}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeDelay(d.rowId)}
                >
                  Remove
                </Button>
                <Input
                  value={d.narrative}
                  onChange={(ev) =>
                    patchDelay(d.rowId, { narrative: ev.target.value })
                  }
                  placeholder="What happened"
                  className="sm:col-span-4"
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ===== Safety ===== */}
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">Safety</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={safetyIncident}
              onChange={(e) => setSafetyIncident(e.target.checked)}
            />
            Safety incident
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={nearMiss}
              onChange={(e) => setNearMiss(e.target.checked)}
            />
            Near miss
          </label>
          <div className="sm:col-span-3">
            <Label htmlFor="dpr-safety">Safety narrative</Label>
            <Input
              id="dpr-safety"
              value={safetyNarrative}
              onChange={(e) => setSafetyNarrative(e.target.value)}
              placeholder="Describe any incidents or hazards observed"
            />
          </div>
        </div>
      </section>

      {/* ===== Schedule task updates (classic DPR only) ===== */}
      {/* In a Field Report the WBS + progress live on each map pin instead, so
          this section is hidden and the schedule updates when the CM approves a
          pin. */}
      {!isFieldReport && (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              Schedule task updates ({updates.size} selected)
            </h3>
            <p className="text-xs text-muted-foreground">
              Pick tasks worked on today. Click each to add. On approval the
              schedule reflects these.
            </p>
          </div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search WBS or task name"
            className="max-w-xs"
          />
        </div>

        {updates.size > 0 && (
          <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-3">
            {Array.from(updates.values()).map((u) => {
              const t = tasks.find((x) => x.id === u.taskId);
              if (!t) return null;
              return (
                <div
                  key={u.taskId}
                  className="grid gap-2 rounded-md border bg-background p-2 sm:grid-cols-[1fr_140px_120px_120px_auto]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-mono">{t.wbsCode}</div>
                    <div className="truncate text-sm font-medium">{t.taskName}</div>
                    <div className="text-[10px] text-muted-foreground">
                      Current: {t.currentStatus ?? "-"} ({t.currentPct ?? "?"}%)
                    </div>
                  </div>
                  <div>
                    <Label htmlFor={`status-${t.id}`} className="text-[10px]">
                      New status
                    </Label>
                    <select
                      id={`status-${t.id}`}
                      value={u.newStatus}
                      onChange={(e) =>
                        patchUpdate(u.taskId, { newStatus: e.target.value })
                      }
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor={`pct-${t.id}`} className="text-[10px]">
                      % complete
                    </Label>
                    <Input
                      id={`pct-${t.id}`}
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={u.newPct}
                      onChange={(e) =>
                        patchUpdate(u.taskId, { newPct: e.target.value })
                      }
                      placeholder="0-100"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`qty-${t.id}`} className="text-[10px]">
                      Installed qty
                    </Label>
                    <Input
                      id={`qty-${t.id}`}
                      type="number"
                      step="0.001"
                      value={u.installed}
                      onChange={(e) =>
                        patchUpdate(u.taskId, { installed: e.target.value })
                      }
                      placeholder="(optional)"
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleTask(t)}
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="sm:col-span-5">
                    <Input
                      value={u.notes}
                      onChange={(e) =>
                        patchUpdate(u.taskId, { notes: e.target.value })
                      }
                      placeholder="Notes for this task (optional)"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-3 max-h-96 overflow-y-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr className="border-b">
                <th className="w-10 px-2 py-1.5"></th>
                <th className="px-2 py-1.5 text-left font-medium">WBS</th>
                <th className="px-2 py-1.5 text-left font-medium">Task</th>
                <th className="px-2 py-1.5 text-left font-medium">Phase</th>
                <th className="px-2 py-1.5 text-left font-medium">Status</th>
                <th className="px-2 py-1.5 text-right font-medium">End date</th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.map((t) => {
                const selected = updates.has(t.id);
                return (
                  <tr
                    key={t.id}
                    className={cn(
                      "border-b last:border-0 hover:bg-muted/30",
                      selected && "bg-emerald-500/5",
                    )}
                  >
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleTask(t)}
                      />
                    </td>
                    <td className="px-2 py-1.5 font-mono">{t.wbsCode}</td>
                    <td className="px-2 py-1.5">{t.taskName}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {t.phase ?? "-"}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {t.currentStatus ?? "-"}
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">
                      {t.endDate ?? "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredTasks.length === 0 && (
            <div className="border-t bg-muted/30 px-2 py-2 text-center text-[10px] text-muted-foreground">
              No tasks match the search.
            </div>
          )}
        </div>
      </section>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          onClick={() => router.back()}
        >
          Cancel
        </Button>
        <Button type="button" disabled={submitting} onClick={onSubmit}>
          {submitting
            ? "Submitting..."
            : isFieldReport
              ? "Submit Field Report"
              : "Submit DPR"}
        </Button>
      </div>
    </div>
  );
}
