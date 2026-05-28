"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { promoteSuggestionsToPlanned } from "../billing-actions";

type Props = {
  projectId: string;
  disabled?: boolean;
};

export function PromoteSuggestionsButton({ projectId, disabled }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const onClick = async () => {
    setBusy(true);
    setMsg(null);
    const res = await promoteSuggestionsToPlanned(projectId);
    setBusy(false);
    if (!res.ok) {
      setMsg(`Error: ${res.error}`);
      return;
    }
    if (res.written === 0) {
      setMsg("Nothing to write - next month already has values or no suggestions.");
    } else {
      setMsg(`Wrote ${res.written} planned entries for ${res.period_month}.`);
    }
    startTransition(() => router.refresh());
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        disabled={disabled || busy}
        onClick={onClick}
      >
        {busy ? "Promoting..." : "Promote to planned"}
      </Button>
      {msg && <p className="max-w-[220px] text-right text-[10px] text-muted-foreground">{msg}</p>}
    </div>
  );
}
