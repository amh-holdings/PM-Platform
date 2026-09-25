"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { insertPositionsFor, planInsertAt } from "@/lib/schedule-insert";
import type { EditTask } from "@/lib/schedule-edit";

import { TaskEditDialog } from "./task-edit-dialog";

// Add a row exactly here.
//
// Zarina: "I need to add a row in the schedule wherever I want. Not add it at
// the bottom and just drag to where I want it."
//
// Three choices per row, and the code the new task will take is worked out
// before the dialog opens so it is on screen next to the choice. Nothing
// existing is renumbered to make room - see schedule-insert for why.
//
// It lives in the row's left gutter, beside the drag handle and the tick box,
// and appears on hover. It shipped once at the right-hand end of the row next
// to Open, which on a grid this wide is past the horizontal scroll: "I do not
// see that function." A control nobody scrolls to is a control nobody has.

type Props = {
  projectId: string;
  anchorWbs: string;
  editTasks: EditTask[];
  phaseOptions: string[];
  statusOptions: string[];
  allTasks: React.ComponentProps<typeof TaskEditDialog>["allTasks"];
  phase1Available: boolean;
  typeAvailable: boolean;
  calendar: React.ComponentProps<typeof TaskEditDialog>["calendar"];
  rowIndex?: React.ComponentProps<typeof TaskEditDialog>["rowIndex"];
  /** Which way the menu opens. In the left gutter it opens rightwards. */
  align?: "left" | "right";
  /** Applied to the wrapper, for the hover reveal. */
  className?: string;
  onDone?: () => void;
};

export function InsertRowMenu({
  projectId,
  anchorWbs,
  editTasks,
  phaseOptions,
  statusOptions,
  allTasks,
  phase1Available,
  typeAvailable,
  calendar,
  rowIndex,
  align = "right",
  className,
  onDone,
}: Props) {
  const [open, setOpen] = useState(false);

  const options = insertPositionsFor(editTasks, anchorWbs);

  return (
    <span
      className={cn(
        "relative inline-block",
        className,
        // An open menu stays put when the pointer leaves the row, or picking
        // the second item would mean chasing it.
        open && "opacity-100",
      )}
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1 text-[13px] leading-none"
        title={`Add a row above, below or inside ${anchorWbs}`}
        aria-label={`Insert a row at ${anchorWbs}`}
        onClick={() => setOpen((v) => !v)}
      >
        +
      </Button>

      {open && (
        <>
          {/* Click anywhere else to close. Behind the menu, above the grid. */}
          <span
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <span
            className={cn(
              "absolute top-6 z-50 block w-64 rounded-md border bg-popover p-1 shadow-lg",
              align === "left" ? "left-0" : "right-0",
            )}
          >
            {options.map((o) => {
              const plan = planInsertAt({
                tasks: editTasks,
                anchorWbs,
                position: o.position,
              });
              return (
                <TaskEditDialog
                  key={o.position}
                  projectId={projectId}
                  mode="create"
                  suggestedWbs={plan.ok ? plan.wbs : undefined}
                  insertAt={{
                    anchorWbs,
                    position: o.position,
                    note: plan.ok ? plan.note : undefined,
                  }}
                  phaseOptions={phaseOptions}
                  statusOptions={statusOptions}
                  allTasks={allTasks}
                  phase1Available={phase1Available}
                  typeAvailable={typeAvailable}
                  calendar={calendar}
                  rowIndex={rowIndex}
                  onDone={() => {
                    setOpen(false);
                    onDone?.();
                  }}
                  trigger={
                    <button
                      type="button"
                      disabled={!o.enabled || !plan.ok}
                      className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50"
                    >
                      <span className="font-medium">{o.label}</span>
                      {plan.ok && (
                        <span className="block text-[10px] text-muted-foreground">
                          as {plan.wbs}
                        </span>
                      )}
                    </button>
                  }
                />
              );
            })}
          </span>
        </>
      )}
    </span>
  );
}
