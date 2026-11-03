"use client";

/**
 * Attachments while logging an RFI, before it exists.
 *
 * Zarina: "no option to choose from the plan set" - the attach and markup
 * buttons only lived on a saved RFI, because attaching needs an rfi id and
 * the id is assigned by the insert. So this holds what was chosen and the
 * form applies it after the save.
 *
 * Files are held as files and upload after the save, so cancelling the form
 * leaves nothing behind. A marked-up sheet is different: flattening it
 * produces a new PNG that has to be stored somewhere to exist at all, so it
 * uploads when it is drawn. Cancel after marking one up and the PNG stays in
 * the library, which is why it carries its own name rather than "markup.png".
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { LibraryPicker } from "./rfi-attach-picker";
import { RfiMarkupDialog } from "./rfi-markup-dialog";

export type StagedDoc = { id: string; fileName: string; markup: boolean };

type Props = {
  projectId: string;
  files: File[];
  onFiles: (files: File[]) => void;
  staged: StagedDoc[];
  onStaged: (staged: StagedDoc[]) => void;
};

export function RfiNewAttachments({
  projectId,
  files,
  onFiles,
  staged,
  onStaged,
}: Props) {
  const [picking, setPicking] = useState(false);
  const [markingUp, setMarkingUp] = useState(false);

  function stage(doc: StagedDoc) {
    // Picking the same sheet twice is a slip, not an instruction to attach it
    // twice.
    if (staged.some((s) => s.id === doc.id)) return;
    onStaged([...staged, doc]);
  }

  const total = files.length + staged.length;

  return (
    <div className="space-y-2">
      <Label htmlFor="rfi_files">Photos, sheets and markups</Label>

      <div className="flex flex-wrap items-center gap-2">
        <input
          id="rfi_files"
          type="file"
          multiple
          onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
          className="block text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setPicking(true)}
        >
          Attach from the plan sets
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setMarkingUp(true)}
        >
          Mark up a sheet
        </Button>
      </div>

      {picking && (
        <LibraryPicker
          projectId={projectId}
          rfiId={null}
          onPick={(doc) => {
            stage({ id: doc.id, fileName: doc.fileName, markup: false });
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      )}

      {total > 0 ? (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.name} className="text-xs text-muted-foreground">
              {f.name} <span className="text-[10px]">(uploads on save)</span>
            </li>
          ))}
          {staged.map((d) => (
            <li key={d.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{d.fileName}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {d.markup ? "marked up" : "from the library"}
              </span>
              <button
                type="button"
                onClick={() => onStaged(staged.filter((s) => s.id !== d.id))}
                className="shrink-0 text-[10px] text-muted-foreground underline hover:text-destructive"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          A photo of the condition settles what a paragraph describes. A sheet
          already in the library attaches without a second upload.
        </p>
      )}

      {markingUp && (
        <RfiMarkupDialog
          projectId={projectId}
          rfiId={null}
          onAttach={async (documentId, fileName) => {
            stage({ id: documentId, fileName, markup: true });
            return { ok: true };
          }}
          onClose={() => setMarkingUp(false)}
          onSaved={() => {}}
        />
      )}
    </div>
  );
}
