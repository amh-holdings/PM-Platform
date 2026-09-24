/**
 * Grouping the forecast's own list of what it could not account for.
 *
 * The list is the honest part of the cash flow: every entry is money sitting
 * outside the curve. It was rendered as the first ten of sixty-one, with
 * nothing saying the other fifty-one existed - a list you cannot finish and
 * cannot even see the end of, which is the same as no list at all.
 *
 * Grouped, it stops being a wall. Sixty-one entries are usually a handful of
 * causes repeated, and the count per cause is the thing worth reading: eight
 * purchase orders with no payment milestones is one afternoon's work and a
 * different problem from eight unmapped SOV lines.
 *
 * Order is by how much damage the cause does, not alphabetically. A PO with
 * no milestones contributes nothing to the forecast at all, because the
 * projection deliberately skips a cost code tied to a PO on the assumption
 * its milestones will supply that cost - so with no milestones the cost
 * appears in neither place.
 */

import type { ProjectionWarning } from "@/lib/projection";

export type WarningGroup = {
  kind: ProjectionWarning["kind"] | "other";
  title: string;
  /** What this group costs the forecast, in one line. */
  effect: string;
  items: ProjectionWarning[];
};

const GROUPS: {
  kind: ProjectionWarning["kind"];
  title: string;
  effect: string;
}[] = [
  {
    kind: "po_missing_milestones",
    title: "Purchase orders with no payment milestones",
    effect:
      "Their cost is in the forecast nowhere at all - a cost code tied to a PO is skipped on the assumption the PO supplies it.",
  },
  {
    kind: "task_no_dates",
    title: "Linked to work with no planned finish date",
    effect: "Mapped, but there is no date to place the money on.",
  },
  {
    kind: "billing_line_no_link",
    title: "SOV lines not mapped to the schedule",
    effect: "No mapping means no month, so the line sits out of the forecast.",
  },
  {
    kind: "pipeline_change_order",
    title: "Change orders assumed billed, not yet approved",
    effect:
      "In the forecast on an assumption about approval, not on an approval. If the owner says no, the month loses it.",
  },
  { kind: "underbilled", title: "Billed less than earned", effect: "Revenue is later than the work." },
  { kind: "overbilled", title: "Billed more than earned", effect: "Revenue is ahead of the work." },
];

/** Groups warnings by cause, most damaging first. Empty groups are dropped. */
export function groupWarnings(
  warnings: readonly ProjectionWarning[],
): WarningGroup[] {
  const out: WarningGroup[] = [];
  const seen = new Set<string>();

  for (const g of GROUPS) {
    const items = warnings.filter((w) => w.kind === g.kind);
    if (items.length === 0) continue;
    items.forEach((w) => seen.add(w.ref + "\u0000" + w.message));
    out.push({ kind: g.kind, title: g.title, effect: g.effect, items });
  }

  // A kind added to the projection and not to this list must still appear.
  // Silently dropping it would be the exact failure this module exists to fix.
  const rest = warnings.filter((w) => !seen.has(w.ref + "\u0000" + w.message));
  if (rest.length > 0) {
    out.push({
      kind: "other",
      title: "Other",
      effect: "",
      items: rest,
    });
  }
  return out;
}
