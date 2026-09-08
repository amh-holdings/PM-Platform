"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { resyncChangeOrderTotals } from "../../change-orders-actions";

export function ResyncTotalsButton({
  projectId,
  changeOrderId,
}: {
  projectId: string;
  changeOrderId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-destructive">{error}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await resyncChangeOrderTotals(changeOrderId, projectId);
          setBusy(false);
          if (!res.ok) setError(res.error);
          else router.refresh();
        }}
        className="shrink-0 rounded border border-amber-400 bg-white px-2 py-1 text-xs font-medium hover:bg-amber-100 disabled:opacity-50"
      >
        {busy ? "Syncing..." : "Resync from buildup"}
      </button>
    </span>
  );
}
