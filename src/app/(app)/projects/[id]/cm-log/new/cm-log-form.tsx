"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCmLog } from "../../cm-log-actions";
import {
  CmLogPhotoUploader,
  type StagedCmPhoto,
} from "./cm-log-photo-uploader";

type Props = {
  projectId: string;
  defaultDate: string; // yyyy-mm-dd, computed server-side
};

export function CmLogForm({ projectId, defaultDate }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // A stable draft id so staged photo blobs share one prefix before save.
  const draftId = useRef(crypto.randomUUID());

  const [logDate, setLogDate] = useState(defaultDate);
  const [weather, setWeather] = useState("");
  const [tempHigh, setTempHigh] = useState("");
  const [tempLow, setTempLow] = useState("");
  const [siteConditions, setSiteConditions] = useState("");
  const [progress, setProgress] = useState("");
  const [safety, setSafety] = useState("");
  const [photos, setPhotos] = useState<StagedCmPhoto[]>([]);

  function numOrNull(v: string): number | null {
    const n = Number(v);
    return v.trim() === "" || Number.isNaN(n) ? null : n;
  }

  function save() {
    setError(null);
    if (!logDate) return setError("Pick a date for the log");
    startTransition(async () => {
      const res = await createCmLog({
        projectId,
        logDate,
        weatherConditions: weather.trim() || null,
        tempHigh: numOrNull(tempHigh),
        tempLow: numOrNull(tempLow),
        siteConditions: siteConditions.trim() || null,
        progressSummary: progress.trim() || null,
        safetyNotes: safety.trim() || null,
        photos: photos.map((p) => ({
          storagePath: p.storagePath,
          caption: p.caption.trim() || null,
        })),
      });
      if (!res.ok) return setError(res.error);
      router.push(`/projects/${projectId}/cm-log/${res.logId}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label className="text-xs">Date</Label>
          <Input
            type="date"
            value={logDate}
            onChange={(e) => setLogDate(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs">High °F</Label>
          <Input
            type="number"
            value={tempHigh}
            onChange={(e) => setTempHigh(e.target.value)}
            placeholder="-"
          />
        </div>
        <div>
          <Label className="text-xs">Low °F</Label>
          <Input
            type="number"
            value={tempLow}
            onChange={(e) => setTempLow(e.target.value)}
            placeholder="-"
          />
        </div>
      </div>

      <div>
        <Label className="text-xs">Weather</Label>
        <Input
          value={weather}
          onChange={(e) => setWeather(e.target.value)}
          placeholder="e.g. Clear, light wind"
        />
      </div>

      <div>
        <Label className="text-xs">Site conditions</Label>
        <textarea
          value={siteConditions}
          onChange={(e) => setSiteConditions(e.target.value)}
          rows={3}
          className="w-full rounded-md border bg-background p-2 text-sm"
          placeholder="Access, ground conditions, laydown, anything notable about the site today."
        />
      </div>

      <div>
        <Label className="text-xs">Progress summary</Label>
        <textarea
          value={progress}
          onChange={(e) => setProgress(e.target.value)}
          rows={4}
          className="w-full rounded-md border bg-background p-2 text-sm"
          placeholder="Overall progress across the crews and trades today."
        />
      </div>

      <div>
        <Label className="text-xs">Safety notes</Label>
        <textarea
          value={safety}
          onChange={(e) => setSafety(e.target.value)}
          rows={2}
          className="w-full rounded-md border bg-background p-2 text-sm"
          placeholder="Toolbox talk, incidents, near misses, PPE observations."
        />
      </div>

      <div>
        <Label className="text-xs">Photos</Label>
        <CmLogPhotoUploader
          projectId={projectId}
          draftId={draftId.current}
          photos={photos}
          onChange={setPhotos}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save daily log"}
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => router.push(`/projects/${projectId}/cm-log`)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
