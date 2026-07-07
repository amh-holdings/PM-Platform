"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { can, type Capability, type EffectiveRole } from "@/lib/roles";

type Props = {
  projectId: string;
  role: EffectiveRole;
};

export function ProjectTabs({ projectId, role }: Props) {
  const pathname = usePathname() ?? "";
  const base = `/projects/${projectId}`;

  // Each tab is gated by the capability that governs its view (see the matrix
  // in lib/roles.ts). Subs see only Field Reports; the CM sees the operational
  // + billing tabs but not Costs or Pay apps; Phil (full) sees everything. The
  // legacy DPRs / QA-QC tabs are retired - Field Reports supersedes them.
  const allTabs: { href: string; label: string; cap: Capability }[] = [
    { href: base, label: "Dashboard", cap: "viewDashboard" },
    { href: `${base}/field-reports`, label: "Field Reports", cap: "viewFieldReports" },
    { href: `${base}/review-board`, label: "Review Board", cap: "viewAllReports" },
    { href: `${base}/billing`, label: "Billing", cap: "viewBilling" },
    { href: `${base}/pay-apps`, label: "Pay apps", cap: "viewPayApps" },
    { href: `${base}/change-orders`, label: "Change orders", cap: "viewChangeOrders" },
    { href: `${base}/schedule`, label: "Schedule", cap: "viewSchedule" },
    { href: `${base}/subs`, label: "Subs", cap: "viewSubs" },
    { href: `${base}/procurement`, label: "Procurement", cap: "viewProcurement" },
    { href: `${base}/costs`, label: "Costs", cap: "viewCosts" },
    { href: `${base}/documents`, label: "Documents", cap: "viewDocuments" },
  ];

  const tabs = allTabs.filter((t) => can(role, t.cap));

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
