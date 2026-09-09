"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import {
  BASEMAPS,
  type BasemapKey,
  type NormalizedPin,
} from "@/lib/inspection-map";
import { PICKER_GROUP_LABEL, type PickerGroup } from "@/lib/schedule-picker";
import { UNIT_OPTIONS, WORK_STATUS_OPTIONS } from "@/lib/work-pin-options";
import { splitPinNotes } from "@/lib/pin-notes";
import {
  STATUS_STYLE,
  statusLabel,
  type InspectionStatus,
} from "@/lib/inspection-status";
import { InspectionMap } from "../../inspections/inspection-map";
import {
  PhotoUploader,
  type UploadedPhoto,
} from "../../inspections/photo-uploader";
import {
  reviewApproveInspection,
  reviewRejectInspection,
} from "../../inspections/inspection-actions";
import {
  resubmitFieldReportPin,
  type PinCorrection,
} from "../../field-report-actions";

export type ReviewPhoto = {
  id: string;
  url: string;
  side: string; // 'sub' = subcontractor submission, 'ahc' = CM verification
  caption: string | null;
};

export type ReviewPin = {
  id: string;
  title: string;
  status: InspectionStatus;
  origin: string; // 'sub' | 'cm' (cm is legacy and filtered out here)
  basemapKey: string;
  pinX: number | null;
  pinY: number | null;
  inspectionType: string | null;
  notes: string | null;
  // The correctable half of the pin, echoed back so a rejected card can open
  // pre-filled with what was actually filed.
  scheduleTaskId: string | null;
  taskNewStatus: string | null;
  taskNewPct: number | null;
  quantity: number | null;
  unitOfMeasure: string | null;
  decisionNotes: string | null; // CM's reason when this item was rejected
  subAcknowledgedAt: string | null; // set when the sub confirms the record
  wbsLabel: string | null;
  progress: string | null;
  photos: ReviewPhoto[];
};

// One option in the "which activity is this?" picker, already filtered to leaf
// tasks and ordered by what is in play (src/lib/schedule-picker.ts).
export type PickerOption = {
  id: string;
  wbsCode: string;
  taskName: string;
  currentStatus: string | null;
  currentPct: number | null;
  group?: PickerGroup;
};

// A pending pin move: the sheet and normalised coordinates the sub tapped,
// held until they resubmit the item.
type Relocation = { basemapKey: BasemapKey; x: number; y: number };

type Props = {
  projectId: string;
  pins: ReviewPin[];
  // The WBS list a rejected pin may be re-pointed at.
  tasks: PickerOption[];
  canReview: boolean;
  canDecide: boolean;
  // The owning sub (or an AHC user) may resubmit a returned report one flagged
  // pin at a time, from inside that pin's card.
  canResubmit: boolean;
};

// Collapse the 4-value status enum to the 3 states the CM sees: submitted work
// is "Pending" (yellow), plus Approved (green) and Rejected (red). The legacy
// blue "under review" is treated as pending.
function displayStatus(s: InspectionStatus): "pending" | "approved" | "rejected" {
  if (s === "approved") return "approved";
  if (s === "rejected") return "rejected";
  return "pending";
}

