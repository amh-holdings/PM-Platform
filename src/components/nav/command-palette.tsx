"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import type { EffectiveRole } from "@/lib/roles";
import {
  actionHref,
  hrefFor,
  matchesQuery,
  projectIdFromPath,
  visibleActions,
  visibleNav,
} from "@/lib/nav";

import type { ProjectOption } from "./project-switcher";

export const PALETTE_EVENT = "ahc:open-palette";

type Row = { id: string; label: string; hint: string; href: string };

type Props = {
  role: EffectiveRole;
  projects: ProjectOption[];
};


/**
 * Search over the same registry the rail renders. Past twenty destinations
 * people type instead of scanning, and this is the cheapest place to put
 * actions next to pages.
 */
export function CommandPalette({ role, projects }: Props) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const projectId = projectIdFromPath(pathname);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((v) => !v);
      }
      if (event.key === "Escape") setOpen(false);
    }
    // The top-bar button and the phone have no Cmd-K, so they ask by event.
    function onAsk() {
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_EVENT, onAsk);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_EVENT, onAsk);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // Focus after the dialog paints, or the caret lands nowhere.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const groups = useMemo(() => {
    const out: { label: string; rows: Row[] }[] = [];

    if (projectId) {
      const goTo = visibleNav(role)
        .filter((item) => matchesQuery(item, query))
        .map<Row>((item) => ({
          id: `nav:${item.key}`,
          label: item.label,
          hint: item.blurb,
          href: hrefFor(item, projectId),
        }));
      if (goTo.length) out.push({ label: "Go to", rows: goTo });

      const doThis = visibleActions(role)
        .filter((action) => matchesQuery(action, query))
        .map<Row>((action) => ({
          id: `act:${action.key}`,
          label: action.label,
          hint: "This project",
          href: actionHref(action, projectId),
        }));
      if (doThis.length) out.push({ label: "Do", rows: doThis });
    }

    const jump = projects
      .filter((project) => matchesQuery({ label: project.name, find: [project.client ?? ""] }, query))
      .filter((project) => project.id !== projectId)
      .slice(0, 6)
      .map<Row>((project) => ({
        id: `proj:${project.id}`,
        label: project.name,
        hint: project.client ?? "Project",
        href: `/projects/${project.id}`,
      }));
    if (jump.length) out.push({ label: "Projects", rows: jump });

    return out;
  }, [projectId, projects, query, role]);

  const flat = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const activeRow = flat[Math.min(cursor, flat.length - 1)];

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  function onInputKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => (flat.length ? (c + 1) % flat.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => (flat.length ? (c - 1 + flat.length) % flat.length : 0));
    } else if (event.key === "Enter" && activeRow) {
      event.preventDefault();
      go(activeRow.href);
    }
  }

  if (!open) return null;

  let index = -1;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close search"
        onClick={() => setOpen(false)}
        className="absolute inset-0 bg-foreground/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="relative w-full max-w-lg overflow-hidden rounded-lg border bg-popover shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={onInputKey}
            placeholder="Search sections, actions and projects"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:block">
            ESC
          </kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-1">
          {flat.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing matches “{query}”.
            </p>
          )}
          {groups.map((group) => (
            <div key={group.label}>
              <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
              {group.rows.map((row) => {
                index += 1;
                const isActive = activeRow?.id === row.id;
                const rowIndex = index;
                return (
                  <button
                    key={row.id}
                    type="button"
                    onMouseEnter={() => setCursor(rowIndex)}
                    onClick={() => go(row.href)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm",
                      isActive ? "bg-accent text-accent-foreground" : "text-foreground",
                    )}
                  >
                    <span className="truncate">{row.label}</span>
                    <span className="ml-auto truncate pl-3 text-[11px] text-muted-foreground">
                      {row.hint}
                    </span>
                    {isActive && (
                      <CornerDownLeft
                        className="h-3 w-3 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
