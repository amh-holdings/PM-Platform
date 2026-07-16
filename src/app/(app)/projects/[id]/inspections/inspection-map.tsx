"use client";

import { useRef } from "react";
import { Minus, Plus, Scan } from "lucide-react";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";

import {
  basemapSrc,
  clientToNormalized,
  normalizedToPercent,
  parsePin,
  type NormalizedPin,
} from "@/lib/inspection-map";
import {
  STATUS_STYLE,
  type InspectionStatus,
} from "@/lib/inspection-status";
import { cn } from "@/lib/utils";

export type MapPin = {
  id: string;
  pinX: number | null;
  pinY: number | null;
  status: InspectionStatus;
  title?: string | null;
  // 'cm' pins (Construction Manager own-checks) render square to stand apart
  // from the round subcontractor pins. Defaults to round when omitted.
  origin?: string;
  // Larger dots read as report-level markers (one per Field Report) vs the
  // small per-inspection pins. Defaults to the small pin when omitted.
  size?: "sm" | "lg";
  // Optional count badge (e.g. how many work pins a report rolls up).
  badge?: number;
};

type Props = {
  basemapKey: string;
  pins: MapPin[];
  // When set, clicking the map reports a normalised pin (placement mode).
  onPlace?: (pin: NormalizedPin) => void;
  // A pin currently being placed (placement mode), drawn distinctly.
  draftPin?: NormalizedPin | null;
  activeId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
};

// Drag further than this (px) between pointer-down and click and we treat the
// gesture as a pan, not a pin placement.
const CLICK_SLOP = 6;

// Flat-plan spatial pinning with zoom + pan. Pins are placed where the user
// taps; coordinates are normalised against the (possibly transformed) image
// box so they survive any display size or zoom level. Color follows status
// (Color-Coded QA/QC System).
export function InspectionMap({
  basemapKey,
  pins,
  onPlace,
  draftPin,
  activeId,
  onSelect,
  className,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  // Pointer-down position, to distinguish a tap (place a pin) from a pan-drag.
  const downRef = useRef<{ x: number; y: number } | null>(null);

  function handlePointerDown(e: React.PointerEvent) {
    downRef.current = { x: e.clientX, y: e.clientY };
  }

  function handleClick(e: React.MouseEvent) {
    if (!onPlace || !imgRef.current) return;
    const down = downRef.current;
    if (
      down &&
      Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP
    ) {
      // The gesture moved: it was a pan, not a placement.
      return;
    }
    // getBoundingClientRect reflects the live zoom/pan transform, so the
    // normalised coordinate is correct at any scale.
    const rect = imgRef.current.getBoundingClientRect();
    onPlace(clientToNormalized(e.clientX, e.clientY, rect));
  }

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-lg border bg-muted",
        className,
      )}
      style={{ aspectRatio: "2801 / 2429" }}
    >
      <TransformWrapper
        initialScale={1}
        minScale={1}
        maxScale={8}
        centerOnInit
        wheel={{ step: 0.12 }}
        doubleClick={{ disabled: Boolean(onPlace), step: 0.7 }}
        panning={{ velocityDisabled: true }}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <TransformComponent
              wrapperStyle={{ width: "100%", height: "100%" }}
              contentStyle={{ width: "100%", height: "100%" }}
            >
              <div
                onPointerDown={handlePointerDown}
                onClick={handleClick}
                className={cn(
                  "relative h-full w-full",
                  onPlace && "cursor-crosshair",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={basemapSrc(basemapKey)}
                  alt="Site basemap"
                  className="block h-full w-full select-none object-contain"
                  draggable={false}
                />

                {renderPins(pins, activeId, onSelect)}

                {draftPin && (
                  <div
                    style={normalizedToPercent(draftPin)}
                    className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2"
                  >
                    <div className="h-5 w-5 animate-pulse rounded-full border-2 border-white bg-foreground shadow" />
                  </div>
                )}
              </div>
            </TransformComponent>

            <div className="absolute right-2 top-2 z-30 flex flex-col gap-1">
              <ZoomButton label="Zoom in" onClick={() => zoomIn()}>
                <Plus className="h-4 w-4" />
              </ZoomButton>
              <ZoomButton label="Zoom out" onClick={() => zoomOut()}>
                <Minus className="h-4 w-4" />
              </ZoomButton>
              <ZoomButton label="Reset view" onClick={() => resetTransform()}>
                <Scan className="h-4 w-4" />
              </ZoomButton>
            </div>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-7 w-7 items-center justify-center rounded-md border bg-background/90 text-foreground shadow-sm backdrop-blur hover:bg-background"
    >
      {children}
    </button>
  );
}

function renderPins(
  pins: MapPin[],
  activeId: string | null | undefined,
  onSelect: ((id: string) => void) | undefined,
) {
  return (
    <>
      {pins.map((p) => {
        const pin = parsePin(p.pinX, p.pinY);
        if (!pin) return null;
        const pos = normalizedToPercent(pin);
        const color = STATUS_STYLE[p.status].pin;
        const active = activeId === p.id;
        const isCm = p.origin === "cm";
        const isLarge = p.size === "lg";
        // Large (report) markers sit a size up from the small per-pin dots so
        // they read as roll-ups; the active ring adds one more step.
        const sizeClass = active
          ? isLarge
            ? "h-7 w-7 ring-2 ring-offset-1 ring-foreground"
            : "h-5 w-5 ring-2 ring-offset-1 ring-foreground"
          : isLarge
            ? "h-6 w-6"
            : "h-4 w-4";
        return (
          <button
            key={p.id}
            type="button"
            title={p.title ?? STATUS_STYLE[p.status].label}
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.(p.id);
            }}
            style={{ left: pos.left, top: pos.top, backgroundColor: color }}
            className={cn(
              "absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center border-2 border-white text-[10px] font-semibold leading-none text-white shadow",
              // CM own-checks are square; subcontractor pins are round.
              isCm ? "rounded-sm" : "rounded-full",
              sizeClass,
            )}
            aria-label={`${isCm ? "CM check" : "Inspection"} ${p.title ?? p.id} (${STATUS_STYLE[p.status].label})`}
          >
            {isLarge && p.badge && p.badge > 1 ? p.badge : null}
          </button>
        );
      })}
    </>
  );
}

// Shared legend so the list page and detail page show the same color key.
export function StatusLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      {(
        Object.keys(STATUS_STYLE) as InspectionStatus[]
      ).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-full border border-white shadow"
            style={{ backgroundColor: STATUS_STYLE[s].pin }}
          />
          {STATUS_STYLE[s].label}
        </span>
      ))}
    </div>
  );
}
