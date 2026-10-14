"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DOCUMENT_CATEGORY_OPTIONS,
  type DocumentCategory,
} from "./documents-constants";
import { formatBytes, uploadProjectDocument } from "./upload-document";

type UploadingFile = {
  id: string;
  name: string;
  size: number;
  progress: "uploading" | "linking" | "done" | "error";
  errorMessage?: string;
};

type Props = {
  projectId: string;
  defaultCategory?: DocumentCategory;
  /**
   * Called once the document row exists, with its id, for a caller that wants
   * the file linked to something - a schedule task, in the records popup.
   *
   * It returns the result rather than throwing so the failure can be reported
   * honestly: the upload succeeded and only the link did not, which is a
   * different thing from a failed upload and sends somebody to a different
   * place to fix it.
   */
  onUploaded?: (
    documentId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Tighter layout, for the uploader inside a popup rather than a page. */
  compact?: boolean;
};

export function DocumentUploader({
  projectId,
  defaultCategory = "prime_contract",
  onUploaded,
  compact = false,
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

      const result = await uploadProjectDocument({ projectId, file, category });

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

      if (onUploaded) {
        setItems((prev) =>
          prev.map((i) => (i.id === itemId ? { ...i, progress: "linking" } : i)),
        );
        const linked = await onUploaded(result.id);
        if (!linked.ok) {
          setItems((prev) =>
            prev.map((i) =>
              i.id === itemId
                ? {
                    ...i,
                    progress: "error",
                    errorMessage: `in the library, not attached: ${linked.error}`,
                  }
                : i,
            ),
          );
          return;
        }
      }

      setItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, progress: "done" } : i)),
      );
      startTransition(() => {
        router.refresh();
      });
    },
    [projectId, category, router, onUploaded],
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
    <div className={cn(compact ? "space-y-2" : "space-y-4")}>
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
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed bg-card text-center transition-colors",
          compact ? "p-4" : "p-8",
          dragActive
            ? "border-primary bg-primary/5"
            : "border-input hover:border-foreground/30",
        )}
      >
        <p className={cn("font-medium", compact ? "text-xs" : "text-sm")}>
          Drop files here or click to browse
        </p>
        {!compact && (
          <p className="text-xs text-muted-foreground">
            Files upload directly to Supabase Storage
          </p>
        )}
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
                  item.progress === "linking" && "bg-muted text-muted-foreground",
                  item.progress === "done" && "bg-emerald-100 text-emerald-900",
                  item.progress === "error" &&
                    "bg-destructive/10 text-destructive",
                )}
              >
                {item.progress === "uploading" && "Uploading..."}
                {item.progress === "linking" && "Attaching..."}
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
                    prev.filter(
                      (i) => i.progress === "uploading" || i.progress === "linking",
                    ),
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
