"use client";

/**
 * Pick a file out of the project's document library.
 *
 * Shared by the attachments panel on a saved RFI and by the form that logs a
 * new one. The two differ only in what happens after the pick - attach it, or
 * hold it until the RFI exists - so the picking itself lives here once.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  countDocuments,
  groupDocuments,
  docDateLabel,
} from "@/lib/document-picker";

import { getAttachableRfiDocuments, type AttachableDoc } from "./rfis-actions";

type Props = {
  projectId: string;
  /** Null while logging a new RFI, which has no id yet. */
  rfiId: string | null;
  disabled?: boolean;
  onPick: (doc: AttachableDoc) => void;
  onCancel: () => void;
};

export function LibraryPicker({ projectId, rfiId, disabled, onPick, onCancel }: Props) {
  const [options, setOptions] = useState<AttachableDoc[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await getAttachableRfiDocuments(projectId, rfiId);
      if (!res.ok) {
        setError(res.error);
        setOptions([]);
        return;
      }
      if (!res.enabled) {
        setError("Run migration 0085 in the Supabase SQL Editor first.");
        setOptions([]);
        return;
      }
      setOptions(res.documents);
    })();
  }, [projectId, rfiId]);

  const filtered = (options ?? []).filter((o) =>
    query.trim() ? o.fileName.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );
  const groups = groupDocuments(filtered);
  const total = countDocuments(groups);

  return (
    <div className="space-y-2 rounded border bg-background p-2">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // This renders inside the form that logs the RFI. Without this,
            // Enter while searching the library submits a half-filled form.
            if (e.key === "Enter") e.preventDefault();
          }}
          placeholder="Search the library by file name"
          className="h-8 text-xs"
        />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {options === null ? (
        <p className="text-xs text-muted-foreground">Loading the library...</p>
      ) : total === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing matches. Upload it on the Documents page first.
        </p>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          {groups.map((group) => (
            <div key={group.key}>
              <p className="sticky top-0 bg-muted/60 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                {group.label} ({group.docs.length})
              </p>
              {group.docs.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onPick(o)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 border-b px-2 py-1.5 text-left text-xs last:border-0",
                    "hover:bg-muted/40",
                    o.olderCopy && "opacity-60",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate" title={o.fileName}>
                    {o.fileName}
                  </span>
                  {o.olderCopy && (
                    <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      older copy
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {docDateLabel(o)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
