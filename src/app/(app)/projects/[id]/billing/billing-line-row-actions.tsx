"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  deleteBillingLine,
  inspectBillingLineDelete,
  type DeleteCheck,
} from "../billing-line-actions";
import {
  BillingLineDialog,
  type BillingLineFormValues,
} from "./billing-line-dialog";

type Props = {
  projectId: string;
  line: BillingLineFormValues & { id: string };
  knownTypes: string[];
};

export function BillingLineRowActions({ projectId, line, knownTypes }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [check, setCheck] = useState<DeleteCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [, startTransition] = useTransition();

  // What a delete would take with it is worked out before the dialog opens, not
  // after the click. An SOV line with billed money behind it must never be one
  // confirm away from gone.
  async function openConfirm() {
    setConfirming(true);
    setLoading(true);
    setError(null);
    setCheck(null);
    const res = await inspectBillingLineDelete(line.id, projectId);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setCheck(res.check);
  }

  async function confirmDelete() {
    setDeleting(true);
    setError(null);
    const res = await deleteBillingLine(line.id, projectId);
    setDeleting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setConfirming(false);
    startTransition(() => router.refresh());
  }

  const blocked = (check?.blockers.length ?? 0) > 0;

  return (
    <div className="flex justify-end gap-1">
      <BillingLineDialog
        projectId={projectId}
        initial={line}
        knownTypes={knownTypes}
        trigger={
          <Button variant="ghost" size="sm">
            Edit
          </Button>
        }
      />
      <Button variant="ghost" size="sm" onClick={() => void openConfirm()}>
        Delete
      </Button>

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirming(false);
          }}
        >
          <div className="w-full max-w-lg rounded-lg bg-background p-6 text-left shadow-xl">
            <h3 className="text-lg font-semibold">
              Delete item {line.item_number}?
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {line.description}
            </p>

            {loading && (
              <p className="mt-4 text-sm text-muted-foreground">
                Checking what depends on this line...
              </p>
            )}

            {check && blocked && (
              <div className="mt-4 space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <p className="font-medium">This line cannot be deleted.</p>
                <ul className="list-disc space-y-1 pl-5">
                  {check.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}

            {check && !blocked && (
              <div className="mt-4 space-y-3">
                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                  Nothing billed sits against this line, so removing it does not
                  change any AFP already sent.
                </div>
                {check.cascades.length > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                    <p className="font-medium">Deleted with it:</p>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {check.cascades.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2 border-t pt-4">
              <Button
                variant="ghost"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                {blocked ? "Close" : "Cancel"}
              </Button>
              {check && !blocked && (
                <Button
                  variant="destructive"
                  onClick={() => void confirmDelete()}
                  disabled={deleting}
                >
                  {deleting ? "Deleting..." : "Delete line"}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
