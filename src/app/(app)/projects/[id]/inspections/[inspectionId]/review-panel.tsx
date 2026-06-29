"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { nextStatuses, type InspectionStatus } from "@/lib/inspection-status";
import { PhotoUploader, type UploadedPhoto } from "../photo-uploader";
import {
  startReview,
  attachAhcVerification,
  decideInspection,
} from "../inspection-actions";

export function ReviewPanel({
  projectId,
  inspectionId,
  status,
  canDecide,
}: {
  projectId: string;
  inspectionId: string;
  status: InspectionStatus;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ahcNotes, setAhcNotes] = useState("");
  const [ahcPhotos, setAhcPhotos] = useState<UploadedPhoto[]>([]);
  const [decisionNotes, setDecisionNotes] = useState("");

  const allowed = nextStatuses(status);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Action failed");
      else router.refresh();
    });
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">AHC review</h3>

      {status === "approved" && (
        <p className="text-sm text-green-700">
          This record is approved and locked. No further edits.
        </p>
      )}

      {status === "submitted" && allowed.includes("under_review") && (
        <Button
          disabled={pending}
          onClick={() => run(() => startReview(inspectionId, projectId))}
        >
          {pending ? "Starting…" : "Start review"}
        </Button>
      )}

      {status === "under_review" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Verification notes (attach AHC photos at the same locations)
            </label>
            <textarea
              value={ahcNotes}
              onChange={(e) => setAhcNotes(e.target.value)}
              rows={3}
              className="w-full rounded-md border bg-background p-2 text-sm"
              placeholder="AHC field verification notes."
            />
            <PhotoUploader
              projectId={projectId}
              side="ahc"
              inspectionId={inspectionId}
              onChange={setAhcPhotos}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={pending || (!ahcNotes.trim() && ahcPhotos.length === 0)}
              onClick={() =>
                run(() =>
                  attachAhcVerification({
                    inspectionId,
                    projectId,
                    ahcNotes: ahcNotes.trim() || null,
                    photos: ahcPhotos,
                  }),
                )
              }
            >
              Save verification
            </Button>
          </div>

          <div className="space-y-2 border-t pt-4">
            {canDecide ? (
              <>
                <label className="text-xs font-medium text-muted-foreground">
                  Decision (Mark Wooley). A reason is required to reject.
                </label>
                <textarea
                  value={decisionNotes}
                  onChange={(e) => setDecisionNotes(e.target.value)}
                  rows={2}
                  className="w-full rounded-md border bg-background p-2 text-sm"
                  placeholder="Reason / note"
                />
                <div className="flex gap-2">
                  <Button
                    disabled={pending}
                    onClick={() =>
                      run(() =>
                        decideInspection({
                          inspectionId,
                          projectId,
                          decision: "approved",
                          decisionNotes: decisionNotes.trim() || null,
                        }),
                      )
                    }
                  >
                    Approve & lock
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={pending}
                    onClick={() =>
                      run(() =>
                        decideInspection({
                          inspectionId,
                          projectId,
                          decision: "rejected",
                          decisionNotes: decisionNotes.trim() || null,
                        }),
                      )
                    }
                  >
                    Reject
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Awaiting Mark Wooley&apos;s approval. Only the QA/QC approver can
                approve or reject.
              </p>
            )}
          </div>
        </div>
      )}

      {status === "rejected" && (
        <p className="text-sm text-red-700">
          Rejected and returned to the sub for resubmission.
        </p>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
