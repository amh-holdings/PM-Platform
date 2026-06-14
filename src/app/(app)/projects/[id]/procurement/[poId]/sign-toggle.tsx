"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { setProcurementSignedStatus } from "../../procurement-actions";

type Props = {
  poId: string;
  projectId: string;
  signedAt: string | null;
};

export function PoSignToggle({ poId, projectId, signedAt }: Props) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick(signed: boolean) {
    setError(null);
    if (!signed && !confirm("Mark this PO as unsigned (revert to draft)? Billing on this scope will be blocked again."))
      return;
    startBusy(async () => {
      const result = await setProcurementSignedStatus(poId, projectId, signed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {signedAt ? (
        <>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700">
            Signed {new Date(signedAt).toLocaleDateString()}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleClick(false)}
            disabled={busy}
            className="h-7 text-xs"
          >
            {busy ? "..." : "Revert to draft"}
          </Button>
        </>
      ) : (
        <>
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
            Draft (not signed)
          </span>
          <Button
            size="sm"
            onClick={() => handleClick(true)}
            disabled={busy}
            className={cn("h-7 bg-emerald-700 text-xs hover:bg-emerald-700/90")}
          >
            {busy ? "Marking..." : "Mark as signed"}
          </Button>
        </>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
