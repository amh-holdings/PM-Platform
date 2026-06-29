"use client";

import { useRef } from "react";

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

// Flat-plan spatial pinning. Pins are placed where the user taps; coordinates
// are normalised so they survive any display size. Color follows status
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
  const boxRef = useRef<HTMLDivElement>(null);

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onPlace || !boxRef.current) return;
    const rect = boxRef.current.getBoundingClientRect();
    onPlace(clientToNormalized(e.clientX, e.clientY, rect));
  }

  return (
    <div
      ref={boxRef}
      onClick={handleClick}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border bg-muted",
        onPlace && "cursor-crosshair",
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={basemapSrc(basemapKey)}
        alt="Site basemap"
        className="block w-full select-none"
        draggable={false}
      />

      {pins.map((p) => {
        const pin = parsePin(p.pinX, p.pinY);
        if (!pin) return null;
        const pos = normalizedToPercent(pin);
        const color = STATUS_STYLE[p.status].pin;
        const active = activeId === p.id;
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
              "absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow",
              active ? "h-5 w-5 ring-2 ring-offset-1 ring-foreground" : "h-4 w-4",
            )}
            aria-label={`Inspection ${p.title ?? p.id} (${STATUS_STYLE[p.status].label})`}
          />
        );
      })}

      {draftPin && (
        <div
          style={normalizedToPercent(draftPin)}
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2"
        >
          <div className="h-5 w-5 animate-pulse rounded-full border-2 border-white bg-foreground shadow" />
        </div>
      )}
    </div>
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
