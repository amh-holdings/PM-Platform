"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { resubmitFieldReport } from "../../field-report-actions";

type Props = {
  projectId: string;
  dprId: string;
  reviewNotes: string | null;
  rejectedCount: number;
};

// Shown to the owning subcontractor when their report was returned. It surfaces
// the CM's reason and lets them resubmit the same report once the flagged (red)
// pins have been fixed - the report re-enters the CM's queue.
export function ResubmitBanner({
  projectId,
  dprId,
  reviewNotes,
  rejectedCount,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const onResubmit = async () => {
    setBusy(true);
    setError(null);
    const res = await resubmitFieldReport(dprId, projectId);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    startTransition(() => router.refresh());
  };

  return (
    <section className="rounded-lg border border-red-200 bg-red-50 p-4">
      <h3 className="text-sm font-semibold text-red-900">
        Returned - fix and resubmit
      </h3>
      <p className="mt-1 text-xs text-red-800">
        The Construction Manager returned this report.
        {rejectedCount > 0
          ? ` Fix the ${rejectedCount} flagged (red) work pin${rejectedCount === 1 ? "" : "s"} below, then resubmit.`
          : " Address the notes below, then resubmit."}
      </p>
      {reviewNotes && (
        <p className="mt-2 whitespace-pre-wrap rounded-md bg-white/70 px-2 py-1.5 text-xs text-red-900">
          {reviewNotes}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-3 flex justify-end">
        <Button type="button" size="sm" disabled={busy} onClick={onResubmit}>
          {busy ? "Resubmitting..." : "Resubmit report"}
        </Button>
      </div>
    </section>
  );
}
