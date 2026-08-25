"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";

import { useLinkCatalog, type TaskOption } from "./billing/link-catalog";
import { updateLinkedTasks } from "./billing-actions";

type Props = {
  billingLineId: string;
  projectId: string;
  itemNumber: string;
  description: string;
  initialCodes: string[];
};

/** Chips shown before the "+N more" toggle takes over. */
const COLLAPSED_CHIPS = 3;
const MAX_SUGGESTIONS = 8;

function rank(task: TaskOption, query: string): number {
  const q = query.toLowerCase();
  const code = task.wbsCode.toLowerCase();
  const name = task.taskName.toLowerCase();
  if (code === q) return 0;
  if (code.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (code.includes(q)) return 3;
  if (name.includes(q)) return 4;
  return -1;
}

// Inline editor for the schedule tasks a billing line bills against. Chips are
// live: removing one or picking one from the autocomplete saves immediately,
// because the old textarea made a one-code change a four-step operation and
// offered no way to find out what a code was without opening the schedule.
export function BillingLinkForm({
  billingLineId,
  projectId,
  itemNumber,
  description,
  initialCodes,
}: Props) {
  const router = useRouter();
  const { tasks } = useLinkCatalog();
  const [codes, setCodes] = useState<string[]>(initialCodes);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const taskByCode = useMemo(() => {
    const m = new Map<string, TaskOption>();
    for (const t of tasks) m.set(t.wbsCode, t);
    return m;
  }, [tasks]);

  const linked = useMemo(() => new Set(codes), [codes]);

  const suggestions = useMemo(() => {
    const q = query.trim();
    const pool = tasks.filter((t) => !linked.has(t.wbsCode));
    if (!q) return pool.slice(0, MAX_SUGGESTIONS);
    return pool
      .map((t) => ({ t, r: rank(t, q) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.t.wbsCode.localeCompare(b.t.wbsCode))
      .slice(0, MAX_SUGGESTIONS)
      .map((x) => x.t);
  }, [query, tasks, linked]);

  const save = (next: string[], revertTo: string[]) => {
    setError(null);
    setCodes(next);
    startSaving(async () => {
      const res = await updateLinkedTasks(billingLineId, projectId, next.join(", "));
      if (!res.ok) {
        setCodes(revertTo);
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  const addCode = (raw: string) => {
    const code = raw.trim();
    if (!code || linked.has(code)) return;
    save([...codes, code], codes);
    setQuery("");
    setHighlight(0);
    inputRef.current?.focus();
  };

  const removeCode = (code: string) => {
    save(
      codes.filter((c) => c !== code),
      codes,
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Enter on a highlighted suggestion takes it; otherwise the typed text
      // stands on its own, so a code the schedule does not carry yet can still
      // be linked (it renders amber until the task exists).
      const pick = suggestions[highlight];
      addCode(pick ? pick.wbsCode : query);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setAdding(false);
      setQuery("");
    }
  };

  const shown = expanded ? codes : codes.slice(0, COLLAPSED_CHIPS);
  const overflow = codes.length - shown.length;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {codes.length === 0 && !adding && (
          <span className="text-[10px] italic text-muted-foreground">
            No tasks linked
          </span>
        )}
        {shown.map((code) => {
          const task = taskByCode.get(code);
          return (
            <span
              key={code}
              className={cn(
                "inline-flex max-w-[16rem] items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]",
                !task
                  ? "bg-amber-500/10 text-amber-700"
                  : task.isSummary
                    ? "bg-amber-500/10 text-amber-700"
                    : "bg-sky-500/10 text-sky-700",
              )}
              title={
                task
                  ? [
                      `${task.wbsCode} - ${task.taskName}`,
                      task.status,
                      task.pctComplete === null ? null : `${task.pctComplete}%`,
                      task.isSummary
                        ? "summary row - a rollup percent, not measured work"
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" - ")
                  : `${code} is not in this project's schedule`
              }
            >
              <span className="truncate font-mono">{code}</span>
              {task && (
                <span className="hidden truncate opacity-70 sm:inline">
                  {task.taskName}
                </span>
              )}
              <button
                type="button"
                aria-label={`Unlink ${code}`}
                disabled={saving}
                onClick={() => removeCode(code)}
                className="opacity-60 transition-opacity hover:text-destructive hover:opacity-100 disabled:opacity-40"
              >
                &times;
              </button>
            </span>
          );
        })}
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            +{overflow} more
          </button>
        )}
        {expanded && codes.length > COLLAPSED_CHIPS && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            Show less
          </button>
        )}
        {!adding && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setExpanded(true);
              setHighlight(0);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
            className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            + Add linked task
          </button>
        )}
      </div>

      {adding && (
        <div className="relative w-full max-w-sm">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              // Let a click on a suggestion land before the list unmounts.
              window.setTimeout(() => setAdding(false), 150);
            }}
            placeholder={`Link a task to ${itemNumber} - type a WBS code or name`}
            aria-label={`Link a schedule task to ${itemNumber} ${description}`}
            className={cn(
              "w-full rounded-md border border-input bg-background px-2 py-1 text-[11px] font-mono",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
          />
          {suggestions.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-card shadow-md">
              {suggestions.map((t, i) => (
                <li key={t.wbsCode}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => addCode(t.wbsCode)}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      "flex w-full items-center gap-2 px-2 py-1 text-left text-[11px]",
                      i === highlight ? "bg-muted" : "hover:bg-muted/60",
                    )}
                  >
                    <span className="font-mono text-muted-foreground">
                      {t.wbsCode}
                    </span>
                    <span className="flex-1 truncate">{t.taskName}</span>
                    {t.isSummary && (
                      <span className="text-[9px] uppercase text-muted-foreground">
                        summary
                      </span>
                    )}
                    {t.pctComplete !== null && (
                      <span className="text-[10px] text-muted-foreground">
                        {t.pctComplete}%
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && suggestions.length === 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              No matching task. Press Enter to link {query.trim()} anyway.
            </p>
          )}
        </div>
      )}

      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}
