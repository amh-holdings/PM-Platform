/**
 * Plan-sheet markup - known-answer tests.
 *
 * The geometry is the part that can be quietly wrong. A mark drawn on a
 * laptop and saved from a phone has passed through two coordinate spaces, and
 * if the mapping is off the cloud lands next to the pile rather than on it,
 * which on an RFI is worse than no markup at all.
 *
 * Run: npx tsx scripts/markup/run-tests.ts
 */

import {
  DRAG_SLOP,
  MAX_RENDER_PX,
  MIN_CROP_PX,
  arrowHead,
  canvasPoint,
  cropScale,
  cropToSource,
  drawShape,
  drawShapes,
  isTinyDrag,
  isUsableCrop,
  markupFileName,
  normalizeRect,
  renderScale,
  transformShapes,
  type DrawingContext,
  type Shape,
} from "../../src/lib/markup";

let passed = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name} - got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    console.log(`  FAIL  ${name} - got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

function check(name: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
  }
}

function near(name: string, actual: number, expected: number, tol = 1e-6) {
  check(`${name} (${actual} ~= ${expected})`, Math.abs(actual - expected) <= tol);
}

/** Records what was drawn, so the renderer can be tested without a browser. */
type Call = [string, ...unknown[]];
function recorder(): { ctx: DrawingContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: DrawingContext = {
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (x, y) => calls.push(["moveTo", x, y]),
    lineTo: (x, y) => calls.push(["lineTo", x, y]),
    stroke: () => calls.push(["stroke"]),
    strokeRect: (x, y, w, h) => calls.push(["strokeRect", x, y, w, h]),
    fillText: (t, x, y) => calls.push(["fillText", t, x, y]),
    strokeStyle: "",
    fillStyle: "",
    lineCap: "",
    lineJoin: "",
    lineWidth: 0,
    font: "",
  };
  return { ctx, calls };
}

console.log("\n=== canvasPoint: display space -> sheet space ===");

// A 2400px sheet shown 600px wide. A click at its centre is the centre.
const rect = { left: 100, top: 50, width: 600, height: 400 };
eq(
  "centre of a scaled-down sheet",
  canvasPoint(400, 250, rect, 2400, 1600),
  { x: 1200, y: 800 },
);
eq("top-left corner", canvasPoint(100, 50, rect, 2400, 1600), { x: 0, y: 0 });
eq("bottom-right corner", canvasPoint(700, 450, rect, 2400, 1600), { x: 2400, y: 1600 });

// A drag that leaves the canvas clamps rather than drawing off the sheet,
// where it would be invisible in the saved PNG.
eq("a drag past the left edge clamps", canvasPoint(-500, 250, rect, 2400, 1600), { x: 0, y: 800 });
eq("a drag past the bottom clamps", canvasPoint(400, 9999, rect, 2400, 1600), { x: 1200, y: 1600 });

// Zoomed to 400%: the element is wider than the canvas is tall, and the same
// click has to land somewhere different.
eq(
  "zoomed in, the mapping follows the element",
  canvasPoint(100, 50, { left: 100, top: 50, width: 2400, height: 1600 }, 2400, 1600),
  { x: 0, y: 0 },
);
eq(
  "zoomed in, halfway across",
  canvasPoint(1300, 850, { left: 100, top: 50, width: 2400, height: 1600 }, 2400, 1600),
  { x: 1200, y: 800 },
);

// A zero-size rect is what getBoundingClientRect returns before layout.
// Dividing by it would be NaN, and NaN coordinates draw nothing, silently.
eq("an unlaid-out canvas is the origin", canvasPoint(400, 250, { left: 0, top: 0, width: 0, height: 0 }, 2400, 1600), { x: 0, y: 0 });

console.log("\n=== renderScale: big sheets without killing the tab ===");

// A 42x30 inch sheet at 72pt/inch is 3024 x 2160 points.
near("a full-size sheet scales down", renderScale(3024, 2160), MAX_RENDER_PX / 3024);
check("a full-size sheet lands under the cap", 3024 * renderScale(3024, 2160) <= MAX_RENDER_PX + 1);
// Letter portrait, 612 x 792.
check("a letter page is capped at 3x", renderScale(612, 792) === 3);
check("never below half size", renderScale(99999, 99999) >= 0.5);
check("a nonsense size is 1x", renderScale(0, 0) === 1);
check("NaN is 1x", renderScale(Number.NaN, 100) === 1);

console.log("\n=== arrowHead ===");

// Pointing right: both barbs sit left of the tip, one above and one below.
const [a, b] = arrowHead(0, 0, 100, 0, 20);
check("barbs are behind the tip", a[0] < 100 && b[0] < 100);
check("barbs straddle the line", Math.sign(a[1]) !== Math.sign(b[1]));
near("barbs are symmetric about the line", a[1] + b[1], 0, 1e-9);
near("barb length is the size given", Math.hypot(100 - a[0], 0 - a[1]), 20, 1e-9);

// Pointing up the page (negative y in canvas space).
const [c, d] = arrowHead(0, 100, 0, 0, 20);
check("an arrow pointing up has barbs below the tip", c[1] > 0 && d[1] > 0);

console.log("\n=== drawShape ===");

{
  const { ctx, calls } = recorder();
  drawShape(ctx, { kind: "rect", color: "#dc2626", width: 6, x0: 300, y0: 200, x1: 100, y1: 50 });
  // Dragged up and to the left: the rect still has to be positive width and
  // height or strokeRect draws nothing.
  eq("a backwards drag is normalised", calls.find((c2) => c2[0] === "strokeRect"), [
    "strokeRect",
    100,
    50,
    200,
    150,
  ]);
}

{
  const { ctx, calls } = recorder();
  drawShape(ctx, { kind: "pen", color: "#dc2626", width: 6, points: [[10, 10]] });
  const moves = calls.filter((c2) => c2[0] === "moveTo" || c2[0] === "lineTo");
  eq("a single tap still draws a dot", moves, [
    ["moveTo", 10, 10],
    ["lineTo", 10, 10],
  ]);
  check("and it is stroked", calls.some((c2) => c2[0] === "stroke"));
}

{
  const { ctx, calls } = recorder();
  drawShape(ctx, { kind: "pen", color: "#dc2626", width: 6, points: [] });
  check("an empty stroke draws nothing", !calls.some((c2) => c2[0] === "stroke"));
  check("and still balances save/restore", calls.filter((c2) => c2[0] === "save").length === 1 && calls.filter((c2) => c2[0] === "restore").length === 1);
}

{
  const { ctx, calls } = recorder();
  drawShape(ctx, {
    kind: "text",
    color: "#dc2626",
    size: 24,
    x: 50,
    y: 100,
    text: "Confirm embedment\nat row 12",
  });
  // fillText does not break lines. Without the split the second line is lost.
  eq("a two-line note draws two lines", calls.filter((c2) => c2[0] === "fillText"), [
    ["fillText", "Confirm embedment", 50, 100],
    ["fillText", "at row 12", 50, 130],
  ]);
}

{
  const { ctx, calls } = recorder();
  drawShape(ctx, { kind: "arrow", color: "#2563eb", width: 4, x0: 0, y0: 0, x1: 100, y1: 0 });
  check("an arrow draws the shaft and the head", calls.filter((c2) => c2[0] === "stroke").length === 2);
  eq("the shaft runs point to point", calls.slice(0, 5).filter((c2) => c2[0] === "moveTo" || c2[0] === "lineTo"), [
    ["moveTo", 0, 0],
    ["lineTo", 100, 0],
  ]);
}

{
  const { ctx, calls } = recorder();
  const shapes: Shape[] = [
    { kind: "rect", color: "#dc2626", width: 6, x0: 0, y0: 0, x1: 10, y1: 10 },
    { kind: "text", color: "#dc2626", size: 20, x: 5, y: 40, text: "see note" },
  ];
  drawShapes(ctx, shapes);
  // Order matters when they overlap: the note has to land on top of the box.
  const order = calls.filter((c2) => c2[0] === "strokeRect" || c2[0] === "fillText").map((c2) => c2[0]);
  eq("shapes draw in the order they were made", order, ["strokeRect", "fillText"]);
  eq("every save is matched", calls.filter((c2) => c2[0] === "save").length, calls.filter((c2) => c2[0] === "restore").length);
}


console.log("\n=== Cropping ===");

eq("a drag up and left is still a rectangle", normalizeRect(300, 200, 100, 50), { x: 100, y: 50, w: 200, h: 150 });
eq("a drag down and right", normalizeRect(100, 50, 300, 200), { x: 100, y: 50, w: 200, h: 150 });

check("a stray click is not a crop", !isUsableCrop({ x: 0, y: 0, w: 4, h: 4 }));
check("a thin sliver is not a crop", !isUsableCrop({ x: 0, y: 0, w: 400, h: 3 }));
check(`${MIN_CROP_PX}px square is`, isUsableCrop({ x: 0, y: 0, w: MIN_CROP_PX, h: MIN_CROP_PX }));

// A C04 site plan: 3024 x 2160 points, first rendered at the render cap.
const sheetScale = renderScale(3024, 2160);
// A box drawn around the inverter pad, in canvas pixels.
const box = { x: 600, y: 400, w: 800, h: 600 };
const region = cropToSource(box, sheetScale, { x: 0, y: 0 });
near("the crop is in PDF points, not canvas pixels", region.x, 600 / sheetScale);
near("and keeps its size", region.w, 800 / sheetScale);

// Cropping the crop has to measure from the sheet, not from the crop's corner.
const second = cropToSource({ x: 100, y: 100, w: 200, h: 200 }, 4, region);
near("a second crop composes", second.x, region.x + 25);
near("a second crop composes vertically", second.y, region.y + 25);
near("and takes its size from the new scale", second.w, 50);

check("a detail is rendered larger than the sheet was", cropScale(region.w, region.h) > sheetScale);
check("but never past the cap", cropScale(1, 1) === 8);
check("a photo crop is capped lower", cropScale(1, 1, MAX_RENDER_PX, 3) === 3);
check("a nonsense region is 1x", cropScale(0, 0) === 1);

console.log("\n=== Marks survive the crop ===");

// Crop to a box starting at (600, 400), re-rendered at twice the scale.
const before: Shape[] = [
  { kind: "arrow", color: "#dc2626", width: 6, x0: 700, y0: 500, x1: 800, y1: 600 },
  { kind: "pen", color: "#dc2626", width: 6, points: [[620, 420], [640, 440]] },
  { kind: "text", color: "#dc2626", size: 20, x: 650, y: 450, text: "here" },
];
const after = transformShapes(before, -600, -400, 2);

eq(
  "an arrow lands where it was drawn",
  after[0],
  { kind: "arrow", color: "#dc2626", width: 12, x0: 200, y0: 200, x1: 400, y1: 400 },
);
eq(
  "a pen stroke carries every point",
  (after[1] as Extract<Shape, { kind: "pen" }>).points,
  [[40, 40], [80, 80]],
);
eq("a note moves and grows with the sheet", { x: (after[2] as Extract<Shape, { kind: "text" }>).x, size: (after[2] as Extract<Shape, { kind: "text" }>).size }, { x: 100, size: 40 });

// Going back to the whole sheet is the same map, inverted.
const backAgain = transformShapes(after, 600 * 2, 400 * 2, 1 / 2);
eq("returning to the whole sheet puts them back", backAgain[0], before[0]);

check("widths never round to nothing", (transformShapes(before, 0, 0, 0.01)[0] as Extract<Shape, { kind: "arrow" }>).width >= 1);
check("text never shrinks to nothing", (transformShapes(before, 0, 0, 0.01)[2] as Extract<Shape, { kind: "text" }>).size >= 8);
eq("nothing is dropped", transformShapes(before, -600, -400, 2).length, before.length);
eq("an empty markup transforms to nothing", transformShapes([], 1, 1, 2), []);

console.log("\n=== isTinyDrag: a click is not a shape ===");

check("a click in place is tiny", isTinyDrag(100, 100, 100, 100));
check(`under ${DRAG_SLOP}px is tiny`, isTinyDrag(100, 100, 101, 101));
check("a real drag is not", !isTinyDrag(100, 100, 140, 180));

console.log("\n=== markupFileName ===");

eq("a sheet and a page", markupFileName("Sussex-Civil-Set.pdf", 4), "Sussex-Civil-Set-p4-markup.png");
eq("a cropped sheet says so", markupFileName("Sussex-Civil-Set.pdf", 6, true), "Sussex-Civil-Set-p6-detail-markup.png");
eq("a cropped photo says so", markupFileName("IMG_4821.jpg", 0, true), "IMG_4821-detail-markup.png");
eq("an image has no page", markupFileName("IMG_4821.jpg", 0), "IMG_4821-markup.png");
eq("a name with dots keeps all but the extension", markupFileName("C-101.detail.3.pdf", 1), "C-101.detail.3-p1-markup.png");
eq("a name with no extension survives", markupFileName("scan", 2), "scan-p2-markup.png");
eq("an empty name still produces a file name", markupFileName(".pdf", 1), "sheet-p1-markup.png");
check("a very long name is cut, not dropped", markupFileName("x".repeat(300) + ".pdf", 1).length < 90);

console.log("\n" + "=".repeat(60));
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(60));
process.exit(failures.length > 0 ? 1 : 0);
