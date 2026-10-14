"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/bd", label: "Follow-ups", match: (p: string) => p === "/bd" },
  {
    href: "/bd/pipeline",
    label: "Pipeline",
    match: (p: string) => p.startsWith("/bd/pipeline") || p.startsWith("/bd/opportunities"),
  },
  { href: "/bd/clients", label: "Clients", match: (p: string) => p.startsWith("/bd/clients") },
  { href: "/bd/dashboard", label: "Dashboard", match: (p: string) => p.startsWith("/bd/dashboard") },
];

export function BdTabs() {
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
