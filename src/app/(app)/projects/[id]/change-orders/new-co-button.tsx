"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { createDraftChangeOrder } from "../change-orders-actions";

/**
 * Creates a draft CO and goes straight to it.
 *
 * There is no create form. Everything a change order needs lives on the detail
 * page, so a screen in front of it only collected values that page replaced.
 */
export function NewChangeOrderButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await createDraftChangeOrder(projectId);
          if (!res.ok) {
            setBusy(false);
            setError(res.error);
            return;
          }
          startTransition(() => {
            router.push(`/projects/${projectId}/change-orders/${res.coId}`);
          });
        }}
      >
        {busy ? "Creating..." : "New change order"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
