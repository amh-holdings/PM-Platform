import { cn } from "@/lib/utils";

/**
 * Column for pages that sit outside a project and therefore outside the rail:
 * the portfolio list, project creation, diagnostics. Project pages get their
 * width from the nav registry instead - see project-main.tsx.
 */
export function PageShell({
  wide = false,
  children,
}: {
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-8 lg:px-6",
        wide ? "max-w-[1600px]" : "max-w-5xl",
      )}
    >
      {children}
    </div>
  );
}
