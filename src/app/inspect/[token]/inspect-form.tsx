"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BASEMAPS, type BasemapKey } from "@/lib/inspection-map";
import type { NormalizedPin } from "@/lib/inspection-map";
import { InspectionMap } from "@/app/(app)/projects/[id]/inspections/inspection-map";
import { submitViaSecureLink } from "@/app/(app)/projects/[id]/inspections/inspection-actions";

export function SecureLinkSubmit({ token }: { token: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("");
  const [notes, setNotes] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [sheet, setSheet] = useState<BasemapKey>("C2-01");
  const [pin, setPin] = useState<NormalizedPin | null>(null);

  function captureGps(): Promise<{ lat: number | null; lng: number | null }> {
    return new Promise((resolve) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        return resolve({ lat: null, lng: null });
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve({ lat: null, lng: null }),
        { timeout: 4000 },
      );
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Your name is required");
    if (!title.trim()) return setError("Title is required");
    startTransition(async () => {
      const gps = await captureGps();
      const res = await submitViaSecureLink({
        token,
        inspectorName: name.trim(),
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
      setDone(true);
      setTitle("");
      setType("");
      setNotes("");
      setQuantity("");
      setUnit("");
      setPin(null);
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-lg border bg-card p-4"
    >
      {done && (
        <div className="rounded-md border border-green-300 bg-green-50 p-2 text-xs text-green-800">
          Submitted. You can file another below.
        </div>
      )}

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
        <InspectionMap basemapKey={sheet} pins={[]} draftPin={pin} onPlace={setPin} />
        <p className="text-xs text-muted-foreground">
          {pin ? "Location pinned." : "Tap the map to mark the location."}
        </p>
      </div>

      <div className="space-y-1">
        <Label>Your name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label>Title</Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What was inspected"
        />
      </div>
      <div className="space-y-1">
        <Label>Type</Label>
        <Input value={type} onChange={(e) => setType(e.target.value)} />
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
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label>Notes</Label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="w-full rounded-md border bg-background p-2 text-sm"
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Submitting…" : "Submit inspection"}
      </Button>
    </form>
  );
}
