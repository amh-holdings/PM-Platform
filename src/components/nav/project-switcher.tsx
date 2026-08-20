"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Building2, Check, ChevronsUpDown, LayoutGrid } from "lucide-react";

import { cn } from "@/lib/utils";

export type ProjectOption = {
  id: string;
  name: string;
  client: string | null;
  status: string | null;
};

type Props = {
  projectId: string;
  projects: ProjectOption[];
  collapsed: boolean;
};

/**
 * Sits at the top of the rail. Two jobs: say which project you are in, and let
 * you leave it - either sideways into another project, or up into the
 * portfolio. Everything in this app has been project-scoped, so this is where
 * the portfolio scope gets its entry point.
 */
export function ProjectSwitcher({ projectId, projects, collapsed }: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const current = projects.find((p) => p.id === projectId);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={collapsed ? (current?.name ?? "Switch project") : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
          collapsed && "justify-center px-0",
        )}
      >
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium leading-tight">
                {current?.name ?? "Project"}
              </span>
              {current?.client && (
                <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                  {current.client}
                </span>
              )}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </>
        )}
        {collapsed && <span className="sr-only">Switch project</span>}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border bg-popover p-1 shadow-lg"
        >
          <Link
            href="/projects"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
            All projects
          </Link>
          <div className="my-1 border-t" />
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-start gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            >
              <Check
                className={cn(
                  "mt-0.5 h-3.5 w-3.5 shrink-0",
                  project.id === projectId ? "opacity-100" : "opacity-0",
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block truncate leading-tight">{project.name}</span>
                {project.client && (
                  <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                    {project.client}
                  </span>
                )}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
