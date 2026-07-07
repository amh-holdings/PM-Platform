"use client";

import { useTransition } from "react";

import { cn } from "@/lib/utils";
import type { EffectiveRole } from "@/lib/roles";
import { setViewAs } from "./view-as-actions";

// Phil-only preview control. Switches the rendered view between full access,
// Construction Manager, and Subcontractor. Purely presentational - it never
// changes what the server will authorize.
export function ViewAsSwitcher({
  effective,
  projectId,
}: {
  effective: EffectiveRole;
  projectId: string;
}) {
  const [pending, startTransition] = useTransition();

  const options: { value: "self" | "cm" | "sub"; label: string; role: EffectiveRole }[] =
    [
      { value: "self", label: "Full", role: "full" },
      { value: "cm", label: "Construction Mgr", role: "cm" },
      { value: "sub", label: "Subcontractor", role: "sub" },
    ];

  function choose(value: "self" | "cm" | "sub") {
    // setViewAs sets the cookie and redirects server-side to a landing the new
    // role can see, so no client-side navigation is needed here.
    startTransition(() => {
      void setViewAs(value, projectId);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        View as
      </span>
      <div className="flex gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={pending}
            onClick={() => choose(o.value)}
            className={cn(
              "rounded-md border px-2 py-0.5 text-xs font-medium disabled:opacity-50",
              effective === o.role
                ? "border-foreground bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
