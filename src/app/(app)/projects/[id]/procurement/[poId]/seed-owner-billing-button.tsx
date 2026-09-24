"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

import { seedOwnerBillingHalfOnPo } from "../../procurement-actions";

/**
 * The standing rule in one click: bill the owner half the PO the day it is
 * issued, the balance on delivery.
 *
 * Only offered while the owner side is empty, because it inserts rather than
 * replaces and two clicks should not produce four milestones.
 */
export function SeedOwnerBillingButton({
  poId,
  projectId,
}: {
  poId: string;
  projectId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function run() {
    setBusy(true);
    setError(null);
    const res = await seedOwnerBillingHalfOnPo(poId, projectId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="text-right">
      <Button size="sm" variant="outline" onClick={run} disabled={busy}>
        {busy ? "Adding..." : "Bill owner 50% on PO"}
      </Button>
      {error && <p className="mt-1 max-w-xs text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
