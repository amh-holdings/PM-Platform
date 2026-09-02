"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createCmLog,
  updateCmLog,
  finalizeCmLog,
} from "../../cm-log-actions";
import {
  CmLogPhotoUploader,
  type StagedCmPhoto,
} from "./cm-log-photo-uploader";

// A photo already saved on the log (edit mode). previewUrl is a signed URL.
export type ExistingCmPhoto = {
  id: string;
  storagePath: string;
  caption: string;
  url: string;
};

// When present, the form edits an existing log instead of creating a new one.
export type CmLogInitial = {
  logId: string;
  logDate: string;
  weather: string;
  tempHigh: string;
  tempLow: string;
  siteConditions: string;
  progress: string;
  safety: string;
  ahcHeadcount: string;
  ahcManHours: string;
  photos: ExistingCmPhoto[];
};

type Props = {
  projectId: string;
  defaultDate: string; // yyyy-mm-dd, computed server-side (create mode)
  initial?: CmLogInitial;
};

export function CmLogForm({ projectId, defaultDate, initial }: Props) {
  const router = useRouter();
  const isEdit = Boolean(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // A stable draft id so staged photo blobs share one prefix before save.
  // In edit mode the log id gives new blobs a stable, log-scoped prefix.
  const draftId = useRef(initial?.logId ?? crypto.randomUUID());

  const [logDate, setLogDate] = useState(initial?.logDate ?? defaultDate);
  const [weather, setWeather] = useState(initial?.weather ?? "");
  const [tempHigh, setTempHigh] = useState(initial?.tempHigh ?? "");
  const [tempLow, setTempLow] = useState(initial?.tempLow ?? "");
  const [siteConditions, setSiteConditions] = useState(
    initial?.siteConditions ?? "",
  );
  const [progress, setProgress] = useState(initial?.progress ?? "");
  const [safety, setSafety] = useState(initial?.safety ?? "");
  // AHC's own people. Left blank rather than defaulted to 0 - blank means
  // "not recorded", and the monthly manpower report needs to be able to tell
  // that apart from a day AHC genuinely was not on site.
  const [ahcHeadcount, setAhcHeadcount] = useState(initial?.ahcHeadcount ?? "");
  const [ahcManHours, setAhcManHours] = useState(initial?.ahcManHours ?? "");
  // A deliberate zero, entered in one click. Typing 0 into two boxes to get
  // past a gate is how a required field turns into a fabricated number.
  const noneOnSite = ahcHeadcount === "0" && ahcManHours === "0";

  // Newly staged (uploaded-but-not-recorded) photos.
  const [photos, setPhotos] = useState<StagedCmPhoto[]>([]);
  // Photos already on the log (edit mode), minus any the CM removed here.
  const [existing, setExisting] = useState<ExistingCmPhoto[]>(
    initial?.photos ?? [],
  );
  const [removedIds, setRemovedIds] = useState<string[]>([]);

  // The id of a log this form CREATED and then stayed on. Until the AHC-hours
  // gate existed, a create was always followed by navigation, so the form never
  // had to save twice. It does now - a refused finalize leaves the CM on the
  // page with the row already written - and a second create would hit the one
  // -log-per-day constraint and fail, leaving a log that can never be
  // finalized. Once this is set, persist() updates instead.
  const [createdId, setCreatedId] = useState<string | null>(null);

  function numOrNull(v: string): number | null {
    const n = Number(v);
    return v.trim() === "" || Number.isNaN(n) ? null : n;
  }

  function removeExisting(id: string) {
    setExisting((prev) => prev.filter((p) => p.id !== id));
    setRemovedIds((prev) => [...prev, id]);
  }

  function patchExistingCaption(id: string, caption: string) {
    setExisting((prev) =>
      prev.map((p) => (p.id === id ? { ...p, caption } : p)),
    );
  }

  function fieldValues() {
    return {
      logDate,
      weatherConditions: weather.trim() || null,
      tempHigh: numOrNull(tempHigh),
      tempLow: numOrNull(tempLow),
      siteConditions: siteConditions.trim() || null,
      progressSummary: progress.trim() || null,
      safetyNotes: safety.trim() || null,
      ahcHeadcount: numOrNull(ahcHeadcount),
      ahcManHours: numOrNull(ahcManHours),
    };
  }

  function newPhotoInputs() {
    return photos.map((p) => ({
      storagePath: p.storagePath,
      caption: p.caption.trim() || null,
    }));
  }

  // Persist the current form. Returns the log id, or null on error (message set).
  async function persist(): Promise<string | null> {
    if (!logDate) {
      setError("Pick a date for the log");
      return null;
    }
    const existingId = initial?.logId ?? createdId;
    if (existingId) {
      const res = await updateCmLog({
        logId: existingId,
        projectId,
        ...fieldValues(),
        newPhotos: newPhotoInputs(),
        removedPhotoIds: removedIds,
        photoCaptions: existing.map((p) => ({
          id: p.id,
          caption: p.caption.trim() || null,
        })),
      });
      if (!res.ok) {
        setError(res.error);
        return null;
      }
      return res.logId;
    }
    const res = await createCmLog({
      projectId,
      ...fieldValues(),
      photos: newPhotoInputs(),
    });
    if (!res.ok) {
      setError(res.error);
      return null;
    }
    // Staged photos are recorded against the log now. Clearing them stops a
    // second save on this same form re-inserting duplicates.
    setCreatedId(res.logId);
    setPhotos([]);
    return res.logId;
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const logId = await persist();
      if (!logId) return;
      // After a create, drop into edit mode so the CM keeps building the log
      // through the day. After an edit save, go to the detail view.
      const dest = isEdit
        ? `/projects/${projectId}/cm-log/${logId}`
        : `/projects/${projectId}/cm-log/${logId}/edit`;
      router.push(dest);
      router.refresh();
    });
  }

  function saveAndFinalize() {
    setError(null);
    startTransition(async () => {
      // The draft is written FIRST, then the finalize is refused. Checking
      // before the save threw away everything typed on the form along with the
      // refusal - the CM writes the whole log and loses it to a field he has
      // not reached yet. The server gate in finalizeCmLog is the real
      // enforcement; this one only saves a round trip.
      const logId = await persist();
      if (!logId) return;
      if (numOrNull(ahcHeadcount) == null || numOrNull(ahcManHours) == null) {
        setError(
          "Saved as a draft. Enter AHC staff on site before finalizing - headcount and man-hours, or tick \u201CNo AHC staff on site today\u201D.",
        );
        router.refresh();
        return;
      }
      const res = await finalizeCmLog(logId, projectId);
      if (!res.ok) return setError(res.error);
      router.push(`/projects/${projectId}/cm-log/${logId}`);
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

      <div className="rounded-md border border-dashed p-3">
        <Label className="text-xs">AHC staff on site today</Label>
        <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
          Our own people - CM, supers, QC. Nothing else on the platform records
          these, so the owner&apos;s monthly manpower total reads short without
          them. Required to finalize; a draft can be saved without them.
        </p>
        <label className="mb-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={noneOnSite}
            onChange={(e) => {
              setAhcHeadcount(e.target.checked ? "0" : "");
              setAhcManHours(e.target.checked ? "0" : "");
            }}
            className="h-3.5 w-3.5"
          />
          No AHC staff on site today
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Headcount</Label>
            <Input
              type="number"
              min={0}
              disabled={noneOnSite}
              value={ahcHeadcount}
              onChange={(e) => setAhcHeadcount(e.target.value)}
              placeholder="-"
            />
          </div>
          <div>
            <Label className="text-xs">Man-hours</Label>
            <Input
              type="number"
              min={0}
              step="0.5"
              disabled={noneOnSite}
              value={ahcManHours}
              onChange={(e) => setAhcManHours(e.target.value)}
              placeholder="-"
            />
          </div>
        </div>
      </div>

      {isEdit && existing.length > 0 && (
        <div>
          <Label className="text-xs">Photos on this log</Label>
          <div className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {existing.map((p) => (
              <div
                key={p.id}
                className="space-y-1 rounded-md border bg-background p-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt={p.caption || "CM log photo"}
                  className="aspect-square w-full rounded object-cover"
                />
                <input
                  type="text"
                  value={p.caption}
                  onChange={(e) => patchExistingCaption(p.id, e.target.value)}
                  placeholder="Caption (optional)"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-full text-xs text-destructive hover:text-destructive"
                  onClick={() => removeExisting(p.id)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <Label className="text-xs">
          {isEdit ? "Add photos" : "Photos"}
        </Label>
        <CmLogPhotoUploader
          projectId={projectId}
          draftId={draftId.current}
          photos={photos}
          onChange={setPhotos}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={save}>
          {pending
            ? "Saving…"
            : isEdit
              ? "Save"
              : "Save daily log"}
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={saveAndFinalize}
        >
          {pending ? "Saving…" : "Save & Finalize"}
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() =>
            router.push(
              isEdit && initial
                ? `/projects/${projectId}/cm-log/${initial.logId}`
                : `/projects/${projectId}/cm-log`,
            )
          }
        >
          Cancel
        </Button>
      </div>
      {!isEdit && (
        <p className="text-xs text-muted-foreground">
          Save to keep a draft you can add notes and photos to through the day.
          Finalize when it&apos;s the final record for the day.
        </p>
      )}
    </div>
  );
}
