"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { finalizeCmLog, reopenCmLog } from "../../cm-log-actions";

type Props = {
  projectId: string;
  logId: string;
  status: "draft" | "final";
};

export function CmLogStatusActions({ projectId, logId, status }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function finalize() {
    setError(null);
    startTransition(async () => {
      const res = await finalizeCmLog(logId, projectId);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  function reopen() {
    setError(null);
    startTransition(async () => {
      const res = await reopenCmLog(logId, projectId);
      if (!res.ok) return setError(res.error);
      router.push(`/projects/${projectId}/cm-log/${logId}/edit`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "draft" ? (
        <>
          <Button asChild size="sm">
            <Link href={`/projects/${projectId}/cm-log/${logId}/edit`}>
              Edit
            </Link>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={finalize}
          >
            {pending ? "Finalizing…" : "Finalize"}
          </Button>
        </>
      ) : (
        <Button size="sm" variant="outline" disabled={pending} onClick={reopen}>
          {pending ? "Reopening…" : "Reopen to edit"}
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