export function FieldReportReview({
  projectId,
  pins,
  tasks,
  canReview,
  canDecide,
  canResubmit,
}: Props) {
  // Only the subcontractor's work items are reviewed on the map. Legacy CM
  // own-check pins ('cm') are no longer created and are hidden here.
  const subPins = useMemo(() => pins.filter((p) => p.origin !== "cm"), [pins]);

  const firstSheet = (subPins[0]?.basemapKey as BasemapKey) ?? "C2-01";
  const [sheet, setSheet] = useState<BasemapKey>(
    firstSheet in BASEMAPS ? firstSheet : "C2-01",
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  // Pin-move mode for a rejected item being corrected. The map is in the other
  // column from the card that owns the edit, so the mode lives up here: while
  // movingId is set, tapping the sheet re-places that pin instead of selecting.
  const [movingId, setMovingId] = useState<string | null>(null);
  const [relocations, setRelocations] = useState<Record<string, Relocation>>({});

  // Moving a pin is scoped to the card that started it. Opening a different
  // work item ends the mode, so a stray tap can never re-place a pin the sub
  // is no longer looking at.
  function selectPin(id: string) {
    setActiveId(id);
    setMovingId((cur) => (cur === id ? cur : null));
  }

  const active = subPins.find((p) => p.id === activeId) ?? null;

  // Report progress: how far the CM has gotten through this report's items.
  const progress = useMemo(() => {
    const total = subPins.length;
    let approved = 0;
    let rejected = 0;
    for (const p of subPins) {
      if (p.status === "approved") approved += 1;
      else if (p.status === "rejected") rejected += 1;
    }
    const pending = total - approved - rejected;
    return { total, approved, rejected, pending };
  }, [subPins]);

  // A pin the sub has moved but not yet resubmitted draws at its new spot, on
  // its new sheet, so the map matches what the card says it will file.
  const mapPins = useMemo(
    () =>
      subPins
        .map((p) => {
          const moved = relocations[p.id];
          return {
            id: p.id,
            basemapKey: moved ? moved.basemapKey : (p.basemapKey as string),
            pinX: moved ? moved.x : p.pinX,
            pinY: moved ? moved.y : p.pinY,
            status: p.status,
            title: p.title,
            origin: p.origin,
          };
        })
        .filter((p) => p.basemapKey === sheet),
    [subPins, relocations, sheet],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1">
            {(Object.keys(BASEMAPS) as BasemapKey[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setSheet(k)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium",
                  k === sheet
                    ? "border-foreground bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {BASEMAPS[k].key}
              </button>
            ))}
          </div>
          <ThreeStateLegend />
        </div>

        <InspectionMap
          basemapKey={sheet}
          pins={mapPins}
          activeId={activeId}
          onSelect={selectPin}
          onPlace={
            movingId
              ? (p: NormalizedPin) =>
                  setRelocations((prev) => ({
                    ...prev,
                    [movingId]: { basemapKey: sheet, x: p.x, y: p.y },
                  }))
              : undefined
          }
        />
        <p className="text-xs text-muted-foreground">
          {BASEMAPS[sheet].label}.{" "}
          {movingId
            ? "Tap the spot to move the pin you are correcting."
            : "Click a work item to review it."}
        </p>
      </div>

      <div className="space-y-3">
        {progress.total > 0 && (
          <div className="rounded-lg border bg-card px-3 py-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">Review progress</span>
              <span className="tabular-nums text-muted-foreground">
                {progress.approved} of {progress.total} approved
              </span>
            </div>
            <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
              {progress.approved > 0 && (
                <div
                  className="bg-emerald-500"
                  style={{
                    width: `${(progress.approved / progress.total) * 100}%`,
                  }}
                />
              )}
              {progress.rejected > 0 && (
                <div
                  className="bg-red-500"
                  style={{
                    width: `${(progress.rejected / progress.total) * 100}%`,
                  }}
                />
              )}
            </div>
            {(progress.pending > 0 || progress.rejected > 0) && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {progress.pending > 0 && `${progress.pending} pending`}
                {progress.pending > 0 && progress.rejected > 0 && " · "}
                {progress.rejected > 0 && `${progress.rejected} rejected`}
              </p>
            )}
          </div>
        )}

        <PinList
          heading={`Subcontractor work (${subPins.length})`}
          pins={subPins}
          activeId={activeId}
          onSelect={selectPin}
        />

        {active && (
          <PinReview
            key={active.id}
            projectId={projectId}
            pin={active}
            tasks={tasks}
            canReview={canReview}
            canDecide={canDecide}
            canResubmit={canResubmit}
            moving={movingId === active.id}
            relocation={relocations[active.id] ?? null}
            onStartMove={() => setMovingId(active.id)}
            onCancelMove={() => setMovingId(null)}
          />
        )}
      </div>
    </div>
  );
}

