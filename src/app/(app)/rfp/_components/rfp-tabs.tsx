"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  {
    href: "/rfp",
    label: "Bids",
    match: (p: string) => p === "/rfp" || (p.startsWith("/rfp/") && !p.startsWith("/rfp/states") && !p.startsWith("/rfp/runbook")),
  },
  { href: "/rfp/states", label: "State profiles", match: (p: string) => p.startsWith("/rfp/states") },
  { href: "/rfp/runbook", label: "Runbook", match: (p: string) => p.startsWith("/rfp/runbook") },
];

export function RfpTabs() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto border-b pb-px text-sm">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={cn(
            "whitespace-nowrap border-b-2 px-3 py-2 font-medium transition-colors",
            t.match(pathname)
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
