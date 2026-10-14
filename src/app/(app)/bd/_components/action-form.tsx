"use client";

import { useFormState, useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import type { BdFormState } from "../form-state";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} size="sm">
      {pending ? "Saving..." : label}
    </Button>
  );
}

/**
 * Every BD form: posts to a server action, shows its error, and clears itself
 * after a save that did not navigate away (log a touch, add a bid, add a
 * contact) by remounting on the action's `saved` counter.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  className,
}: {
  action: (prev: BdFormState, formData: FormData) => Promise<BdFormState>;
  submitLabel: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, formAction] = useFormState(action, {});
  return (
    <form key={state.saved ?? 0} action={formAction} className={className ?? "space-y-4"}>
      {children}
      {state.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {state.error}
        </div>
      )}
      <div className="flex justify-end">
        <Submit label={submitLabel} />
      </div>
    </form>
  );
}