// The single review surface for one work item: photos, and (for the approver)
// approve-with-photo / reject-with-reason.
function PinReview({
  projectId,
  pin,
  tasks,
  canReview,
  canDecide,
  canResubmit,
  moving,
  relocation,
  onStartMove,
  onCancelMove,
}: {
  projectId: string;
  pin: ReviewPin;
  tasks: PickerOption[];
  canReview: boolean;
  canDecide: boolean;
  canResubmit: boolean;
  moving: boolean;
  relocation: Relocation | null;
  onStartMove: () => void;
  onCancelMove: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  // Sub's correction surface (returned report). Every field the sub filled in
  // when they dropped the pin is editable here, seeded with what was filed -
  // the CM's usual rejection is "wrong activity", which no amount of extra
  // photos can fix.
  // The activity this pin was filed against may no longer be offerable - older
  // pins were allowed onto summary lines, which the picker now hides because
  // pinning to one writes a rollup percent onto the schedule. Open blank in
  // that case and say why, rather than showing a dropdown that looks like it
  // lost the sub's answer.
  const filedTaskOffered =
    pin.scheduleTaskId != null &&
    tasks.some((t) => t.id === pin.scheduleTaskId);
  const filedTaskUnpinnable = pin.scheduleTaskId != null && !filedTaskOffered;
  const [taskId, setTaskId] = useState(
    filedTaskOffered ? (pin.scheduleTaskId as string) : "",
  );
  const [status, setStatus] = useState(pin.taskNewStatus ?? "In Progress");
  const [pct, setPct] = useState(
    pin.taskNewPct != null ? String(pin.taskNewPct) : "",
  );
  const [qty, setQty] = useState(
    pin.quantity != null ? String(pin.quantity) : "",
  );
  const [unit, setUnit] = useState(pin.unitOfMeasure ?? "EA");
  // The correction history is not the sub's to rewrite, so the editor gets the
  // note body only and the trail is shown read-only beneath it.
  const filedNotes = useMemo(() => splitPinNotes(pin.notes), [pin.notes]);
  const [workNotes, setWorkNotes] = useState(filedNotes.body);
  const [fixPhotos, setFixPhotos] = useState<UploadedPhoto[]>([]);
  const [fixNotes, setFixNotes] = useState("");
  // Sub-side photos the sub has struck off (wrong picture on the card).
  const [dropped, setDropped] = useState<Set<string>>(() => new Set());

  const view = displayStatus(pin.status);
  const subPhotos = pin.photos.filter((p) => p.side !== "ahc");
  const cmPhotos = pin.photos.filter((p) => p.side === "ahc");
  const hasCmPhoto = cmPhotos.length > 0 || photos.length > 0;
  const editing = view === "rejected" && canResubmit;
  const keptSubPhotos = subPhotos.filter((p) => !dropped.has(p.id));

  function toggleDropped(id: string) {
    setDropped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function approve() {
    setError(null);
    if (!hasCmPhoto) return setError("Add your photo before approving.");
    startTransition(async () => {
      const res = await reviewApproveInspection({
        inspectionId: pin.id,
        projectId,
        ahcNotes: notes.trim() || null,
        photos,
      });
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  function reject() {
    setError(null);
    if (!reason.trim()) return setError("A reason is required to reject.");
    startTransition(async () => {
      const res = await reviewRejectInspection({
        inspectionId: pin.id,
        projectId,
        reason: reason.trim(),
      });
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  // What actually changed on the card, in the shape the server validates. Keys
  // are omitted where the pin never had a value and the sub did not add one, so
  // a legacy pin with no WBS link is still resubmittable.
  function buildCorrections(): PinCorrection {
    const c: PinCorrection = {};
    if (taskId || pin.scheduleTaskId) c.scheduleTaskId = taskId || null;
    if (status || pin.taskNewStatus) c.taskNewStatus = status || null;
    if (pct.trim() !== "" || pin.taskNewPct != null)
      c.taskNewPct = pct.trim() === "" ? null : Number(pct);
    if (qty.trim() !== "" || pin.quantity != null)
      c.installedQuantity = qty.trim() === "" ? null : Number(qty);
    if (unit || pin.unitOfMeasure) c.unitOfMeasure = unit || null;
    c.notes = workNotes;
    if (relocation) {
      c.basemapKey = relocation.basemapKey;
      c.pinX = relocation.x;
      c.pinY = relocation.y;
    }
    return c;
  }

  function resubmit() {
    setError(null);
    if (!fixNotes.trim())
      return setError("Describe what you fixed before resubmitting.");
    if (keptSubPhotos.length + fixPhotos.length === 0)
      return setError("Keep or add at least one photo of the work.");
    startTransition(async () => {
      const res = await resubmitFieldReportPin({
        pinId: pin.id,
        projectId,
        fixNotes: fixNotes.trim(),
        corrections: buildCorrections(),
        removePhotoIds: Array.from(dropped),
        photos: fixPhotos.map((ph) => ({
          storagePath: ph.storagePath,
          caption: ph.caption,
          gpsLat: ph.gpsLat,
          gpsLng: ph.gpsLng,
          takenAt: ph.takenAt,
        })),
      });
      if (!res.ok) return setError(res.error);
      onCancelMove();
      router.refresh();
    });
  }

  const canSubmitFix =
    fixNotes.trim().length > 0 && keptSubPhotos.length + fixPhotos.length > 0;
  const selectedTask = tasks.find((t) => t.id === taskId) ?? null;

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{pin.title}</h4>
        <span
          className={cn(
            "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
            STATUS_STYLE[pin.status].chip,
          )}
        >
          {statusLabel(pin.status)}
        </span>
      </div>

      {/* The filed record. While the sub is correcting it, the editable copy
          below is the truth, so this read-only block steps aside. */}
      {!editing && (
        <>
          {pin.wbsLabel && (
            <p className="text-xs text-muted-foreground">{pin.wbsLabel}</p>
          )}
          {pin.progress && (
            <p className="rounded-md bg-muted/60 px-2 py-1 text-xs">
              <span className="font-medium">Approving applies:</span>{" "}
              {pin.progress}
            </p>
          )}
          {pin.inspectionType && (
            <p className="text-xs text-muted-foreground">{pin.inspectionType}</p>
          )}
          {pin.notes && <p className="whitespace-pre-wrap text-sm">{pin.notes}</p>}
          <PhotoStrip label="Submitted photos" photos={subPhotos} />
        </>
      )}
      <PhotoStrip label="CM verification photos" photos={cmPhotos} />

      {view === "approved" && (
        <div className="space-y-1 rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
          <p>Approved and locked.</p>
          {pin.subAcknowledgedAt && (
            <p className="text-emerald-700">
              Sub confirmed {formatDate(pin.subAcknowledgedAt)}.
            </p>
          )}
        </div>
      )}
      {view === "rejected" && (
        <div className="space-y-1 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800">
          <p className="font-medium">
            Rejected - returned to the sub to fix and resubmit.
          </p>
          {pin.decisionNotes && (
            <p className="whitespace-pre-wrap">
              <span className="font-medium">Reason:</span> {pin.decisionNotes}
            </p>
          )}
        </div>
      )}

      {/* Sub's correction surface, right in the card: the whole work item is
          editable, not just its photos. Fixing a wrong activity used to mean
          asking AHC to delete the report and refiling the entire day. */}
      {editing && (
        <div className="space-y-3 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Correct anything that was wrong, then resubmit. This item goes back
            to the CM on its own - the rest of the report is untouched.
          </p>

          <div>
            <Label className="text-[10px]">WBS / schedule activity *</Label>
            <select
              value={taskId}
              onChange={(e) => {
                const next = e.target.value;
                setTaskId(next);
                // Same rule as the report form: picking an activity carries its
                // CURRENT percent into the box, because the field means "total
                // done to date", not "how much of today".
                const t = tasks.find((x) => x.id === next);
                if (t) {
                  setPct(t.currentPct != null ? String(t.currentPct) : "");
                  setStatus(
                    t.currentStatus === "Complete" ? "Complete" : "In Progress",
                  );
                }
              }}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="">- Select the work item -</option>
              {(["open", "soon", "other"] as PickerGroup[]).map((g) => {
                const inGroup = tasks.filter((t) => (t.group ?? "other") === g);
                if (inGroup.length === 0) return null;
                return (
                  <optgroup key={g} label={PICKER_GROUP_LABEL[g]}>
                    {inGroup.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.wbsCode} {t.taskName}
                        {t.currentPct != null ? ` (${t.currentPct}%)` : ""}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            {filedTaskUnpinnable && (
              <p className="mt-1 text-[10px] text-amber-700">
                Filed against {pin.wbsLabel ?? "a summary line"}, which is a
                summary line and cannot be pinned to. Pick the specific work
                item underneath it.
              </p>
            )}
            {!filedTaskUnpinnable &&
              pin.scheduleTaskId &&
              taskId !== pin.scheduleTaskId && (
                <p className="mt-1 text-[10px] text-amber-700">
                  Activity changed from {pin.wbsLabel ?? "the original item"}.
                  The card is retitled when you resubmit.
                </p>
              )}
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <div>
              <Label className="text-[10px]">Status *</Label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                {WORK_STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-[10px]">Total % done to date *</Label>
              <Input
                type="number"
                min="0"
                max="100"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                placeholder="0-100"
              />
              {selectedTask?.currentPct != null &&
                (() => {
                  const entered = Number(pct);
                  const lower =
                    pct.trim() !== "" &&
                    Number.isFinite(entered) &&
                    entered < (selectedTask.currentPct ?? 0);
                  return (
                    <p
                      className={`mt-1 text-[10px] ${lower ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {lower
                        ? `Schedule shows ${selectedTask.currentPct}% - this lowers it. Enter the total done, not today's work.`
                        : `Schedule shows ${selectedTask.currentPct}%`}
                    </p>
                  );
                })()}
            </div>
            <div>
              <Label className="text-[10px]">Installed qty *</Label>
              <div className="flex gap-1">
                <Input
                  type="number"
                  step="0.001"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="required"
                  className="min-w-0 flex-1"
                />
                <select
                  aria-label="Unit"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
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

          <div className="space-y-1">
            <Label className="text-[10px]">Notes</Label>
            <textarea
              value={workNotes}
              onChange={(e) => setWorkNotes(e.target.value)}
              rows={2}
              className="w-full rounded-md border bg-background p-2 text-sm"
              placeholder="What the crew did here"
            />
            {filedNotes.trail.length > 0 && (
              <div className="rounded-md bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
                <p className="font-medium">Correction history</p>
                {filedNotes.trail.map((t, i) => (
                  <p key={i} className="whitespace-pre-wrap">
                    {t}
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* Location. The map lives in the other column, so moving a pin is a
              mode: tap the sheet you want, then tap the spot. */}
          <div className="space-y-1">
            <Label className="text-[10px]">Location on the drawings</Label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {relocation
                  ? `Moved to ${relocation.basemapKey}`
                  : BASEMAPS[pin.basemapKey as BasemapKey]?.key ??
                    pin.basemapKey}
              </span>
              {moving ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onCancelMove}
                >
                  Done moving
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onStartMove}
                >
                  {relocation ? "Move again" : "Move pin"}
                </Button>
              )}
            </div>
            {moving && (
              <p className="text-[10px] text-amber-700">
                Pick the sheet above the map, then tap where the work actually
                is.
              </p>
            )}
          </div>

          {/* Photos already on the card, with a way to strike off the wrong
              one. At least one photo of the work has to survive. */}
          {subPhotos.length > 0 && (
            <div className="space-y-1">
              <Label className="text-[10px]">
                Photos on this item ({keptSubPhotos.length} kept)
              </Label>
              <div className="flex flex-wrap gap-2">
                {subPhotos.map((p) => {
                  const off = dropped.has(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleDropped(p.id)}
                      title={off ? "Keep this photo" : "Remove this photo"}
                      className={cn(
                        "relative h-20 w-20 overflow-hidden rounded-md border bg-muted",
                        off && "opacity-40 ring-2 ring-destructive",
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={p.url}
                        alt={p.caption ?? "Submitted photo"}
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-[9px] font-medium text-white">
                        {off ? "Removing" : "Remove"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-[10px]">Add photos</Label>
              {fixPhotos.length > 0 && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-900">
                  {fixPhotos.length} added
                </span>
              )}
            </div>
            <PhotoUploader
              projectId={projectId}
              side="sub"
              onChange={setFixPhotos}
            />
          </div>

          <div>
            <Label className="text-[10px]">What did you fix? (required)</Label>
            <textarea
              value={fixNotes}
              onChange={(e) => setFixNotes(e.target.value)}
              rows={2}
              className="w-full rounded-md border bg-background p-2 text-sm"
              placeholder="e.g. pinned to the wrong activity, moved it to 5.1.2.10"
            />
          </div>

          <Button
            size="sm"
            disabled={pending || !canSubmitFix}
            onClick={resubmit}
            title={
              canSubmitFix
                ? undefined
                : "Say what you fixed, and keep at least one photo"
            }
          >
            {pending ? "Resubmitting…" : "Resubmit item"}
          </Button>
        </div>
      )}

      {/* Approver review surface, only while the item is pending. */}
      {view === "pending" && canReview && (
        <div className="space-y-2 border-t pt-3">
          {!canDecide ? (
            <p className="text-xs text-muted-foreground">
              Awaiting the QA/QC approver. Only the approver can approve or
              reject.
            </p>
          ) : rejecting ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Reason for rejection (sent to the sub)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="w-full rounded-md border bg-background p-2 text-sm"
                placeholder="What needs to be fixed?"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={pending}
                  onClick={reject}
                >
                  {pending ? "Rejecting…" : "Confirm reject"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setRejecting(false);
                    setReason("");
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Your verification photo (required to approve)
              </label>
              <PhotoUploader
                projectId={projectId}
                side="ahc"
                inspectionId={pin.id}
                onChange={setPhotos}
              />
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Note (optional)"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || !hasCmPhoto}
                  onClick={approve}
                  title={hasCmPhoto ? undefined : "Add your photo first"}
                >
                  {pending ? "Approving…" : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setRejecting(true);
                    setError(null);
                  }}
                >
                  Reject
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// Thumbnails of a pin's uploaded photos. URLs are short-lived signed links
// minted server-side (the inspection-photos bucket is private).
function PhotoStrip({
  label,
  photos,
}: {
  label: string;
  photos: ReviewPhoto[];
}) {
  if (photos.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label} ({photos.length})
      </p>
      <div className="flex flex-wrap gap-2">
        {photos.map((p, i) => (
          <a
            key={`${p.url}-${i}`}
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            title={p.caption ?? "Open full size"}
            className="block h-20 w-20 overflow-hidden rounded-md border bg-muted"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.url}
              alt={p.caption ?? label}
              className="h-full w-full object-cover"
            />
          </a>
        ))}
      </div>
    </div>
  );
}

function PinList({
  heading,
  pins,
  activeId,
  onSelect,
}: {
  heading: string;
  pins: ReviewPin[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </div>
      {pins.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">None.</p>
      ) : (
        <ul>
          {pins.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-muted/40",
                  activeId === p.id && "bg-muted/60",
                )}
              >
                <span className="truncate">{p.title}</span>
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-full border border-white shadow"
                  style={{ backgroundColor: STATUS_STYLE[p.status].pin }}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Three-state key: Pending (yellow) / Approved (green) / Rejected (red).
function ThreeStateLegend() {
  const items: Array<{ label: string; color: string }> = [
    { label: "Pending", color: STATUS_STYLE.submitted.pin },
    { label: "Approved", color: STATUS_STYLE.approved.pin },
    { label: "Rejected", color: STATUS_STYLE.rejected.pin },
  ];
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-full border border-white shadow"
            style={{ backgroundColor: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}
