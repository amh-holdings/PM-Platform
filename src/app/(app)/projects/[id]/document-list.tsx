"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { deleteDocument } from "./documents-actions";
import {
  DOCUMENT_CATEGORY_LABEL,
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
  const [, startTransition] = useTransition();

  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        No documents uploaded yet.
      </div>
    );
  }

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
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 font-medium">Size</th>
                  <th className="px-4 py-2 font-medium">Text</th>
                  <th className="px-4 py-2 font-medium">Uploaded</th>
                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {group.documents.map((doc) => (
                  <tr key={doc.id} className="hover:bg-muted/30">
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
