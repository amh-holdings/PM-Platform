"use client";

import { useState } from "react";

/**
 * Wraps the sheet so the "we typed this" colouring can be switched off.
 *
 * The toggle exists because the preview does two jobs. Checking the report
 * before it goes out, you want to see which lines are ours; proof-reading how
 * it will land on the owner's desk, the colour is noise. Both are one click
 * apart, and neither changes what prints - the colour rule is inside
 * `@media screen` in globals.css.
 */
export function ProvenanceShell({
  manualCount,
  children,
}: {
  manualCount: number;
  children: React.ReactNode;
}) {
  const [on, setOn] = useState(true);

  return (
    <div className={on ? "wr-provenance" : undefined}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 border border-neutral-300 bg-neutral-50 px-2 py-1 text-[11px] print:hidden">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => setOn(e.target.checked)}
            className="h-3 w-3"
          />
          <span>Show what we filled in</span>
        </label>
        <span className="text-neutral-600">
          {on ? (
            <>
              <span className="font-medium text-[#b91c1c]">Red</span> is typed by
              us - {manualCount} {manualCount === 1 ? "entry" : "entries"}.
              Everything in black the platform derived from the field record.
            </>
          ) : (
            <>Colouring off. The sheet reads as it will be received.</>
          )}
        </span>
        <span className="ml-auto text-neutral-500">Prints black either way.</span>
      </div>
      {children}
    </div>
  );
}

/** Marks a value a person typed. Inert unless the shell has colouring on. */
export function M({
  on,
  children,
}: {
  on: boolean;
  children: React.ReactNode;
}) {
  return on ? <span className="wr-manual">{children}</span> : <>{children}</>;
}
