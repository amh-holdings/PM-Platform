"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import type { EffectiveRole } from "@/lib/roles";

type Props = {
  projectId: string;
  role: EffectiveRole;
};

export function ProjectTabs({ projectId, role }: Props) {
  const pathname = usePathname() ?? "";
  const base = `/projects/${projectId}`;

  // Each tab lists the effective roles that may see it. Subs see only Field
  // Reports; the CM sees the operational + financial tabs; Phil (full) sees
  // everything, including the legacy DPRs / QA-QC tabs during transition.
  const ALL: EffectiveRole[] = ["full", "cm", "sub"];
  const CM: EffectiveRole[] = ["full", "cm"];
  const FULL: EffectiveRole[] = ["full"];

  const allTabs: { href: string; label: string; roles: EffectiveRole[] }[] = [
    { href: base, label: "Dashboard", roles: CM },
    { href: `${base}/field-reports`, label: "Field Reports", roles: ALL },
    { href: `${base}/dprs`, label: "DPRs", roles: FULL },
    { href: `${base}/inspections`, label: "QA/QC", roles: FULL },
    { href: `${base}/billing`, label: "Billing", roles: CM },
    { href: `${base}/pay-apps`, label: "Pay apps", roles: CM },
    { href: `${base}/change-orders`, label: "Change orders", roles: CM },
    { href: `${base}/schedule`, label: "Schedule", roles: CM },
    { href: `${base}/subs`, label: "Subs", roles: CM },
    { href: `${base}/procurement`, label: "Procurement", roles: CM },
    { href: `${base}/costs`, label: "Costs", roles: CM },
    { href: `${base}/documents`, label: "Documents", roles: CM },
  ];

  const tabs = allTabs.filter((t) => t.roles.includes(role));

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
