// Spatial map-pinning geometry. Pins are stored as normalised coordinates
// (0..1 of the basemap image box) so they are independent of the rendered
// size of the image on any device. Pure functions => unit testable.

export type NormalizedPin = { x: number; y: number };

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Convert a tap/click at client coords within the image's bounding rect into a
// normalised 0..1 pin. rect is the getBoundingClientRect() of the basemap img.
export function clientToNormalized(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): NormalizedPin {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
}

// Normalised pin -> CSS percentage strings for absolute positioning.
export function normalizedToPercent(pin: NormalizedPin): {
  left: string;
  top: string;
} {
  return {
    left: `${clamp01(pin.x) * 100}%`,
    top: `${clamp01(pin.y) * 100}%`,
  };
}

// Validate a stored pin coming back from the DB. Returns null if either coord
// is missing/out of range (e.g. a record created before a pin was dropped).
export function parsePin(
  x: number | null | undefined,
  y: number | null | undefined,
): NormalizedPin | null {
  if (x == null || y == null) return null;
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

// Available basemap sheets. C2-01 is the default site plan; C4-51 is reserved
// for the erosion & sediment overlay used by E&S inspections.
export const BASEMAPS = {
  "C2-01": {
    key: "C2-01",
    label: "C2.01 Site Improvement Plan",
    src: "/basemaps/sweetsprings-c2-01.png",
  },
  "C4-51": {
    key: "C4-51",
    label: "C4.51 Phase II E&S Control",
    src: "/basemaps/sweetsprings-c4-51.png",
  },
} as const;

export type BasemapKey = keyof typeof BASEMAPS;

export function isBasemapKey(k: string): k is BasemapKey {
  return k in BASEMAPS;
}

export function basemapSrc(key: string): string {
  return isBasemapKey(key) ? BASEMAPS[key].src : BASEMAPS["C2-01"].src;
}
