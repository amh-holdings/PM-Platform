// Routing the dependency arrows.
//
// The schedule carries its logic as text - `5.1.1.2SS+3` in a cell - and until
// now that was the only place you could see it. The August civil review found
// thirteen tasks scheduled to start before their own predecessor allowed, one
// backwards link and one missing permit gate, and every one of them was found
// by reading predecessor strings by hand. Nothing about that work needed
// judgement to detect. It needed the links to be visible.
//
// Pure geometry, no React, so the routing can be tested rather than eyeballed.
// The component supplies pixel coordinates; this decides the corners.

import type { RelType } from "@/lib/schedule-cpm";

export type Point = { x: number; y: number };

/** A bar, as far as routing is concerned: its two ends and its centre line. */
export type BarBox = {
  /** Left edge - the task's start. */
  x1: number;
  /** Right edge - the task's finish. */
  x2: number;
  /** Vertical centre of the bar. */
  y: number;
};

/**
 * Which end of each bar a relationship connects.
 *
 * The definitions are the ones the CPM engine already uses, and getting them
 * the wrong way round draws a picture that contradicts the arithmetic:
 *
 *   FS  predecessor FINISH  ->  successor START
 *   SS  predecessor START   ->  successor START
 *   FF  predecessor FINISH  ->  successor FINISH
 *   SF  predecessor START   ->  successor FINISH
 */
export function endpointsFor(type: RelType): { from: "start" | "finish"; to: "start" | "finish" } {
  switch (type) {
    case "FS": return { from: "finish", to: "start" };
    case "SS": return { from: "start", to: "start" };
    case "FF": return { from: "finish", to: "finish" };
    case "SF": return { from: "start", to: "finish" };
  }
}

const STUB = 8;

/**
 * Corner points for one dependency arrow, predecessor to successor.
 *
 * Orthogonal routing, the way every scheduling tool draws it: a horizontal
 * stub off the source, a vertical run to the target's row, a horizontal
 * approach into the target. The arrowhead belongs on the last segment, which
 * is always horizontal, so it can point along the line rather than at an angle.
 *
 * The interesting case is a link that goes backwards on screen - a successor
 * that starts before its predecessor finishes, which is exactly the overlap the
 * civil review was full of. A direct route would run the line straight through
 * both bars. So when there is no room in front, the arrow detours through the
 * gap between the two rows instead, and the detour is what makes the overlap
 * legible: you can see the line doubling back.
 */
export function linkPoints(
  from: BarBox,
  to: BarBox,
  type: RelType,
  rowGap = 15,
): Point[] {
  const ends = endpointsFor(type);
  const sx = ends.from === "finish" ? from.x2 : from.x1;
  const tx = ends.to === "finish" ? to.x2 : to.x1;

  // The direction the arrow has to be travelling when it arrives. Into a start
  // edge it comes from the left; into a finish edge, from the right.
  const approachFromLeft = ends.to === "start";
  // The direction it leaves. Off a finish edge it goes right; off a start
  // edge, left.
  const leaveRight = ends.from === "finish";

  const leaveX = sx + (leaveRight ? STUB : -STUB);
  const arriveX = tx + (approachFromLeft ? -STUB : STUB);

  // Straight through: the stub off the source already points at the target and
  // there is room to turn once.
  const roomAhead = approachFromLeft
    ? arriveX >= leaveX
    : arriveX <= leaveX;

  if (roomAhead) {
    // Three corners: out, across, in. When the two are on the same row this
    // collapses to a straight horizontal line, which is correct.
    const midX = approachFromLeft
      ? Math.max(leaveX, arriveX)
      : Math.min(leaveX, arriveX);
    if (from.y === to.y) {
      return [{ x: sx, y: from.y }, { x: tx, y: to.y }];
    }
    return [
      { x: sx, y: from.y },
      { x: midX, y: from.y },
      { x: midX, y: to.y },
      { x: tx, y: to.y },
    ];
  }

  // No room. Detour through the channel between the rows so the line does not
  // cross either bar. Going up, the channel sits above the target row.
  const midY = to.y > from.y ? from.y + rowGap : from.y - rowGap;
  return [
    { x: sx, y: from.y },
    { x: leaveX, y: from.y },
    { x: leaveX, y: midY },
    { x: arriveX, y: midY },
    { x: arriveX, y: to.y },
    { x: tx, y: to.y },
  ];
}

/** Corner points as an SVG path. */
export function toPath(points: Point[]): string {
  if (points.length < 2) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${Math.round(p.x)} ${Math.round(p.y)}`)
    .join(" ");
}

/**
 * Which way the arrowhead points, from the last segment.
 *
 * Returned as a unit direction rather than an angle so the caller can build
 * the triangle without trigonometry, and so a zero-length final segment - two
 * tasks on the same row and the same date - degrades to pointing right rather
 * than to NaN.
 */
export function headDirection(points: Point[]): 1 | -1 {
  if (points.length < 2) return 1;
  const a = points[points.length - 2];
  const b = points[points.length - 1];
  return b.x >= a.x ? 1 : -1;
}
