"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import { PALETTE_EVENT } from "./command-palette";

/** Opens the command palette for people who are not going to learn Cmd-K. */
export function PaletteTrigger() {
  const [mac, setMac] = useState(false);

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(PALETTE_EVENT))}
      className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Search className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden sm:inline">Search</span>
      <kbd className="hidden rounded border px-1 py-0.5 text-[10px] md:inline">
        {mac ? "⌘" : "Ctrl "}K
      </kbd>
    </button>
  );
}
