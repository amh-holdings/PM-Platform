"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import {
  BASEMAPS,
  isBasemapKey,
  type BasemapKey,
} from "@/lib/inspection-map";
import {
  STATUS_STYLE,
  statusLabel,
  type InspectionStatus,
} from "@/lib/inspection-status";
import { InspectionMap, StatusLegend, type MapPin } from "./inspection-map";

export type BoardInspection = {
  id: string;
  title: string;
  status: InspectionStatus;
  inspectionType: string | null;
  basemapKey: string;
  pinX: number | null;
  pinY: number | null;
  subName: string | null;
  inspectorName: string | null;
  submittedAt: string | null;
  quantity: number | null;
  unit: string | null;
};

export function InspectionsBoard({
  projectId,
  inspections,
}: {
  projectId: string;
  inspections: BoardInspection[];
}) {
  const basemapKeys = useMemo(() => {
    const present = new Set<BasemapKey>();
    for (const i of inspections) {
      if (isBasemapKey(i.basemapKey)) present.add(i.basemapKey);
    }
    if (present.size === 0) present.add("C2-01");
    return Array.from(present);
  }, [inspections]);

  const [sheet, setSheet] = useState<BasemapKey>(basemapKeys[0] ?? "C2-01");
  const [activeId, setActiveId] = useState<string | null>(null);

  const onSheet = inspections.filter((i) => i.basemapKey === sheet);
  const pins: MapPin[] = onSheet.map((i) => ({
    id: i.id,
    pinX: i.pinX,
    pinY: i.pinY,
    status: i.status,
    title: i.title,
  }));

  if (inspections.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
        No inspections yet. Click &quot;New inspection&quot; to file the first
        one, or issue a scoped secure link to a subcontractor below.
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1">
            {basemapKeys.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setSheet(k)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium",
                  k === sheet
                    ? "border-foreground bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {BASEMAPS[k].key}
              </button>
            ))}
          </div>
          <StatusLegend />
        </div>
        <InspectionMap
          basemapKey={sheet}
          pins={pins}
          activeId={activeId}
          onSelect={setActiveId}
        />
        <p className="text-xs text-muted-foreground">
          {BASEMAPS[sheet].label}. Pins are color-coded by status; click a pin
          to highlight its row.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">Inspection</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {inspections.map((i) => (
              <tr
                key={i.id}
                onMouseEnter={() => setActiveId(i.id)}
                className={cn(
                  "border-b last:border-0 hover:bg-muted/30",
                  activeId === i.id && "bg-muted/40",
                )}
              >
                <td className="px-3 py-2">
                  <Link
                    href={`/projects/${projectId}/inspections/${i.id}`}
                    className="font-medium hover:underline"
                  >
                    {i.title}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {i.subName ?? "-"}
                    {i.inspectionType ? ` · ${i.inspectionType}` : ""}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                      STATUS_STYLE[i.status].chip,
                    )}
                  >
                    {statusLabel(i.status)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
