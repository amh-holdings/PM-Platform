"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  findCycleWith,
  parsePredecessors,
  serializeLinks,
  type Link,
  type RelType,
} from "@/lib/schedule-cpm";

export type LinkTask = {
  wbs_code: string;
  task_name: string;
  predecessors: string | null;
  start_date?: string | null;
  end_date?: string | null;
};

type Props = {
  name: string;
  currentWbs: string;
  allTasks: LinkTask[];
  defaultValue: string | null;
};

const REL_LABEL: Record<RelType, string> = {
  FS: "Finish → Start",
  SS: "Start → Start",
  FF: "Finish → Finish",
  SF: "Start → Finish",
};

const REL_HINT: Record<RelType, string> = {
  FS: "waits for it to finish",
  SS: "starts alongside it",
  FF: "finishes alongside it",
  SF: "finishes when it starts",
};

function sortWbs(a: string, b: string): number {
  const A = a.split(".").map(Number);
  const B = b.split(".").map(Number);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? -1, y = B[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

export function PredecessorEditor({
  name,
  currentWbs,
  allTasks,
  defaultValue,
}: Props) {
  const [links, setLinks] = useState<Link[]>(() => parsePredecessors(defaultValue));

  const nameByWbs = useMemo(
    () => new Map(allTasks.map((t) => [t.wbs_code, t.task_name])),
    [allTasks],
  );

  // Summary rows have no dates of their own, so linking to one does nothing.
  // Only leaves are offered, minus this task and anything already chosen.
  const options = useMemo(() => {
    const isLeaf = (w: string) =>
      !allTasks.some((o) => o.wbs_code !== w && o.wbs_code.startsWith(w + "."));
    return allTasks
      .filter((t) => t.wbs_code !== currentWbs && isLeaf(t.wbs_code))
      .sort((a, b) => sortWbs(a.wbs_code, b.wbs_code));
  }, [allTasks, currentWbs]);

  const chosen = useMemo(() => new Set(links.map((l) => l.pred)), [links]);

  // Anything that already depends on this task. Derived, never entered - you
  // record a relationship once, looking backward.
  const successors = useMemo(
    () =>
      allTasks
        .filter((t) =>
          parsePredecessors(t.predecessors).some((l) => l.pred === currentWbs),
        )
        .sort((a, b) => sortWbs(a.wbs_code, b.wbs_code)),
    [allTasks, currentWbs],
  );

  const missing = useMemo(
    () => links.filter((l) => l.pred && !nameByWbs.has(l.pred)).map((l) => l.pred),
    [links, nameByWbs],
  );

  const cycle = useMemo(() => {
    const valid = links.filter((l) => l.pred && nameByWbs.has(l.pred));
    if (!valid.length) return null;
    return findCycleWith(allTasks, currentWbs, valid);
  }, [links, allTasks, currentWbs, nameByWbs]);

  const serialized = serializeLinks(links.filter((l) => l.pred)) ?? "";

  function update(i: number, patch: Partial<Link>) {
    setLinks((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function add() {
    const next = options.find((o) => !chosen.has(o.wbs_code));
    setLinks((prev) => [
      ...prev,
      { pred: next?.wbs_code ?? "", type: "FS", lag: 0 },
    ]);
  }

  return (
    <div className="space-y-3 sm:col-span-2">
      <div className="flex items-center justify-between">
        <Label>Predecessors</Label>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          Add predecessor
        </Button>
      </div>

      {/* The value the form actually submits. Everything above is the editor. */}
      <input type="hidden" name={name} value={serialized} />

      {links.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          No predecessors. This task is not tied to anything, so the schedule
          logic will not move it when other work slips.
        </p>
      ) : (
        <div className="space-y-2">
          {links.map((l, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                value={l.pred}
                onChange={(e) => update(i, { pred: e.target.value })}
                className={cn(
                  "h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm",
                  l.pred && !nameByWbs.has(l.pred)
                    ? "border-destructive text-destructive"
                    : "border-input",
                )}
              >
                {l.pred && !nameByWbs.has(l.pred) && (
                  <option value={l.pred}>{l.pred} (not found)</option>
                )}
                {options
                  .filter((o) => o.wbs_code === l.pred || !chosen.has(o.wbs_code))
                  .map((o) => (
                    <option key={o.wbs_code} value={o.wbs_code}>
                      {o.wbs_code} - {o.task_name}
                    </option>
                  ))}
              </select>

              <select
                value={l.type}
                onChange={(e) => update(i, { type: e.target.value as RelType })}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                title={REL_HINT[l.type]}
              >
                {(Object.keys(REL_LABEL) as RelType[]).map((r) => (
                  <option key={r} value={r}>{REL_LABEL[r]}</option>
                ))}
              </select>

              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={l.lag}
                  onChange={(e) => update(i, { lag: Number(e.target.value) || 0 })}
                  className="h-9 w-16 rounded-md border border-input bg-background px-2 text-sm"
                  title="Lag in working days. Negative overlaps the two tasks."
                />
                <span className="text-xs text-muted-foreground">lag</span>
              </div>

              <button
                type="button"
                onClick={() => setLinks((prev) => prev.filter((_, idx) => idx !== i))}
                className="px-1 text-sm text-muted-foreground hover:text-destructive"
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {missing.join(", ")} {missing.length === 1 ? "does" : "do"} not exist on
          this project. The engine skips references it cannot resolve, so this
          task would run with no constraint at all.
        </p>
      )}

      {cycle && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          This creates a circular dependency through {cycle.join(", ")}. Nothing
          on the schedule can be scheduled until the loop is broken.
        </p>
      )}

      {links.length > 0 && !missing.length && !cycle && (
        <p className="text-xs text-muted-foreground">
          Stored as <code className="font-mono">{serialized}</code>
        </p>
      )}

      <div className="rounded-md border bg-muted/30 p-3">
        <div className="text-xs font-medium">
          Successors ({successors.length})
        </div>
        {successors.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Nothing depends on this task. Moving it will not push anything else.
          </p>
        ) : (
          <>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Derived from other tasks. Moving this pushes all of them.
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {successors.map((s) => (
                <li key={s.wbs_code} className="text-xs">
                  <span className="font-mono text-muted-foreground">{s.wbs_code}</span>{" "}
                  {s.task_name}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

export function hasLinkErrors(
  allTasks: LinkTask[],
  currentWbs: string,
  raw: string | null,
): string | null {
  const links = parsePredecessors(raw);
  const known = new Set(allTasks.map((t) => t.wbs_code));
  const missing = links.filter((l) => !known.has(l.pred)).map((l) => l.pred);
  if (missing.length) return `Unknown task: ${missing.join(", ")}`;
  const cycle = findCycleWith(allTasks, currentWbs, links);
  if (cycle) return `Circular dependency through ${cycle.join(", ")}`;
  return null;
}
