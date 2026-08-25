"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { cn } from "@/lib/utils";
import type { EffectiveRole } from "@/lib/roles";
import { activeItem, hrefFor, visibleGroups, type NavCounts } from "@/lib/nav";

import { ProjectSwitcher, type ProjectOption } from "./project-switcher";

export const RAIL_COOKIE = "ahc_rail";

type Props = {
  projectId: string;
  role: EffectiveRole;
  counts: NavCounts;
  projects: ProjectOption[];
  defaultCollapsed: boolean;
};

export function ProjectRail({
  projectId,
  role,
  counts,
  projects,
  defaultCollapsed,
}: Props) {
  // Seeded from a cookie the server already read, so the first paint matches
  // the user's last choice instead of flashing open then snapping shut.
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const pathname = usePathname() ?? "";
  const groups = visibleGroups(role);
  const active = activeItem(pathname, projectId);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${RAIL_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <nav
      aria-label="Project sections"
      className={cn(
        "sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 flex-col border-r bg-background lg:flex",
        // A printed page goes to the owner. App chrome has no business on it.
        "print:hidden",
        collapsed ? "w-14" : "w-56",
      )}
    >
      <div className={cn("border-b p-2", collapsed && "px-1.5")}>
        <ProjectSwitcher
          projectId={projectId}
          projects={projects}
          collapsed={collapsed}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {groups.map((group) => (
          <div key={group.key} className="mb-3 last:mb-0">
            {!collapsed && (
              <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
            )}
            {collapsed && <div className="mx-2 mb-2 border-t first:border-t-0" />}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = active?.key === item.key;
                const count = item.hasCount ? counts[item.key] : undefined;
                return (
                  <li key={item.key}>
                    <Link
                      href={hrefFor(item, projectId)}
                      title={collapsed ? item.label : undefined}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                        collapsed && "justify-center px-0",
                        isActive
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                      {count ? (
                        collapsed ? (
                          <span
                            className="absolute right-1.5 top-1 h-1.5 w-1.5 rounded-full bg-amber-500"
                            aria-hidden
                          />
                        ) : (
                          <span className="ml-auto rounded-full bg-amber-100 px-1.5 text-[11px] font-medium tabular-nums text-amber-900">
                            {count}
                          </span>
                        )
                      ) : null}
                      {collapsed && <span className="sr-only">{item.label}</span>}
                      {count && collapsed ? (
                        <span className="sr-only">{count} awaiting attention</span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t p-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden />
          )}
          {collapsed ? <span className="sr-only">Expand sidebar</span> : <span>Collapse</span>}
        </button>
      </div>
    </nav>
  );
}
