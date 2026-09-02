"use client";

import { useLayoutEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import { diffWords } from "@/lib/weekly-report";

/**
 * A textarea whose text really is red where we changed it.
 *
 * A <textarea> renders one colour and nothing can change that. So the text is
 * painted on a layer BEHIND the textarea, and the textarea itself is made
 * transparent - keeping its caret, selection, undo history, spellcheck and
 * mobile keyboard, all of which a contenteditable would have made us
 * reimplement badly.
 *
 * The illusion holds only while the two boxes wrap identically, so every
 * property that affects layout is set on both from the same string, and the
 * backdrop is scrolled in step with the textarea. Get that wrong and the text
 * appears doubled and offset, which is why the shared metrics live in one
 * constant rather than being typed out twice.
 */
const SHARED =
  "w-full rounded-md border p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words";

export function HighlightedTextarea({
  value,
  derived,
  onChange,
  rows,
  disabled,
  className,
}: {
  value: string;
  /** What the platform generated. Words not in it are ours, and go red. */
  derived: string;
  onChange: (v: string) => void;
  rows: number;
  disabled?: boolean;
  className?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLDivElement>(null);

  const sync = () => {
    const ta = taRef.current;
    const back = backRef.current;
    if (!ta || !back) return;
    back.scrollTop = ta.scrollTop;
    back.scrollLeft = ta.scrollLeft;
  };

  // A value set from outside - Reset to derived, or the first render - moves
  // the textarea's scroll without firing onScroll.
  useLayoutEffect(sync, [value]);

  const segments = diffWords(derived, value);

  return (
    <div className={cn("relative", className)}>
      <div
        ref={backRef}
        aria-hidden
        className={cn(
          SHARED,
          "pointer-events-none absolute inset-0 overflow-hidden border-transparent text-foreground",
        )}
      >
        {segments.map((seg, i) =>
          seg.added ? (
            <span key={i} className="text-[#b91c1c] dark:text-[#f87171]">
              {seg.text}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
        {/* A trailing newline has no line box of its own, so the caret sitting
            on the empty last line would scroll past the painted text. */}
        {"\n"}
      </div>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={sync}
        rows={rows}
        disabled={disabled}
        spellCheck
        className={cn(
          SHARED,
          // `block` matters: an inline-block textarea leaves a baseline gap
          // under it, so the wrapper ended up 6px taller than the box and the
          // backdrop stretched to fill it.
          "relative block bg-transparent text-transparent caret-foreground",
          // Selection has to stay visible: with transparent text the browser
          // paints the highlight band and nothing else, which still reads as a
          // selection because the backdrop shows through it.
          "selection:bg-sky-300/40",
        )}
      />
    </div>
  );
}
