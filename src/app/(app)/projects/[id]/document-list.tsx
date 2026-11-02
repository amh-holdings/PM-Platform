"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { deleteDocument, moveDocuments } from "./documents-actions";
import { rangeSelect } from "@/lib/range-select";
import {
  DOCUMENT_CATEGORY_LABEL,
  DOCUMENT_CATEGORY_OPTIONS,
  type DocumentCategory,
  type DocumentTextStatus,
} from "./documents-constants";

type DocumentRow = {
  id: string;
  file_name: string;
  category: DocumentCategory;
  size_bytes: number | null;
  mime_type: string | null;
  text_status: DocumentTextStatus;
  uploaded_at: string | null;
  pages_count: number | null;
};

type DocumentGroup = {
  category: DocumentCategory;
  documents: DocumentRow[];
  defaultOpen: boolean;
};

type Props = {
  projectId: string;
  groups: DocumentGroup[];
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const TEXT_STATUS_LABEL: Record<DocumentTextStatus, string> = {
  pending: "Queued",
  processing: "Extracting",
  ready: "Ready",
  failed: "Failed",
  skipped: "Skipped",
};

const TEXT_STATUS_TONE: Record<DocumentTextStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  processing: "bg-amber-100 text-amber-900",
  ready: "bg-emerald-100 text-emerald-900",
  failed: "bg-destructive/10 text-destructive",
  skipped: "bg-muted text-muted-foreground",
};

export function DocumentList({ projectId, groups }: Props) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState<DocumentCategory>("drawing");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [, startTransition] = useTransition();

  // Every row on the page, in the order it is drawn, so shift-click can range
  // across a group boundary the way the eye expects.
  const orderedIds = useMemo(
    () => groups.flatMap((g) => g.documents.map((d) => d.id)),
    [groups],
  );
  // The last box clicked, which shift-click ranges from. A ref, so moving it
  // does not re-render the table mid-click.
  const anchor = useRef<string | null>(null);

  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        No documents uploaded yet.
      </div>
    );
  }

  // The category is picked from a dropdown before the file is even in the
  // app, which is the moment the person knows least about it. Until now the
  // only way back was to delete and re-upload, which loses the upload date
  // and, on a 32 MB plan set, several minutes.
  const handleMove = async (
    ids: string[],
    label: string,
    category: DocumentCategory,
  ) => {
    if (ids.length === 0) return;
    if (ids.length === 1) setPendingId(ids[0]);
    else setBulkBusy(true);
    setError(null);
    setNote(null);
    const result = await moveDocuments(ids, projectId, category);
    setPendingId(null);
    setBulkBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The rows are about to jump to another group, so say where they went. A
    // row that silently vanishes from under the cursor reads as a delete.
    setNote(`${label} moved to ${DOCUMENT_CATEGORY_LABEL[result.category]}.`);
    setPicked(new Set());
    anchor.current = null;
    startTransition(() => {
      router.refresh();
    });
  };

  const clickRow = (e: React.MouseEvent<HTMLInputElement>, id: string) => {
    setPicked(rangeSelect(orderedIds, picked, anchor.current, id, e.shiftKey));
    anchor.current = id;
  };

  // The header box ticks or clears this group, not the whole page: a group is
  // the unit somebody is looking at when they reach for it.
  const toggleGroup = (ids: string[], on: boolean) => {
    const next = new Set(picked);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setPicked(next);
    anchor.current = null;
  };

  const handleDelete = async (id: string, fileName: string) => {
    if (!confirm(`Delete "${fileName}"? This removes the file and its extracted text.`)) {
      return;
    }
    setPendingId(id);
    setError(null);
    const result = await deleteDocument(id, projectId);
    setPendingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {note && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-50 p-3 text-sm text-emerald-900">
          {note}
        </div>
      )}
      {picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-primary/30 bg-muted/40 p-3 text-sm">
          <span className="font-medium">
            {picked.size} file{picked.size === 1 ? "" : "s"} selected
          </span>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Move to
            <select
              value={bulkCategory}
              onChange={(e) =>
                setBulkCategory(e.target.value as DocumentCategory)
              }
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              {DOCUMENT_CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            disabled={bulkBusy}
            onClick={() =>
              handleMove(
                Array.from(picked),
                `${picked.size} file${picked.size === 1 ? "" : "s"}`,
                bulkCategory,
              )
            }
          >
            {bulkBusy ? "Moving..." : "Move"}
          </Button>
          <button
            type="button"
            onClick={() => {
              setPicked(new Set());
              anchor.current = null;
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
          <span className="ml-auto text-xs text-muted-foreground">
            Shift-click to take a run of rows.
          </span>
        </div>
      )}
      {groups.map((group) => (
        <details
          key={group.category}
          open={group.defaultOpen}
          className="group overflow-hidden rounded-lg border bg-card shadow-sm"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b bg-muted/30 px-4 py-3 text-sm hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block transition-transform group-open:rotate-90 text-muted-foreground"
              >
                ▶
              </span>
              <span className="font-medium">
                {DOCUMENT_CATEGORY_LABEL[group.category]}
              </span>
              <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {group.documents.length}
              </span>
            </div>
          </summary>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="w-10 px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select all ${DOCUMENT_CATEGORY_LABEL[group.category]}`}
                      checked={group.documents.every((d) => picked.has(d.id))}
                      onChange={(e) =>
                        toggleGroup(
                          group.documents.map((d) => d.id),
                          e.target.checked,
                        )
                      }
                    />
                  </th>
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 font-medium">Size</th>
                  <th className="px-4 py-2 font-medium">Text</th>
                  <th className="px-4 py-2 font-medium">Uploaded</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {group.documents.map((doc) => (
                  <tr
                    key={doc.id}
                    className={cn(
                      "hover:bg-muted/30",
                      picked.has(doc.id) && "bg-primary/5",
                    )}
                  >
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={picked.has(doc.id)}
                        aria-label={`Select ${doc.file_name}`}
                        // onClick, not onChange: a React change event on a
                        // checkbox carries no shiftKey. onChange stays a no-op
                        // so the controlled input does not warn.
                        onClick={(e) => clickRow(e, doc.id)}
                        onChange={() => {}}
                      />
                    </td>
                    <td className="px-4 py-2.5 font-medium">
                      {doc.file_name}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {formatBytes(doc.size_bytes)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          TEXT_STATUS_TONE[doc.text_status],
                        )}
                      >
                        {TEXT_STATUS_LABEL[doc.text_status]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {formatTimestamp(doc.uploaded_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      <select
                        value={doc.category}
                        disabled={pendingId === doc.id}
                        onChange={(e) =>
                          handleMove(
                            [doc.id],
                            doc.file_name,
                            e.target.value as DocumentCategory,
                          )
                        }
                        aria-label={`Document type for ${doc.file_name}`}
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50"
                      >
                        {DOCUMENT_CATEGORY_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                        {/* A row whose category predates the option list would
                            otherwise render with the first option selected,
                            which looks like the type was silently changed. */}
                        {!DOCUMENT_CATEGORY_OPTIONS.some(
                          (o) => o.value === doc.category,
                        ) && (
                          <option value={doc.category}>{doc.category}</option>
                        )}
                      </select>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(doc.id, doc.file_name)}
                        disabled={pendingId === doc.id}
                      >
                        {pendingId === doc.id ? "Working..." : "Delete"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}
