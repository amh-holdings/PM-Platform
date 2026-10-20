// Stepping from one pay application to the next without going back to the list.
//
// Zarina: "Can you make the pay apps move to next button? Like an arrow for
// right and left so we can view the next AFP or the previous AFP in this
// page."
//
// Checking an AFP means comparing it with the one before it - previous
// billings on this one are to-date on that one - and that comparison was two
// clicks and a scan of the list each way.
//
// ORDER IS CHRONOLOGICAL, NOT BY NUMBER. app_number is free text: Sweet
// Springs carries "AFP 12" and Sussex carries "AFP 1", and a backfilled one
// may carry just "14". Sorting that as a string puts AFP 10 before AFP 2.
// period_end is the fact the applications actually run on, so left is the
// earlier period and right is the later one, which is also how the list above
// them reads.

export type NavPayApp = {
  id: string;
  app_number: string | null;
  period_end: string | null;
  created_at?: string | null;
};

/**
 * Oldest first.
 *
 * A null period_end sorts first rather than last: an application with no
 * period is almost always an early draft somebody started and left, and
 * burying it at the end puts it after the newest real one.
 */
export function comparePayApps(a: NavPayApp, b: NavPayApp): number {
  const ae = a.period_end ?? "";
  const be = b.period_end ?? "";
  if (ae !== be) return ae < be ? -1 : 1;
  const ac = a.created_at ?? "";
  const bc = b.created_at ?? "";
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id.localeCompare(b.id);
}

export type PayAppNeighbours<T extends NavPayApp> = {
  /** The earlier application, or null at the start. */
  prev: T | null;
  /** The later application, or null at the end. */
  next: T | null;
  /** 1-based position, or 0 when the current application is not in the list. */
  position: number;
  total: number;
};

/**
 * What sits either side of the application being looked at.
 *
 * An id that is not in the list returns no neighbours and position 0 rather
 * than throwing or guessing at an index. That happens the moment somebody
 * follows a link to an application that has since been deleted, and the page
 * should still render the one it has.
 */
export function payAppNeighbours<T extends NavPayApp>(
  apps: readonly T[],
  currentId: string,
): PayAppNeighbours<T> {
  const sorted = [...apps].sort(comparePayApps);
  const i = sorted.findIndex((a) => a.id === currentId);
  if (i < 0) return { prev: null, next: null, position: 0, total: sorted.length };
  return {
    prev: i > 0 ? sorted[i - 1] : null,
    next: i < sorted.length - 1 ? sorted[i + 1] : null,
    position: i + 1,
    total: sorted.length,
  };
}

/** "AFP 12", or a fallback so an unnumbered draft still has something to click. */
export function payAppLabel(app: NavPayApp | null): string {
  if (!app) return "";
  const n = (app.app_number ?? "").trim();
  return n || "Untitled";
}
