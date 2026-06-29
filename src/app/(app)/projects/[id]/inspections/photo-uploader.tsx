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

// Captures a single GPS fix (best effort, non-blocking) reused for the batch.
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
    async (file: File) => {
      const id = crypto.randomUUID();
      setItems((p) => [...p, { id, name: file.name, status: "uploading" }]);

      if (file.size > MAX_PHOTO_BYTES) {
        setItems((p) =>
          p.map((i) =>
            i.id === id ? { ...i, status: "error", error: "Over 25 MB" } : i,
          ),
        );
        return;
      }

      const supabase = createClient();
      const gps = await captureGps();
      let storagePath: string | null = null;

      try {
        if (token) {
          // No-login path: mint a signed URL server-side, then upload to it.
          const res = await createSecureLinkUploadUrl({
            token,
            fileName: file.name,
          });
          if (!res.ok) throw new Error(res.error);
          const { error } = await supabase.storage
            .from(INSPECTION_BUCKET)
            .uploadToSignedUrl(res.path, res.signedToken, file, {
              contentType: file.type || undefined,
            });
          if (error) throw new Error(error.message);
          storagePath = res.path;
        } else {
          // Authenticated path: direct upload (RLS gates it).
          const path = pathFor(file.name);
          const { error } = await supabase.storage
            .from(INSPECTION_BUCKET)
            .upload(path, file, {
              contentType: file.type || undefined,
              upsert: false,
            });
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
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5",
                  i.status === "uploading" && "bg-muted text-muted-foreground",
                  i.status === "done" && "bg-emerald-100 text-emerald-900",
                  i.status === "error" && "bg-destructive/10 text-destructive",
                )}
              >
                {i.status === "uploading" && "Uploading…"}
                {i.status === "done" && "Done"}
                {i.status === "error" && (i.error ?? "Failed")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
