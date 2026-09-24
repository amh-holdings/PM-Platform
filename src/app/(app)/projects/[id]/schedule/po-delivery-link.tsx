"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import {
  getDeliveryLinkOptions,
  setProcurementDeliveryTaskLink,
  type DeliveryLinkOption,
} from "../procurement-actions";

/**
 * Which purchase orders this schedule task delivers.
 *
 * The link already existed, reachable only from the PO page. That is the wrong
 * end of the journey: somebody working the schedule is looking at 4.4.5.2
 * Delivery and knows GroundWorks delivers it, and going off to find that PO is
 * the step that does not happen. So the link was never set, so completing the
 * row moved nothing on the AFP.
 *
 * With it set, marking this row complete writes the delivery date onto the PO
 * and the AFP picks it up. That sentence is on screen here, because the reason
 * to do this is not obvious from a schedule row.
 */
export function PoDeliveryLink({
  projectId,
  wbsCode,
}: {
  projectId: string;
  wbsCode: string;
}) {
  const router = useRouter();
  const [, startLinkTransition] = useTransition();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState<DeliveryLinkOption[]>([]);
  const [available, setAvailable] = useState<DeliveryLinkOption[]>([]);
  const [pick, setPick] = useState("");

  async function load() {
    const res = await getDeliveryLinkOptions(projectId, wbsCode);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setLinked(res.linked);
    setAvailable(res.available);
  }

  useEffect(() => {
    if (!wbsCode) {
      setLoading(false);
      return;
    }
    void load();
    // Loading once when the dialog opens is the point; wbsCode does not change
    // under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, wbsCode]);

  async function apply(poId: string, code: string | null) {
    setBusy(true);
    setError(null);
    const res = await setProcurementDeliveryTaskLink(poId, projectId, code);
    if (!res.ok) {
      setBusy(false);
      setError(res.error);
      return;
    }
    setPick("");
    await load();
    setBusy(false);
    startLinkTransition(() => router.refresh());
  }

  if (!wbsCode) return null;

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3 sm:col-span-2">
      <div>
        <Label>Purchase orders delivered by this task</Label>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Link one and marking this task complete records the delivery date on
          the PO, which is what puts it on the AFP. Without a link the schedule
          moves and the billing does not.
        </p>
      </div>

      {loading && <p className="text-xs text-muted-foreground">Loading...</p>}

      {!loading && linked.length > 0 && (
        <ul className="space-y-1">
          {linked.map((po) => (
            <li
              key={po.id}
              className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1 text-xs"
            >
              <span>
                <span className="font-medium">{po.label}</span>
                {po.actualDelivery && (
                  <span className="ml-2 text-emerald-700">
                    delivered {po.actualDelivery}
                  </span>
                )}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void apply(po.id, null)}
                className="text-muted-foreground hover:text-destructive"
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && linked.length === 0 && (
        <p className="text-xs text-amber-700">
          Not linked yet, so completing this task will not reach the AFP.
        </p>
      )}

      {!loading && (
        <div className="flex gap-2">
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            disabled={busy || available.length === 0}
            className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
          >
            <option value="">
              {available.length === 0 ? "No other purchase orders" : "Link a purchase order..."}
            </option>
            {available.map((po) => (
              <option key={po.id} value={po.id}>
                {po.label}
                {po.linkedWbs ? ` (now on ${po.linkedWbs})` : ""}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !pick}
            onClick={() => void apply(pick, wbsCode)}
          >
            {busy ? "Linking..." : "Link"}
          </Button>
        </div>
      )}

      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
