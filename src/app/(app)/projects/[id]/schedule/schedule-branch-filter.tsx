"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  branchLabel,
  pruneRedundant,
  type Branch,
} from "@/lib/schedule-branches";

type Props = {
  options: Branch[];
  selected: string[];
  setSelected: (next: string[]) => void;
  /** Rows currently showing, for the button's count. */
  shown: number;
  total: number;
};

export function ScheduleBranchFilter({
  options,
  selected,
  setSelected,
  shown,
  total,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const label = branchLabel(selected, options);
  const shownOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.name.toLowerCase().includes(q) || o.wbs.includes(q),
    );
  }, [options, query]);

  function toggle(wbs: string) {
    const on = selected.includes(wbs);
    const next = on ? selected.filter((b) => b !== wbs) : [...selected, wbs];
    // Ticking a parent swallows its children rather than leaving both on, so
    // the chip row and the row count stay honest.
    setSelected(pruneRedundant(next));
  }

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-2 text-sm font-medium"
      >
        <span className={cn(!label && "text-muted-foreground")}>
          {label ?? "All branches"}
        </span>
        <span className="text-xs text-muted-foreground">
          ({shown}
          {shown !== total ? ` of ${total}` : ""})
        </span>
        <span aria-hidden className="text-xs text-muted-foreground">
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute left-0 z-40 mt-1 w-[26rem] rounded-md border bg-background p-2 shadow-lg">
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a branch"
              className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs"
            />
            <button
              type="button"
              onClick={() => setSelected([])}
              disabled={selected.length === 0}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40"
            >
              Clear
            </button>
          </div>

          <div className="mt-2 max-h-80 overflow-y-auto">
            {shownOptions.map((o) => {
              const on = selected.includes(o.wbs);
              // A branch under one that is already ticked is covered by it.
              const covered =
                !on && selected.some((b) => o.wbs.startsWith(b + "."));
              return (
                <label
                  key={o.wbs}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted",
                    covered && "opacity-50",
                  )}
                  style={{ paddingLeft: `${4 + o.depth * 14}px` }}
                >
                  <input
                    type="checkbox"
                    checked={on || covered}
                    disabled={covered}
                    onChange={() => toggle(o.wbs)}
                  />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {o.wbs}
                  </span>
                  <span className="truncate">{o.name || "(unnamed)"}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {o.descendants}
                  </span>
                </label>
              );
            })}
            {shownOptions.length === 0 && (
              <p className="px-1 py-3 text-center text-xs text-muted-foreground">
                No branch matches that.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
