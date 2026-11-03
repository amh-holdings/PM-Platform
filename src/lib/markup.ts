/**
 * Markup geometry and drawing, kept out of the component so it can be tested.
 *
 * Everything here works in BASE PIXELS - the natural size of the rendered
 * sheet, not the size it happens to be displayed at. A markup drawn on a
 * laptop and one drawn on a phone land in the same place on the saved PNG,
 * and flattening is then just "draw the same shapes onto the same canvas".
 */

export type Tool = "pen" | "rect" | "arrow" | "text";

export type Shape =
  | { kind: "pen"; color: string; width: number; points: Array<[number, number]> }
  | { kind: "rect"; color: string; width: number; x0: number; y0: number; x1: number; y1: number }
  | { kind: "arrow"; color: string; width: number; x0: number; y0: number; x1: number; y1: number }
  | { kind: "text"; color: string; size: number; x: number; y: number; text: string };

export const MARKUP_COLORS = [
  { value: "#dc2626", label: "Red" },
  { value: "#2563eb", label: "Blue" },
  { value: "#16a34a", label: "Green" },
  { value: "#ca8a04", label: "Yellow" },
] as const;

/** Rendering a 42-inch sheet at full resolution is how a browser tab dies. */
export const MAX_RENDER_PX = 2400;

/**
 * The scale to hand pdf.js so the long edge lands near MAX_RENDER_PX.
 *
 * Never upscales past 3x: a small sheet rendered at 12x is a huge canvas
 * holding no more detail than the PDF had.
 */
export function renderScale(widthPt: number, heightPt: number, maxPx = MAX_RENDER_PX): number {
  const longest = Math.max(widthPt, heightPt);
  if (!Number.isFinite(longest) || longest <= 0) return 1;
  return Math.min(3, Math.max(0.5, maxPx / longest));
}

/**
 * A click on the displayed canvas, in base pixels.
 *
 * The canvas is shown at whatever width the panel is, so client coordinates
 * and canvas coordinates are different units. Getting this wrong puts every
 * mark a thumb's width from where it was drawn, which is worse than no
 * markup at all on a sheet where the question is "this pile, not that one".
 */
export function canvasPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const x = ((clientX - rect.left) / rect.width) * canvasWidth;
  const y = ((clientY - rect.top) / rect.height) * canvasHeight;
  return {
    x: Math.min(canvasWidth, Math.max(0, x)),
    y: Math.min(canvasHeight, Math.max(0, y)),
  };
}

/** The two barbs of an arrow head, at the tip (x1, y1). */
export function arrowHead(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
): [[number, number], [number, number]] {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const spread = Math.PI / 7;
  return [
    [x1 - size * Math.cos(angle - spread), y1 - size * Math.sin(angle - spread)],
    [x1 - size * Math.cos(angle + spread), y1 - size * Math.sin(angle + spread)],
  ];
}

/**
 * The subset of a 2D context the renderer touches.
 *
 * Narrower than CanvasRenderingContext2D on purpose: it is what lets a test
 * pass a recorder in and assert what was drawn without a browser.
 */
export type DrawingContext = {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  // unknown, not string: a real CanvasRenderingContext2D types these as
  // string | CanvasGradient | CanvasPattern, and narrowing them to string
  // here would make the browser's own context fail to match.
  strokeStyle: unknown;
  fillStyle: unknown;
  lineCap: unknown;
  lineJoin: unknown;
  lineWidth: number;
  font: string;
};

/** Everything but text, which is placed by a click rather than dragged. */
export type DraftShape = Extract<Shape, { kind: "pen" | "rect" | "arrow" }>;

export function drawShape(ctx: DrawingContext, shape: Shape): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (shape.kind === "text") {
    ctx.fillStyle = shape.color;
    ctx.font = `600 ${shape.size}px ui-sans-serif, system-ui, sans-serif`;
    // One fillText per line: fillText does not break on a newline, it draws
    // the escape and carries on, which silently loses the rest of the note.
    shape.text.split("\n").forEach((line, i) => {
      ctx.fillText(line, shape.x, shape.y + i * shape.size * 1.25);
    });
    ctx.restore();
    return;
  }

  ctx.strokeStyle = shape.color;
  ctx.lineWidth = shape.width;

  if (shape.kind === "pen") {
    if (shape.points.length === 0) {
      ctx.restore();
      return;
    }
    ctx.beginPath();
    // A single tap is a dot, not nothing. Without this a tap draws a
    // zero-length path that most browsers skip entirely.
    if (shape.points.length === 1) {
      const [x, y] = shape.points[0];
      ctx.moveTo(x, y);
      ctx.lineTo(x, y);
    } else {
      shape.points.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
    }
    ctx.stroke();
  } else if (shape.kind === "rect") {
    ctx.strokeRect(
      Math.min(shape.x0, shape.x1),
      Math.min(shape.y0, shape.y1),
      Math.abs(shape.x1 - shape.x0),
      Math.abs(shape.y1 - shape.y0),
    );
  } else {
    ctx.beginPath();
    ctx.moveTo(shape.x0, shape.y0);
    ctx.lineTo(shape.x1, shape.y1);
    ctx.stroke();

    const size = Math.max(10, shape.width * 5);
    const [a, b] = arrowHead(shape.x0, shape.y0, shape.x1, shape.y1, size);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(shape.x1, shape.y1);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }

  ctx.restore();
}

export function drawShapes(ctx: DrawingContext, shapes: readonly Shape[]): void {
  for (const s of shapes) drawShape(ctx, s);
}

/**
 * What the saved markup is called.
 *
 * Carries the source sheet and the page, because "markup.png" in a folder of
 * forty files tells nobody which sheet it came off.
 */
export function markupFileName(sourceName: string, page: number): string {
  const stem = sourceName.replace(/\.[^.]+$/, "").slice(0, 60) || "sheet";
  const suffix = page > 0 ? `-p${page}` : "";
  return `${stem}${suffix}-markup.png`;
}

/** A drag shorter than this is a click, not a shape. */
export const DRAG_SLOP = 3;

export function isTinyDrag(x0: number, y0: number, x1: number, y1: number): boolean {
  return Math.hypot(x1 - x0, y1 - y0) < DRAG_SLOP;
}
