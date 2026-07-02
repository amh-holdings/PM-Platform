"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import type { EffectiveRole } from "@/lib/roles";
import { setViewAs } from "./view-as-actions";

// Phil-only preview control. Switches the rendered view between full access,
// Construction Manager, and Subcontractor. Purely presentational - it never
// changes what the server will authorize.
export function ViewAsSwitcher({ effective }: { effective: EffectiveRole }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const options: { value: "self" | "cm" | "sub"; label: string; role: EffectiveRole }[] =
    [
      { value: "self", label: "Full", role: "full" },
      { value: "cm", label: "Construction Mgr", role: "cm" },
      { value: "sub", label: "Subcontractor", role: "sub" },
    ];

  function choose(value: "self" | "cm" | "sub") {
    startTransition(async () => {
      await setViewAs(value);
      router.refresh();
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
