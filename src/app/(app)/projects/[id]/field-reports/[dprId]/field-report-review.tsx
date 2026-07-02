"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  BASEMAPS,
  type BasemapKey,
  type NormalizedPin,
} from "@/lib/inspection-map";
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
import { ReviewPanel } from "../../inspections/[inspectionId]/review-panel";
import { submitCmCheck } from "../../field-report-actions";

export type ReviewPin = {
  id: string;
  title: string;
  status: InspectionStatus;
  origin: string; // 'sub' | 'cm'
  basemapKey: string;
  pinX: number | null;
  pinY: number | null;
  inspectionType: string | null;
  notes: string | null;
};

type Props = {
  projectId: string;
  dprId: string;
  subcontractorId: string | null;
  pins: ReviewPin[];
  canReview: boolean;
  canDecide: boolean;
};

export function FieldReportReview({
  projectId,
  dprId,
  subcontractorId,
  pins,
  canReview,
  canDecide,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Default to the sheet most of the pins live on, else the first basemap.
  const firstSheet = (pins[0]?.basemapKey as BasemapKey) ?? "C2-01";
  const [sheet, setSheet] = useState<BasemapKey>(
    firstSheet in BASEMAPS ? firstSheet : "C2-01",
  );
  const [activeId, setActiveId] = useState<string | null>(null);

  // CM own-check placement state.
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<NormalizedPin | null>(null);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("");
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const onSheet = useMemo(
    () => pins.filter((p) => p.basemapKey === sheet),
    [pins, sheet],
  );
  const active = pins.find((p) => p.id === activeId) ?? null;
  const subPins = onSheet.filter((p) => p.origin !== "cm");
  const cmPins = onSheet.filter((p) => p.origin === "cm");

  const mapPins = onSheet.map((p) => ({
    id: p.id,
    pinX: p.pinX,
    pinY: p.pinY,
    status: p.status,
    title: p.title,
    origin: p.origin,
  }));

  function saveCheck() {
    setError(null);
    if (!title.trim()) return setError("Give the check a short title");
    if (!draft) return setError("Tap the map to place your check");
    startTransition(async () => {
      const res = await submitCmCheck({
        projectId,
        dprId,
        subcontractorId,
        title: title.trim(),
        inspectionType: type.trim() || null,
        notes: notes.trim() || null,
        basemapKey: sheet,
        pinX: draft.x,
        pinY: draft.y,
        photos,
      });
      if (!res.ok) return setError(res.error);
      setAdding(false);
      setDraft(null);
      setTitle("");
      setType("");
      setNotes("");
      setPhotos([]);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1">
            {(Object.keys(BASEMAPS) as BasemapKey[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setSheet(k);
                  setDraft(null);
                }}
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
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-full border border-white bg-amber-500 shadow" />
              Sub
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-sm border border-white bg-amber-500 shadow" />
              CM check
            </span>
          </div>
        </div>

        <InspectionMap
          basemapKey={sheet}
          pins={mapPins}
          activeId={activeId}
          onSelect={adding ? undefined : setActiveId}
          onPlace={adding ? setDraft : undefined}
          draftPin={adding ? draft : null}
        />
        <p className="text-xs text-muted-foreground">
          {BASEMAPS[sheet].label}.{" "}
          {adding
            ? "Tap where you inspected, then fill in the check."
            : "Round = sub work, square = your checks. Click a pin to review."}
        </p>

        {canReview && (
          <div>
            {adding ? (
              <div className="space-y-2 rounded-lg border bg-card p-3">
                <h4 className="text-sm font-semibold">Add my own check</h4>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What you checked (e.g. Verified pile torque row 12)"
                />
                <Input
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  placeholder="Type (optional)"
                />
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Notes (optional)"
                />
                <div>
                  <Label className="text-[10px]">Photos</Label>
                  <PhotoUploader
                    projectId={projectId}
                    side="ahc"
                    onChange={setPhotos}
                  />
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <div className="flex gap-2">
                  <Button size="sm" disabled={pending} onClick={saveCheck}>
                    {pending ? "Saving…" : "Save check"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setAdding(false);
                      setDraft(null);
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAdding(true);
                  setActiveId(null);
                }}
              >
                Add my own check
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <PinList
          heading={`Subcontractor work (${subPins.length})`}
          pins={subPins}
          activeId={activeId}
          onSelect={setActiveId}
        />
        <PinList
          heading={`My checks (${cmPins.length})`}
          pins={cmPins}
          activeId={activeId}
          onSelect={setActiveId}
        />

        {active && (
          <div className="space-y-2 rounded-lg border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold">{active.title}</h4>
              <span
                className={cn(
                  "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                  STATUS_STYLE[active.status].chip,
                )}
              >
                {statusLabel(active.status)}
              </span>
            </div>
            {active.inspectionType && (
              <p className="text-xs text-muted-foreground">
                {active.inspectionType}
              </p>
            )}
            {active.notes && (
              <p className="whitespace-pre-wrap text-sm">{active.notes}</p>
            )}
            {active.origin !== "cm" && canReview ? (
              <ReviewPanel
                projectId={projectId}
                inspectionId={active.id}
                status={active.status}
                canDecide={canDecide}
              />
            ) : active.origin === "cm" ? (
              <p className="text-xs text-muted-foreground">
                Your own check. It stands as an independent record.
              </p>
            ) : null}
          </div>
        )}
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
