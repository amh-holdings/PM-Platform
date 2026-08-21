"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";
import type { EffectiveRole } from "@/lib/roles";
import {
  activeItem,
  hrefFor,
  mobilePrimary,
  visibleGroups,
  type NavCounts,
  type NavItem,
} from "@/lib/nav";

type Props = {
  projectId: string;
  role: EffectiveRole;
  counts: NavCounts;
};

/**
 * The phone shape. This is an installed portrait PWA and the field runs on it,
 * so a horizontal strip of thirteen was never going to work here.
 *
 * Three destinations plus More is about what a thumb reaches reliably. Which
 * three comes from the registry by role, so a sub gets one slot and no menu
 * while Phil gets Dashboard / Field Reports / Billing.
 */
export function MobileNav({ projectId, role, counts }: Props) {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const primary = mobilePrimary(role);
  const groups = visibleGroups(role);
  const active = activeItem(pathname, projectId);
  const primaryKeys = new Set(primary.map((item) => item.key));

  // Anything not in the bar lives behind More. If that is nothing, the fourth
  // slot is dropped rather than opening an empty sheet.
  const overflow = groups
    .map((group) => ({ ...group, items: group.items.filter((i) => !primaryKeys.has(i.key)) }))
    .filter((group) => group.items.length > 0);
  const hasOverflow = overflow.length > 0;

  // Route changes come from taps inside the sheet, so close on navigation.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const overflowCount = overflow
    .flatMap((group) => group.items)
    .reduce((sum, item) => sum + (item.hasCount ? (counts[item.key] ?? 0) : 0), 0);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-foreground/30"
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl">
            <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-border" />
            <div className="p-3">
              {overflow.map((group) => (
                <div key={group.key} className="mb-3 last:mb-0">
                  <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </p>
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.key}>
                        <SheetLink
                          item={item}
                          projectId={projectId}
                          count={item.hasCount ? counts[item.key] : undefined}
                          isActive={active?.key === item.key}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav
        aria-label="Project sections"
        className="fixed inset-x-0 bottom-0 z-30 grid h-[var(--mobile-nav-h)] border-t bg-background pb-[env(safe-area-inset-bottom,0px)] lg:hidden"
        style={{ gridTemplateColumns: `repeat(${primary.length + (hasOverflow ? 1 : 0)}, 1fr)` }}
      >
        {primary.map((item) => {
          const Icon = item.icon;
          const isActive = active?.key === item.key;
          const count = item.hasCount ? counts[item.key] : undefined;
          return (
            <Link
              key={item.key}
              href={hrefFor(item, projectId)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex flex-col items-center gap-1 py-2 text-[10px]",
                isActive ? "font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              <span className="relative block h-5 w-5">
                <Icon className="h-5 w-5" aria-hidden />
                {count ? <Pip value={count} /> : null}
              </span>
              <span className="max-w-full truncate px-1">{item.label}</span>
            </Link>
          );
        })}
        {hasOverflow && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={cn(
              "flex flex-col items-center gap-1 py-2 text-[10px]",
              open ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="relative block h-5 w-5">
              <MoreHorizontal className="h-5 w-5" aria-hidden />
              {overflowCount > 0 ? <Pip value={overflowCount} /> : null}
            </span>
            <span>More</span>
          </button>
        )}
      </nav>

      {/* No spacer here. This component is a flex-row child of the project
          layout, so a block of height would sit beside the content column
          instead of under it and reserve nothing. Pages reserve the room
          themselves with --mobile-nav-h - see components/nav/project-main.tsx. */}
    </>
  );
}

function Pip({ value }: { value: number }) {
  return (
    <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold tabular-nums text-white">
      {value > 99 ? "99+" : value}
    </span>
  );
}

function SheetLink({
  item,
  projectId,
  count,
  isActive,
}: {
  item: NavItem;
  projectId: string;
  count: number | undefined;
  isActive: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={hrefFor(item, projectId)}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-2 py-2.5 text-sm",
        isActive ? "bg-accent font-medium text-accent-foreground" : "text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 truncate">{item.label}</span>
      {count ? (
        <span className="rounded-full bg-amber-100 px-1.5 text-[11px] font-medium tabular-nums text-amber-900">
          {count}
        </span>
      ) : null}
    </Link>
  );
}
