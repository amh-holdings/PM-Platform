"use client";

import { useCallback, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import {
  INSPECTION_BUCKET,
  MAX_PHOTO_BYTES,
  sanitizeFileName,
} from "./inspection-constants";
import { createSecureLinkUploadUrl } from "./inspection-actions";

export type UploadedPhoto = {
  storagePath: string;
  caption: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  takenAt: string;
};

type Item = {
  id: string;
  name: string;
  status: "uploading" | "done" | "error";
  error?: string;
  // Kept so Retry can re-send the same file without re-picking it.
  file?: File;
};

type Props = {
  // Required for authenticated direct upload; ignored in token mode (the path
  // is derived server-side from the token's project).
  projectId?: string;
  side: "sub" | "ahc";
  // Authenticated direct-upload mode (AHC team or signed-in sub).
  // For AHC verification on an existing record, pass inspectionId for pathing.
  inspectionId?: string;
  // No-login mode: pass the secure-link token to use signed upload URLs.
  token?: string;
  onChange: (photos: UploadedPhoto[]) => void;
};

const GPS_TIMEOUT_MS = 5000;
const UPLOAD_TIMEOUT_MS = 120_000;

type Gps = { lat: number | null; lng: number | null };
const NO_GPS: Gps = { lat: null, lng: null };

/**
 * A GPS fix, or nothing. Best effort in the strict sense: this must never be
 * able to hold up a photo.
 *
 * getCurrentPosition's own `timeout` bounds acquiring a position AFTER the
 * permission question is settled. It does not bound the prompt itself, and on
 * iOS there are states where neither callback ever fires. This used to be
 * awaited before the upload started, so a photo could sit on "Uploading..."
 * forever having sent zero bytes. The outer race is the real guarantee.
 */
function captureGps(): Promise<Gps> {
  const fix = new Promise<Gps>((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      return resolve(NO_GPS);
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(NO_GPS),
      { timeout: GPS_TIMEOUT_MS },
    );
  });
  const bail = new Promise<Gps>((resolve) =>
    setTimeout(() => resolve(NO_GPS), GPS_TIMEOUT_MS),
  );
  return Promise.race([fix, bail]);
}

/**
 * Bounds a promise that has no cancellation of its own. The underlying request
 * may still be in flight; the point is that the UI stops waiting on it and the
 * user gets a Retry instead of a spinner that never ends.
 */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export function PhotoUploader({
  projectId,
  side,
  inspectionId,
  token,
  onChange,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const photosRef = useRef<UploadedPhoto[]>([]);

  const pathFor = useCallback(
    (fileName: string) => {
      const file = `${crypto.randomUUID()}-${sanitizeFileName(fileName)}`;
      return inspectionId
        ? `${projectId}/${inspectionId}/${side}/${file}`
        : `${projectId}/_drafts/${side}/${file}`;
    },
    [projectId, inspectionId, side],
  );

  const uploadOne = useCallback(
    async (file: File, itemId?: string) => {
      const id = itemId ?? crypto.randomUUID();
      setItems((p) =>
        itemId
          ? p.map((i) =>
              i.id === id
                ? { ...i, status: "uploading", error: undefined }
                : i,
            )
          : [...p, { id, name: file.name, status: "uploading", file }],
      );

      if (file.size > MAX_PHOTO_BYTES) {
        setItems((p) =>
          p.map((i) =>
            i.id === id
              ? { ...i, status: "error", error: "Photo is too large" }
              : i,
          ),
        );
        return;
      }

      const supabase = createClient();
      // Started, not awaited. The upload must not wait on a location fix - see
      // captureGps. Whatever it has by the time the bytes land is what we use.
      const gpsPromise = captureGps();
      let storagePath: string | null = null;

      try {
        if (token) {
          // No-login path: mint a signed URL server-side, then upload to it.
          const res = await withTimeout(
            createSecureLinkUploadUrl({ token, fileName: file.name }),
            UPLOAD_TIMEOUT_MS,
            "Timed out preparing the upload. Tap Retry.",
          );
          if (!res.ok) throw new Error(res.error);
          const { error } = await withTimeout(
            supabase.storage
              .from(INSPECTION_BUCKET)
              .uploadToSignedUrl(res.path, res.signedToken, file, {
                contentType: file.type || undefined,
              }),
            UPLOAD_TIMEOUT_MS,
            "Upload timed out. Tap Retry.",
          );
          if (error) throw new Error(error.message);
          storagePath = res.path;
        } else {
          // Authenticated path: direct upload (RLS gates it).
          const path = pathFor(file.name);
          const { error } = await withTimeout(
            supabase.storage.from(INSPECTION_BUCKET).upload(path, file, {
              contentType: file.type || undefined,
              upsert: false,
            }),
            UPLOAD_TIMEOUT_MS,
            "Upload timed out. Tap Retry.",
          );
          if (error) throw new Error(error.message);
          storagePath = path;
        }
      } catch (e) {
        setItems((p) =>
          p.map((i) =>
            i.id === id
              ? { ...i, status: "error", error: (e as Error).message }
              : i,
          ),
        );
        return;
      }

      const gps = await gpsPromise;

      photosRef.current = [
        ...photosRef.current,
        {
          storagePath,
          caption: null,
          gpsLat: gps.lat,
          gpsLng: gps.lng,
          takenAt: new Date().toISOString(),
        },
      ];
      onChange(photosRef.current);
      setItems((p) =>
        p.map((i) => (i.id === id ? { ...i, status: "done" } : i)),
      );
    },
    [token, pathFor, onChange],
  );

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="w-full rounded-md border-2 border-dashed bg-card px-3 py-4 text-center text-xs text-muted-foreground hover:border-foreground/30"
      >
        Add {side === "ahc" ? "AHC verification" : ""} photos (tap to choose or
        take a picture)
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(e) => {
          Array.from(e.target.files ?? []).forEach((f) => void uploadOne(f));
          e.target.value = "";
        }}
      />
      {items.length > 0 && (
        <ul className="space-y-1 text-xs">
          {items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{i.name}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5",
                    i.status === "uploading" && "bg-muted text-muted-foreground",
                    i.status === "done" && "bg-emerald-100 text-emerald-900",
                    i.status === "error" && "bg-destructive/10 text-destructive",
                  )}
                >
                  {i.status === "uploading" && "Uploading…"}
                  {i.status === "done" && "Done"}
                  {i.status === "error" && (i.error ?? "Failed")}
                </span>
                {i.status === "error" && i.file && (
                  <button
                    type="button"
                    onClick={() => void uploadOne(i.file as File, i.id)}
                    className="rounded-md border px-2 py-0.5 font-medium hover:bg-accent"
                  >
                    Retry
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
