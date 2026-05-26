"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { recordDocument } from "./documents-actions";
import {
  ACCEPTED_MIME_PREFIXES,
  DOCUMENT_BUCKET,
  DOCUMENT_CATEGORY_OPTIONS,
  MAX_FILE_BYTES,
  type DocumentCategory,
} from "./documents-constants";

type UploadingFile = {
  id: string;
  name: string;
  size: number;
  progress: "uploading" | "recording" | "done" | "error";
  errorMessage?: string;
};

type Props = {
  projectId: string;
  defaultCategory?: DocumentCategory;
};

function isAcceptedMime(mime: string | null | undefined): boolean {
  if (!mime) return true; // some browsers omit mime for unusual extensions
  return ACCEPTED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentUploader({
  projectId,
  defaultCategory = "prime_contract",
}: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<DocumentCategory>(defaultCategory);
  const [dragActive, setDragActive] = useState(false);
  const [items, setItems] = useState<UploadingFile[]>([]);
  const [, startTransition] = useTransition();

  const uploadFile = useCallback(
    async (file: File) => {
      const itemId = crypto.randomUUID();
      setItems((prev) => [
        ...prev,
        { id: itemId, name: file.name, size: file.size, progress: "uploading" },
      ]);

      if (file.size > MAX_FILE_BYTES) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === itemId
              ? { ...i, progress: "error", errorMessage: "File exceeds 50 MB limit" }
              : i,
          ),
        );
        return;
      }
      if (!isAcceptedMime(file.type)) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === itemId
              ? { ...i, progress: "error", errorMessage: `Unsupported file type: ${file.type || "unknown"}` }
              : i,
          ),
        );
        return;
      }

      const supabase = createClient();
      const documentId = crypto.randomUUID();
      const storagePath = `${projectId}/${documentId}/${sanitizeFileName(file.name)}`;

      const { error: uploadError } = await supabase.storage
        .from(DOCUMENT_BUCKET)
        .upload(storagePath, file, {
          cacheControl: "3600",
          contentType: file.type || undefined,
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

      setItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, progress: "recording" } : i)),
      );

      const result = await recordDocument({
        projectId,
        storagePath,
        fileName: file.name,
        mimeType: file.type || null,
        sizeBytes: file.size,
        category,
      });

      if (!result.ok) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === itemId
              ? { ...i, progress: "error", errorMessage: result.error }
              : i,
          ),
        );
        return;
      }

      setItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, progress: "done" } : i)),
      );
      startTransition(() => {
        router.refresh();
      });
    },
    [projectId, category, router],
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

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <label
            htmlFor="document-category"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Upload as
          </label>
          <select
            id="document-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as DocumentCategory)}
            className={cn(
              "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm sm:w-56",
              "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            )}
          >
            {DOCUMENT_CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          Max 50 MB per file. PDF, Word, Excel, text, images.
        </p>
      </div>

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
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed bg-card p-8 text-center transition-colors",
          dragActive
            ? "border-primary bg-primary/5"
            : "border-input hover:border-foreground/30",
        )}
      >
        <p className="text-sm font-medium">
          Drop files here or click to browse
        </p>
        <p className="text-xs text-muted-foreground">
          Files upload directly to Supabase Storage
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = ""; // allow re-selecting the same file
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{item.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(item.size)}
                  {item.errorMessage ? ` - ${item.errorMessage}` : ""}
                </p>
              </div>
              <span
                className={cn(
                  "ml-3 shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium",
                  item.progress === "uploading" && "bg-muted text-muted-foreground",
                  item.progress === "recording" && "bg-muted text-muted-foreground",
                  item.progress === "done" && "bg-emerald-100 text-emerald-900",
                  item.progress === "error" &&
                    "bg-destructive/10 text-destructive",
                )}
              >
                {item.progress === "uploading" && "Uploading..."}
                {item.progress === "recording" && "Saving..."}
                {item.progress === "done" && "Done"}
                {item.progress === "error" && "Failed"}
              </span>
            </li>
          ))}
          {items.some((i) => i.progress === "done" || i.progress === "error") && (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setItems((prev) =>
                    prev.filter((i) => i.progress === "uploading" || i.progress === "recording"),
                  )
                }
              >
                Clear completed
              </Button>
            </div>
          )}
        </ul>
      )}
    </div>
  );
}
