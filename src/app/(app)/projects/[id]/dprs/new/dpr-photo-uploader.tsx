"use client";

import { useCallback, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";

export const DPR_PHOTO_BUCKET = "dpr-photos";
const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // 15 MB
const PHOTO_TYPES = ["progress", "safety", "delivery", "issue", "eod", "other"] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

export type StagedPhoto = {
  photoId: string;
  fileName: string;
  storagePath: string;
  sizeBytes: number;
  mimeType: string | null;
  caption: string;
  photoType: PhotoType;
  previewUrl: string;
};

type UploadingItem = {
  id: string;
  name: string;
  size: number;
  progress: "uploading" | "done" | "error";
  errorMessage?: string;
};

type Props = {
  projectId: string;
  draftId: string;
  photos: StagedPhoto[];
  onChange: (photos: StagedPhoto[]) => void;
};

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DprPhotoUploader({ projectId, draftId, photos, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadingItem[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const uploadFile = useCallback(
    async (file: File) => {
      const itemId = crypto.randomUUID();
      setItems((prev) => [
        ...prev,
        { id: itemId, name: file.name, size: file.size, progress: "uploading" },
      ]);

      if (!file.type.startsWith("image/")) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === itemId
              ? { ...i, progress: "error", errorMessage: "Photos only (image/*)" }
              : i,
          ),
        );
        return;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === itemId
              ? { ...i, progress: "error", errorMessage: "Photo exceeds 15 MB" }
              : i,
          ),
        );
        return;
      }

      const supabase = createClient();
      const photoId = crypto.randomUUID();
      const storagePath = `${projectId}/_drafts/${draftId}/${photoId}-${sanitizeFileName(file.name)}`;

      const { error: uploadError } = await supabase.storage
        .from(DPR_PHOTO_BUCKET)
        .upload(storagePath, file, {
          cacheControl: "3600",
          contentType: file.type,
          upsert: false,
        });

      if (uploadError) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === itemId
              ? { ...i, progress: "error", errorMessage: uploadError.message }
              : i,
          ),
        );
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      onChange([
        ...photos,
        {
          photoId,
          fileName: file.name,
          storagePath,
          sizeBytes: file.size,
          mimeType: file.type,
          caption: "",
          photoType: "progress",
          previewUrl,
        },
      ]);
      setItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, progress: "done" } : i)),
      );
    },
    [projectId, draftId, photos, onChange],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      Array.from(files).forEach((file) => {
        void uploadFile(file);
      });
    },
    [uploadFile],
  );

  const removePhoto = useCallback(
    async (photoId: string) => {
      const photo = photos.find((p) => p.photoId === photoId);
      if (!photo) return;
      URL.revokeObjectURL(photo.previewUrl);
      onChange(photos.filter((p) => p.photoId !== photoId));
      // Best-effort cleanup of the staged blob
      const supabase = createClient();
      await supabase.storage.from(DPR_PHOTO_BUCKET).remove([photo.storagePath]);
    },
    [photos, onChange],
  );

  function patchPhoto(photoId: string, patch: Partial<StagedPhoto>) {
    onChange(photos.map((p) => (p.photoId === photoId ? { ...p, ...patch } : p)));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
          Add photos
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => cameraRef.current?.click()}>
          Take photo
        </Button>
        <span className="text-xs text-muted-foreground">Up to 15 MB each</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div
        onDragEnter={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragActive(false);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={cn(
          "rounded-md border-2 border-dashed bg-background/40 p-4 text-center text-xs text-muted-foreground transition-colors",
          dragActive ? "border-primary bg-primary/5" : "border-input",
        )}
      >
        Drag photos here, or use the buttons above
      </div>

      {items.some((i) => i.progress !== "done") && (
        <ul className="space-y-1 text-xs">
          {items
            .filter((i) => i.progress !== "done")
            .map((i) => (
              <li key={i.id} className="flex items-center justify-between">
                <span className="truncate">{i.name} ({formatBytes(i.size)})</span>
                <span
                  className={cn(
                    "ml-2 shrink-0 rounded-full px-2 py-0.5 font-medium",
                    i.progress === "uploading" && "bg-muted text-muted-foreground",
                    i.progress === "error" && "bg-destructive/10 text-destructive",
                  )}
                >
                  {i.progress === "uploading" && "Uploading..."}
                  {i.progress === "error" && (i.errorMessage ?? "Failed")}
                </span>
              </li>
            ))}
        </ul>
      )}

      {photos.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {photos.map((p) => (
            <div key={p.photoId} className="space-y-1 rounded-md border bg-background p-2">
              {p.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.previewUrl}
                  alt={p.fileName}
                  className="aspect-square w-full rounded object-cover"
                />
              ) : (
                // Restored from a saved draft: the in-memory preview is gone but
                // the upload is safe on the server.
                <div className="flex aspect-square w-full flex-col items-center justify-center rounded border border-dashed bg-muted/40 text-center text-[10px] text-muted-foreground">
                  <span className="font-medium">Saved photo</span>
                  <span className="truncate px-1">{p.fileName}</span>
                </div>
              )}
              <select
                value={p.photoType}
                onChange={(e) => patchPhoto(p.photoId, { photoType: e.target.value as PhotoType })}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                {PHOTO_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={p.caption}
                onChange={(e) => patchPhoto(p.photoId, { caption: e.target.value })}
                placeholder="Caption (optional)"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-full text-xs text-destructive hover:text-destructive"
                onClick={() => removePhoto(p.photoId)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
