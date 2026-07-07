"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { BASEMAPS, type BasemapKey, isBasemapKey } from "@/lib/inspection-map";
import {
  STATUS_STYLE,
  type InspectionStatus,
} from "@/lib/inspection-status";
import {
  REPORT_STATE_LABEL,
  REPORT_STATE_TONE,
  type ReportReviewState,
} from "@/lib/field-report-status";
import { InspectionMap, StatusLegend } from "../inspections/inspection-map";

// One work pin plotted on the board map. dprId lets a click jump to its report.
export type BoardPin = {
  id: string;
  dprId: string;
  status: InspectionStatus;
  origin: string;
  basemapKey: string;
  pinX: number | null;
  pinY: number | null;
  title: string | null;
};

export type BoardReport = {
  id: string;
  subName: string;
  reportDate: string;
  submittedAt: string | null;
  state: ReportReviewState;
  tally: Record<InspectionStatus, number>;
};

type Props = {
  projectId: string;
  pins: BoardPin[];
  reports: BoardReport[];
};

const STATE_ORDER: ReportReviewState[] = [
  "needs_review",
  "in_review",
  "ready_to_finalize",
  "returned",
  "approved",
];

export function ReviewBoard({ projectId, pins, reports }: Props) {
  const router = useRouter();

  // Only offer sheets that actually carry pins, so the CM isn't clicking
  // through empty drawings. Fall back to the default site plan.
  const sheets = useMemo(() => {
    const present = new Set<BasemapKey>();
    for (const p of pins) {
      if (isBasemapKey(p.basemapKey)) present.add(p.basemapKey);
    }
    const list = (Object.keys(BASEMAPS) as BasemapKey[]).filter((k) =>
      present.has(k),
    );
    return list.length > 0 ? list : (["C2-01"] as BasemapKey[]);
  }, [pins]);

  const [sheet, setSheet] = useState<BasemapKey>(sheets[0]);
  const activeSheet = sheets.includes(sheet) ? sheet : sheets[0];

  const pinByDpr = useMemo(() => new Map(pins.map((p) => [p.id, p.dprId])), [pins]);

  const onSheet = useMemo(
    () => pins.filter((p) => p.basemapKey === activeSheet),
    [pins, activeSheet],
  );

  const mapPins = onSheet.map((p) => ({
    id: p.id,
    pinX: p.pinX,
    pinY: p.pinY,
    status: p.status,
    title: p.title,
    origin: p.origin,
  }));

  // Project-wide pin counts for the header strip.
  const counts = useMemo(() => {
    const c: Record<InspectionStatus, number> = {
      submitted: 0,
      under_review: 0,
      approved: 0,
      rejected: 0,
    };
    for (const p of pins) c[p.status] += 1;
    return c;
  }, [pins]);

  // Reports grouped by review state, in workflow order (things needing the CM
  // first, finished reports last).
  const grouped = useMemo(() => {
    const byState = new Map<ReportReviewState, BoardReport[]>();
    for (const r of reports) {
      const arr = byState.get(r.state) ?? [];
      arr.push(r);
      byState.set(r.state, arr);
    }
    return STATE_ORDER.map((state) => ({
      state,
      items: byState.get(state) ?? [],
    })).filter((g) => g.items.length > 0);
  }, [reports]);

  function openReport(dprId: string) {
    router.push(`/projects/${projectId}/field-reports/${dprId}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Review Board</h2>
          <p className="text-xs text-muted-foreground">
            Every subcontractor work pin across the project, color-coded by
            status. Amber is new, red is rejected (waiting on the sub), green is
            approved. Click a pin to open its report and review.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Count label="New" n={counts.submitted} tone="text-amber-700" />
          <Count label="Under review" n={counts.under_review} tone="text-blue-700" />
          <Count label="Approved" n={counts.approved} tone="text-emerald-700" />
          <Count label="Rejected" n={counts.rejected} tone="text-red-700" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* Map guide */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1">
              {sheets.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSheet(k)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-medium",
                    k === activeSheet
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
            basemapKey={activeSheet}
            pins={mapPins}
            onSelect={(pinId) => {
              const dprId = pinByDpr.get(pinId);
              if (dprId) openReport(dprId);
            }}
          />
          <p className="text-xs text-muted-foreground">
            {BASEMAPS[activeSheet].label}. Round = sub work, square = CM check.
          </p>
        </div>

        {/* Reports queue */}
        <div className="space-y-3">
          {grouped.length === 0 ? (
            <div className="rounded-lg border bg-card p-4 text-xs text-muted-foreground">
              No field reports yet.
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.state} className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span
                    className={cn(
                      "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                      REPORT_STATE_TONE[g.state],
                    )}
                  >
                    {REPORT_STATE_LABEL[g.state]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {g.items.length}
                  </span>
                </div>
                <ul>
                  {g.items.map((r) => (
                    <li key={r.id}>
                      <Link
                        href={`/projects/${projectId}/field-reports/${r.id}`}
                        className="block border-b px-3 py-2 last:border-0 hover:bg-muted/40"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {r.subName}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatDate(r.reportDate)}
                          </span>
                        </div>
                        <PinTally tally={r.tally} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Count({ label, n, tone }: { label: string; n: number; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("font-semibold tabular-nums", tone)}>{n}</span>
      {label}
    </span>
  );
}

function PinTally({ tally }: { tally: Record<InspectionStatus, number> }) {
  const order: InspectionStatus[] = [
    "submitted",
    "under_review",
    "approved",
    "rejected",
  ];
  const chips = order.filter((s) => tally[s] > 0);
  if (chips.length === 0) {
    return <p className="mt-1 text-xs text-muted-foreground">No work pins</p>;
  }
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {chips.map((s) => (
        <span
          key={s}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
            STATUS_STYLE[s].chip,
          )}
        >
          {tally[s]} {STATUS_STYLE[s].label}
        </span>
      ))}
    </div>
  );
}
