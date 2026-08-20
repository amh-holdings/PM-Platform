"use client";

import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { activeItem } from "@/lib/nav";

type Props = {
  projectId: string;
  /** Rendered on the right of the section header (view-as, edit project). */
  actions: React.ReactNode;
  children: React.ReactNode;
};

/**
 * The content column. Two jobs, both driven by which registry entry the URL is
 * inside: name the section you are looking at, and pick the width it deserves.
 *
 * Width used to be one global max-w-5xl. That is a reading width, and it was
 * squeezing schedule grids and G703 lines into a column meant for prose. The
 * `wide` flag lives on the registry entry so a new data-heavy section declares
 * its own width instead of inheriting the wrong one.
 */
export function ProjectMain({ projectId, actions, children }: Props) {
  const pathname = usePathname() ?? "";
  const active = activeItem(pathname, projectId);
  const wide = active?.wide ?? false;

  return (
    <div className="min-w-0 flex-1">
      <div
        className={cn(
          "mx-auto w-full px-4 py-6 lg:px-8",
          wide ? "max-w-[1600px]" : "max-w-5xl",
        )}
      >
        {/* Routes outside the registry (project settings, for one) keep their
            own heading and do not get the section actions. */}
        {active && (
          <div className="mb-5 flex items-start justify-between gap-4">
            <h1 className="text-xl font-semibold tracking-tight">{active.label}</h1>
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
