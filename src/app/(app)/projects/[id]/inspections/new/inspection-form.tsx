"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BASEMAPS, type BasemapKey } from "@/lib/inspection-map";
import type { NormalizedPin } from "@/lib/inspection-map";
import { InspectionMap } from "../inspection-map";
import { submitInspection } from "../inspection-actions";

type Sub = { id: string; company_name: string };

export function NewInspectionForm({
  projectId,
  subs,
}: {
  projectId: string;
  subs: Sub[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [subId, setSubId] = useState(subs[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("");
  const [notes, setNotes] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [sheet, setSheet] = useState<BasemapKey>("C2-01");
  const [pin, setPin] = useState<NormalizedPin | null>(null);

  // Best-effort GPS backup, captured on submit (non-blocking).
  function captureGps(): Promise<{ lat: number | null; lng: number | null }> {
    return new Promise((resolve) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        return resolve({ lat: null, lng: null });
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve({ lat: null, lng: null }),
        { timeout: 4000 },
      );
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("Title is required");
    if (!subId) return setError("Select a subcontractor");
    startTransition(async () => {
      const gps = await captureGps();
      const res = await submitInspection({
        projectId,
        subcontractorId: subId,
        title: title.trim(),
        inspectionType: type.trim() || null,
        notes: notes.trim() || null,
        quantity: quantity ? Number(quantity) : null,
        unitOfMeasure: unit.trim() || null,
        basemapKey: sheet,
        pinX: pin?.x ?? null,
        pinY: pin?.y ?? null,
        gpsLat: gps.lat,
        gpsLng: gps.lng,
      });
      if (!res.ok) return setError(res.error);
      router.push(`/projects/${projectId}/inspections/${res.inspectionId}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-2">
        <div className="flex gap-1">
          {(Object.keys(BASEMAPS) as BasemapKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setSheet(k)}
              className={
                "rounded-md border px-2.5 py-1 text-xs font-medium " +
                (k === sheet
                  ? "border-foreground bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {BASEMAPS[k].key}
            </button>
          ))}
        </div>
        <InspectionMap
          basemapKey={sheet}
          pins={[]}
          draftPin={pin}
          onPlace={setPin}
        />
        <p className="text-xs text-muted-foreground">
          {pin
            ? `Pin set at ${(pin.x * 100).toFixed(1)}%, ${(pin.y * 100).toFixed(1)}%`
            : "Tap the map to set the inspection location."}
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <Label>Subcontractor</Label>
          <select
            value={subId}
            onChange={(e) => setSubId(e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-2 text-sm"
          >
            {subs.length === 0 && <option value="">No subs on project</option>}
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.company_name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Title</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Silt fence install - north line"
          />
        </div>
        <div className="space-y-1">
          <Label>Inspection type</Label>
          <Input
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder="e.g. E&S, grading, rebar"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label>Quantity</Label>
            <Input
              type="number"
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Unit</Label>
            <Input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="LF, EA, CY"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label>Notes</Label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            className="w-full rounded-md border bg-background p-2 text-sm"
            placeholder="What was inspected, conditions, anything notable."
          />
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={pending}>
          {pending ? "Submitting…" : "Submit inspection"}
        </Button>
      </div>
    </form>
  );
}
