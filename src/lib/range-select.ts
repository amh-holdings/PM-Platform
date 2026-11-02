// Tick-box selection with shift-click, over any ordered list of ids.
//
// Lifted out of the schedule print chooser when the documents page needed the
// same behaviour. One subtle rule lives here rather than twice:
//
// A shift-click applies the state the click PRODUCES across the whole run,
// rather than toggling each row independently. Toggling per row is the obvious
// implementation and the wrong one - on a mixed run it inverts the pattern
// instead of flattening it, so a second shift-click does not undo the first
// and the person ends up worse off than before they tried.

/**
 * `selected` of null means "everything is on", which is how a list that starts
 * fully ticked distinguishes "nothing has been unticked yet" from "every box
 * was cleared". A caller whose list starts empty passes a real Set and never
 * sees that case.
 */
export function rangeSelect(
  ids: readonly string[],
  selected: ReadonlySet<string> | null,
  anchor: string | null,
  clicked: string,
  shift: boolean,
): Set<string> {
  const next = new Set(selected ?? ids);
  const target = !next.has(clicked);

  const from = anchor == null ? -1 : ids.indexOf(anchor);
  const to = ids.indexOf(clicked);

  // No shift, no anchor, an anchor that is no longer in the list, or a click
  // on the anchor itself: an ordinary one-row toggle.
  if (!shift || from < 0 || to < 0 || from === to) {
    if (to < 0) return next;
    if (target) next.add(clicked);
    else next.delete(clicked);
    return next;
  }

  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = lo; i <= hi; i++) {
    if (target) next.add(ids[i]);
    else next.delete(ids[i]);
  }
  return next;
}
