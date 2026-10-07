// The cut-offs the next-bill panel offers.
//
// Zarina, checking Pyramid's AFP 3 against the field record: "can you add
// function to select period of august, period of september, so I will know if
// AFP3 matches to that cut off."
//
// Month ends, not free dates. That is how a bill is cut, and an arbitrary date
// invites comparing the field record against a cut-off no bill will ever use.
// Six months back is enough to reach any bill still in dispute without turning
// the list into a scroll.

export type Cutoff = { value: string; label: string };

/** Last day of the month `back` months before the one containing `todayIso`. */
function monthEndBefore(todayIso: string, back: number): Date {
  const [y, m] = todayIso.split("-").map(Number);
  // Day 0 of a month is the last day of the one before it, so this lands on
  // the end of the month `back` steps back without any length arithmetic.
  return new Date(Date.UTC(y, m - back, 0));
}

export function cutoffOptions(todayIso: string, months = 6): Cutoff[] {
  const out: Cutoff[] = [{ value: todayIso, label: "Today" }];
  for (let back = 1; back <= months; back++) {
    const end = monthEndBefore(todayIso, back);
    const iso = end.toISOString().slice(0, 10);
    // A month end on or after today is not a past cut-off. Only reachable on
    // the last day of a month, where "Today" already covers it.
    if (iso >= todayIso) continue;
    out.push({
      value: iso,
      label: `Through ${end.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })}`,
    });
  }
  return out;
}

/** The cut-off to use, given what arrived in the query string. */
export function resolveCutoff(
  requested: string | undefined,
  todayIso: string,
  options: readonly Cutoff[],
): string {
  if (!requested) return todayIso;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return todayIso;
  if (requested > todayIso) return todayIso;
  // Only an offered cut-off, so a hand-typed date cannot produce a figure
  // nobody can reproduce from the picker.
  return options.some((o) => o.value === requested) ? requested : todayIso;
}
