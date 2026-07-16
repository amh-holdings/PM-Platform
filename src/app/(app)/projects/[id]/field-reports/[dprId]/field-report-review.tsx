"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { BASEMAPS, type BasemapKey } from "@/lib/inspection-map";
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

export type ReviewPhoto = {
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
  decisionNotes: string | null; // CM's reason when this item was rejected
  subAcknowledgedAt: string | null; // set when the sub confirms the record
  wbsLabel: string | null;
  progress: string | null;
  photos: ReviewPhoto[];
};

type Props = {
  projectId: string;
  pins: ReviewPin[];
  canReview: boolean;
  canDecide: boolean;
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
  canReview,
  canDecide,
}: Props) {
  // Only the subcontractor's work items are reviewed on the map. Legacy CM
  // own-check pins ('cm') are no longer created and are hidden here.
  const subPins = useMemo(() => pins.filter((p) => p.origin !== "cm"), [pins]);

  const firstSheet = (subPins[0]?.basemapKey as BasemapKey) ?? "C2-01";
  const [sheet, setSheet] = useState<BasemapKey>(
    firstSheet in BASEMAPS ? firstSheet : "C2-01",
  );
  const [activeId, setActiveId] = useState<string | null>(null);

  const onSheet = useMemo(
    () => subPins.filter((p) => p.basemapKey === sheet),
    [subPins, sheet],
  );
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

  const mapPins = onSheet.map((p) => ({
    id: p.id,
    pinX: p.pinX,
    pinY: p.pinY,
    status: p.status,
    title: p.title,
    origin: p.origin,
  }));

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
          onSelect={setActiveId}
        />
        <p className="text-xs text-muted-foreground">
          {BASEMAPS[sheet].label}. Click a work item to review it.
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
          onSelect={setActiveId}
        />

        {active && (
          <PinReview
            key={active.id}
            projectId={projectId}
            pin={active}
            canReview={canReview}
            canDecide={canDecide}
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
  canReview,
  canDecide,
}: {
  projectId: string;
  pin: ReviewPin;
  canReview: boolean;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const view = displayStatus(pin.status);
  const subPhotos = pin.photos.filter((p) => p.side !== "ahc");
  const cmPhotos = pin.photos.filter((p) => p.side === "ahc");
  const hasCmPhoto = cmPhotos.length > 0 || photos.length > 0;

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

      {pin.wbsLabel && (
        <p className="text-xs text-muted-foreground">{pin.wbsLabel}</p>
      )}
      {pin.progress && (
        <p className="rounded-md bg-muted/60 px-2 py-1 text-xs">
          <span className="font-medium">Approving applies:</span> {pin.progress}
        </p>
      )}
      {pin.inspectionType && (
        <p className="text-xs text-muted-foreground">{pin.inspectionType}</p>
      )}
      {pin.notes && <p className="whitespace-pre-wrap text-sm">{pin.notes}</p>}

      <PhotoStrip label="Submitted photos" photos={subPhotos} />
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
