"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

type Props = {
  projectId: string;
};

export function ProjectTabs({ projectId }: Props) {
  const pathname = usePathname() ?? "";
  const base = `/projects/${projectId}`;

  const tabs: { href: string; label: string }[] = [
    { href: base, label: "Dashboard" },
    { href: `${base}/dprs`, label: "DPRs" },
    { href: `${base}/billing`, label: "Billing" },
    { href: `${base}/schedule`, label: "Schedule" },
    { href: `${base}/subs`, label: "Subs" },
    { href: `${base}/costs`, label: "Costs" },
    { href: `${base}/documents`, label: "Documents" },
  ];

  function isActive(href: string) {
    if (href === base) return pathname === base;
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="-mx-4 overflow-x-auto border-b sm:mx-0">
      <ul className="flex min-w-max items-stretch gap-1 px-4 sm:px-0">
        {tabs.map((tab) => {
          const active = isActive(tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                className={cn(
                  "inline-flex h-10 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors",
                  active
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
