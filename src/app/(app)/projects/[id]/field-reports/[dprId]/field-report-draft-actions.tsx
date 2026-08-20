"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { discardFieldReportDraft } from "../../field-report-actions";

type Props = {
  projectId: string;
  dprId: string;
};

// Actions on an unsubmitted Field Report. There is no "submit" button here -
// submitting runs the pin-by-pin validation that only the form can do, so this
// sends the sub back to the editor to finish and file it there.
export function FieldReportDraftActions({ projectId, dprId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function discard() {
    setError(null);
    startTransition(async () => {
      const res = await discardFieldReportDraft(dprId, projectId);
      if (!res.ok) {
        setConfirming(false);
        return setError(res.error);
      }
      router.push(`/projects/${projectId}/field-reports`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm">
        <Link href={`/projects/${projectId}/field-reports/${dprId}/edit`}>
          Continue editing
        </Link>
      </Button>
      {confirming ? (
        <>
          <span className="text-xs text-muted-foreground">
            Delete this draft and its photos?
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={discard}
          >
            {pending ? "Discarding..." : "Yes, discard"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            Keep it
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setConfirming(true)}
        >
          Discard draft
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
