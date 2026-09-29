"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { EquipmentCatalogEntry } from "../../equipment-actions";

/**
 * Pick a machine, add one, or take one off the crew's list.
 *
 * A native select could do the first two and never the third: an <option> can
 * hold text and nothing else, so "remove this one" had to be a magic entry at
 * the bottom that acted on whatever happened to be selected. Zarina, looking
 * at a list that had grown to include "Develon 250", "Develon 250 WD",
 * "Devlon excavator", "Devion excvator" and "Dodson excavator": "Need to have
 * an option to remove some of the equipment here. Like put an x or delete on
 * the right side for each line."
 *
 * So each row is its own line with its own X. Typing filters, which is the
 * other half of the same problem - the list is long because inline add makes
 * it easy to create a near-duplicate, and it stays long until someone can see
 * the duplicates side by side and clear them out.
 *
 * Removing retires rather than deletes. Every dpr_equipment row on a filed
 * report points at this id, so the entry has to keep resolving; see
 * retireProjectEquipment in equipment-actions.ts.
 */
export function EquipmentCombobox({
  value,
  valueName,
  options,
  busy,
  onPick,
  onAdd,
  onRemove,
}: {
  /** Selected catalog id, or "" for nothing picked. */
  value: string;
  /** What this row already recorded, for a machine no longer in the catalog. */
  valueName: string;
  options: readonly EquipmentCatalogEntry[];
  busy: boolean;
  onPick: (entry: EquipmentCatalogEntry | null) => void;
  onAdd: (name: string) => void;
  onRemove: (entry: EquipmentCatalogEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  // null means "not being typed in", so the box shows the selection.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.id === value) ?? null;
  const selectedLabel = selected?.name ?? valueName ?? "";

  const typed = (query ?? "").trim();
  const matches = useMemo(() => {
    const q = typed.toLowerCase();
    if (!q) return options.slice();
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, typed]);

  // Offered only when nothing on the list already carries that exact name.
  // Without the check, a foreman who types a machine that IS on the list gets
  // "Add 620 skidder" under the 620 skidder it duplicates.
  const canAdd =
    typed.length > 0 &&
    !options.some((o) => o.name.trim().toLowerCase() === typed.toLowerCase());

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

  function choose(entry: EquipmentCatalogEntry | null) {
    onPick(entry);
    setOpen(false);
    setQuery(null);
  }

  function add() {
    onAdd(typed);
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
      const count = matches.length + (canAdd ? 1 : 0);
      if (count === 0) return;
      setActive((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        return (next + count) % count;
      });
      return;
    }
    if (e.key === "Enter") {
      // Inside a form, so a bare Enter would submit the whole report.
      e.preventDefault();
      if (!open) return;
      if (active < matches.length) choose(matches[active]);
      else if (canAdd) add();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQuery(null);
    }
  }

  return (
    <div ref={boxRef} className="relative min-w-0">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="equipment-combobox-list"
        autoComplete="off"
        disabled={busy}
        value={query ?? selectedLabel}
        placeholder="Select equipment"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
      />

      {open && (
        <div
          id="equipment-combobox-list"
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-background shadow-lg"
        >
          {matches.length === 0 && !canAdd && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              Nothing on your crew&apos;s list matches that.
            </p>
          )}

          {/* Clearing the row is its own line rather than a blank first entry,
              which in a native select was indistinguishable from the list not
              having loaded. */}
          {value && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                choose(null);
              }}
              className="block w-full border-b px-2 py-1.5 text-left text-xs text-muted-foreground"
            >
              Clear this row
            </button>
          )}

          {matches.map((o, i) => (
            // A row, not a button: the X is a second control and a button
            // cannot legally contain another one.
            <div
              key={o.id}
              className={cn(
                "flex items-center gap-1",
                i === active ? "bg-accent" : "",
              )}
            >
              <button
                type="button"
                role="option"
                aria-selected={o.id === value}
                // Down rather than click, so the choice registers before the
                // input's blur can close the list out from under it.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActive(i)}
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
              >
                {o.name}
                {o.rentalCompany && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {o.rentalCompany}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={`Remove ${o.name} from the list`}
                title="Remove from the list"
                onMouseDown={(e) => {
                  // Stops the row's own mousedown from selecting the machine
                  // on the way to removing it.
                  e.preventDefault();
                  e.stopPropagation();
                  onRemove(o);
                }}
                className="mr-1 shrink-0 rounded px-2 py-1 text-sm leading-none text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
              >
                &times;
              </button>
            </div>
          ))}

          {canAdd && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                add();
              }}
              onMouseEnter={() => setActive(matches.length)}
              className={cn(
                "block w-full border-t px-2 py-1.5 text-left text-xs",
                active === matches.length ? "bg-accent" : "",
              )}
            >
              + Add &quot;{typed}&quot; to your crew&apos;s list
            </button>
          )}
        </div>
      )}
    </div>
  );
}
