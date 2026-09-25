"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { RowIndex } from "@/lib/schedule-edit";
import {
  SUMMARY_REL_TYPES,
  findCycleWith,
  leafCodesUnder,
  parsePredecessors,
  serializeLinks,
  summaryCodesOf,
  type Link,
  type RelType,
} from "@/lib/schedule-cpm";
import { nearestNamedAncestor } from "@/lib/schedule-task-search";

import { TaskCombobox } from "./task-combobox";

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
  /**
   * Row numbers as the grid shows them. The dialog names a task the same way
   * the Predecessors column does, so the two surfaces cannot disagree about
   * what "12" means. Absent, it falls back to WBS codes.
   */
  rowIndex?: RowIndex;
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
  rowIndex,
}: Props) {
  const [links, setLinks] = useState<Link[]>(() => parsePredecessors(defaultValue));

  // "12 - Pile driving" rather than "5.1.1.2 - Pile driving". The code is still
  // what gets stored and still what the hint line at the bottom shows.
  const label = (wbs: string) => {
    const n = rowIndex?.byWbs.get(wbs);
    return n === undefined ? wbs : String(n);
  };

  const nameByWbs = useMemo(
    () => new Map(allTasks.map((t) => [t.wbs_code, t.task_name])),
    [allTasks],
  );

  // Which codes are branches rather than work.
  //
  // Summary rows used to be left out entirely, on the reasoning that they have
  // no dates of their own. The consequence was that a row disappeared from
  // this picker the moment somebody added a child under it, which is what
  // "we can't add predecessors that are just recently added" was.
  //
  // A branch is now offered and means "everything under it". The engine
  // expands it to the leaves underneath, so finish-to-start against 4.4.7 is
  // after every task in 4.4.7 has finished.
  const summaries = useMemo(() => summaryCodesOf(allTasks), [allTasks]);

  const leafCountUnder = (wbs: string) => leafCodesUnder(wbs, allTasks).length;

  // A branch containing this task cannot precede it - the task would be
  // waiting on itself. Excluded here rather than left to the loop check, which
  // would report it as a circular dependency through a list of siblings.
  const isAncestorOfCurrent = (wbs: string) =>
    !!currentWbs && currentWbs.startsWith(wbs + ".");

  const options = useMemo(() => {
    return allTasks
      .filter((t) => t.wbs_code !== currentWbs && !isAncestorOfCurrent(t.wbs_code))
      .sort((a, b) => sortWbs(a.wbs_code, b.wbs_code));
    // isAncestorOfCurrent closes over currentWbs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const selfRef = useMemo(
    () => links.some((l) => l.pred === currentWbs),
    [links, currentWbs],
  );

  const cycle = useMemo(() => {
    const valid = links.filter((l) => l.pred && nameByWbs.has(l.pred));
    if (!valid.length) return null;
    return findCycleWith(allTasks, currentWbs, valid);
  }, [links, allTasks, currentWbs, nameByWbs]);

  const serialized = serializeLinks(links.filter((l) => l.pred)) ?? "";

  function update(i: number, patch: Partial<Link>) {
    setLinks((prev) =>
      prev.map((l, idx) => {
        if (idx !== i) return l;
        const next = { ...l, ...patch };
        // Switching to a branch while holding SS or SF would leave a
        // relationship the engine will not expand. Fall back to the one that
        // means what picking a branch means.
        if (summaries.has(next.pred) && !SUMMARY_REL_TYPES.includes(next.type)) {
          next.type = "FS";
        }
        return next;
      }),
    );
  }

  // Starts empty. It used to pre-select whatever leaf happened to be first,
  // which saved a real link to an unrelated task any time somebody added a row
  // and then got distracted. Now the box is blank and waiting to be typed in.
  function add() {
    setLinks((prev) => [...prev, { pred: "", type: "FS", lag: 0 }]);
  }

  const blanks = links.filter((l) => !l.pred).length;

  // Branch predecessors, named, so what the link actually means is on screen
  // rather than something you have to know.
  const branchLinks = links
    .filter((l) => l.pred && summaries.has(l.pred))
    .map((l) => ({
      label: `${label(l.pred)} ${nameByWbs.get(l.pred) ?? l.pred}`.trim(),
      count: leafCountUnder(l.pred),
    }));

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
              <TaskCombobox
                value={l.pred}
                options={options.filter(
                  (o) => o.wbs_code === l.pred || !chosen.has(o.wbs_code),
                )}
                onChange={(wbs) => update(i, { pred: wbs })}
                rowOf={(wbs) => rowIndex?.byWbs.get(wbs) ?? null}
                branchSizeOf={(wbs) =>
                  summaries.has(wbs) ? leafCountUnder(wbs) : 0
                }
                parentNameOf={(wbs) =>
                  nearestNamedAncestor(wbs, nameByWbs)?.name ?? null
                }
                invalid={!!l.pred && !nameByWbs.has(l.pred)}
              />

              <select
                value={l.type}
                onChange={(e) => update(i, { type: e.target.value as RelType })}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                title={REL_HINT[l.type]}
              >
                {/* Against a branch, start-to-start and start-to-finish mean
                    its EARLIEST start, and the engine expands a branch by
                    taking the latest of its tasks. Offering them would
                    schedule the opposite of what was asked, so they are not
                    offered. */}
                {(Object.keys(REL_LABEL) as RelType[])
                  .filter(
                    (r) => !summaries.has(l.pred) || SUMMARY_REL_TYPES.includes(r),
                  )
                  .map((r) => (
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

      {branchLinks.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {branchLinks
            .map(
              (b) =>
                `${b.label} is a branch, so this waits for all ${b.count} task${b.count === 1 ? "" : "s"} under it.`,
            )
            .join(" ")}
        </p>
      )}

      {blanks > 0 && (
        <p className="text-xs text-amber-700">
          {blanks === 1 ? "One row has" : `${blanks} rows have`} no task picked
          yet. Start typing a row number, a WBS code or part of the task name.
          Blank rows are not saved.
        </p>
      )}

      {missing.length > 0 && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {missing.join(", ")} {missing.length === 1 ? "does" : "do"} not exist on
          this project. The engine skips references it cannot resolve, so this
          task would run with no constraint at all.
        </p>
      )}

      {selfRef && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {currentWbs} is listed as its own predecessor. A task cannot wait on
          itself.
        </p>
      )}

      {cycle && !selfRef && (
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
                <li key={s.wbs_code} className="text-xs" title={s.wbs_code}>
                  <span className="font-mono text-muted-foreground">{label(s.wbs_code)}</span>{" "}
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
  // Called out before the loop check, which would otherwise report a task
  // depending on itself as a "circular dependency through 2.1" - technically a
  // loop, and useless for working out what to do about it.
  if (links.some((l) => l.pred === currentWbs)) {
    return `${currentWbs} is listed as its own predecessor. A task cannot wait on itself.`;
  }
  // A branch that contains this task is the same mistake one level up. Caught
  // here so it reads as what it is rather than as a loop through whichever
  // sibling the sort happened to reach first.
  const ownBranch = links.find(
    (l) => l.pred && currentWbs.startsWith(l.pred + "."),
  );
  if (ownBranch) {
    return `${ownBranch.pred} is the branch ${currentWbs} sits in, so it cannot come before it. Link to the tasks in another branch instead.`;
  }
  const missing = links.filter((l) => !known.has(l.pred)).map((l) => l.pred);
  if (missing.length) return `Unknown task: ${missing.join(", ")}`;
  const cycle = findCycleWith(allTasks, currentWbs, links);
  if (cycle) return `Circular dependency through ${cycle.join(", ")}`;
  return null;
}
