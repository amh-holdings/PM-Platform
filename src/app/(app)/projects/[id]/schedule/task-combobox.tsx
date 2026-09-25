"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  searchTasks,
  taskDisplayLabel,
  type SearchableTask,
} from "@/lib/schedule-task-search";

/**
 * Pick a task by typing at it.
 *
 * Zarina: "need to have option to type and suggest in the dropdown for the
 * predecessors." This replaces a native select holding every leaf on the
 * project. Same value going in and out - the stored thing is still the WBS
 * code - so nothing downstream of the form changes.
 *
 * It stays an input the whole time rather than swapping between a label and a
 * box, because the swap loses the caret on the first keystroke and puts the
 * cursor at the wrong end of the text half the time.
 */
export function TaskCombobox<T extends SearchableTask>({
  value,
  options,
  onChange,
  rowOf,
  branchSizeOf,
  parentNameOf,
  invalid,
  placeholder = "Type a row number, code or task name",
}: {
  /** WBS code. May be a code that no longer exists. */
  value: string;
  options: readonly T[];
  onChange: (wbs: string) => void;
  rowOf?: (wbs: string) => number | null | undefined;
  /** How many tasks sit under this code, when it is a branch rather than work. */
  branchSizeOf?: (wbs: string) => number;
  /**
   * The branch this task sits in.
   *
   * Zarina: "can you add the parent name to the children task so I can make
   * sure it is the same delivery task for a certain parent task." Sweet
   * Springs carries a Lead Time and a Delivery under CAB Hangers, Maddox
   * 1500kVA, Recloser, GroundWorks and PowerFactors. Without the branch, five
   * rows in this list read "Delivery" and the only thing separating them is a
   * WBS code nobody has memorised.
   */
  parentNameOf?: (wbs: string) => string | null | undefined;
  invalid?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  // null means "not being typed in", so the box shows the selection.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const nameByCode = useMemo(
    () => new Map(options.map((o) => [o.wbs_code, o.task_name])),
    [options],
  );

  const selectedLabel = taskDisplayLabel(value, {
    name: nameByCode.get(value) ?? null,
    row: rowOf?.(value) ?? null,
    parentName: parentNameOf?.(value) ?? null,
  });

  // 200 rather than 50. Branches are listed now, which adds rows, and a
  // person scrolling for a code they have not finished typing should reach it.
  const { matches, hidden } = useMemo(
    // parentNameOf goes in so "cab delivery" finds the one under CAB
    // Hangers. Searching the name alone returns all five Deliveries and
    // leaves the reading to the person, which is the problem.
    () => searchTasks(options, query ?? "", { rowOf, parentNameOf, limit: 200 }),
    [options, query, rowOf, parentNameOf],
  );

  useEffect(() => {
    setActive(0);
  }, [query]);

  // A click anywhere else is a decision not to change the selection.
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery(null);
      }
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  function choose(wbs: string) {
    onChange(wbs);
    setOpen(false);
    setQuery(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        if (matches.length === 0) return 0;
        return (next + matches.length) % matches.length;
      });
      return;
    }
    if (e.key === "Enter") {
      // Inside a form, so a bare Enter would submit the whole dialog.
      e.preventDefault();
      if (open && matches[active]) choose(matches[active].wbs_code);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQuery(null);
    }
  }

  return (
    <div ref={boxRef} className="relative min-w-0 flex-1">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="task-combobox-list"
        autoComplete="off"
        value={query ?? selectedLabel}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "h-9 w-full rounded-md border bg-background px-2 text-sm",
          invalid ? "border-destructive text-destructive" : "border-input",
        )}
      />

      {open && (
        <div
          id="task-combobox-list"
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-background shadow-lg"
        >
          {matches.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No task or branch matches that.
            </p>
          )}
          {matches.map((o, i) => {
            const row = rowOf?.(o.wbs_code);
            const branch = branchSizeOf?.(o.wbs_code) ?? 0;
            const parent = parentNameOf?.(o.wbs_code);
            return (
              <button
                key={o.wbs_code}
                type="button"
                role="option"
                aria-selected={o.wbs_code === value}
                // Down rather than click, so the choice registers before the
                // input's blur can close the list out from under it.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o.wbs_code);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-xs",
                  i === active ? "bg-accent" : "",
                )}
              >
                <span className="font-mono text-muted-foreground">
                  {row != null ? row : o.wbs_code}
                </span>
                <span className="shrink-0 truncate">{o.task_name}</span>
                {/* Which branch it belongs to. The single most useful thing
                    on the row when the name repeats, so it goes right beside
                    the name rather than at the end. */}
                {parent && branch === 0 && (
                  <span className="truncate text-muted-foreground">in {parent}</span>
                )}
                {branch > 0 && (
                  <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    branch of {branch}
                  </span>
                )}
                {row != null && (
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                    {o.wbs_code}
                  </span>
                )}
              </button>
            );
          })}
          {hidden > 0 && (
            <p className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
              {hidden} more match. Keep typing to narrow it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
