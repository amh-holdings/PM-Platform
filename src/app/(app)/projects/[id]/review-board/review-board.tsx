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
import { InspectionMap, type MapPin } from "../inspections/inspection-map";

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
  safetyIncident: boolean;
  nearMiss: boolean;
  tally: Record<InspectionStatus, number>;
};

type Props = {
  projectId: string;
  pins: BoardPin[];
  reports: BoardReport[];
};

// The three buckets Phil asked for: a report is Approved, Rejected (any item
// rejected), or otherwise Pending review. Computed as a strict rollup of the
// report's own work items so both the map dot AND the queue column can NEVER
// disagree with the pins inside the report.
type ReportBucket = "pending" | "rejected" | "approved";

// Queue column order: things needing attention first, finished reports last.
const BUCKET_ORDER: ReportBucket[] = ["pending", "rejected", "approved"];

function rollupBucket(statuses: InspectionStatus[]): ReportBucket {
  if (statuses.some((s) => s === "rejected")) return "rejected";
  if (statuses.length > 0 && statuses.every((s) => s === "approved"))
    return "approved";
  return "pending";
}

// Bucket -> an InspectionStatus so InspectionMap paints the right dot color.
const BUCKET_STATUS: Record<ReportBucket, InspectionStatus> = {
  approved: "approved", // green
  pending: "submitted", // amber
  rejected: "rejected", // red
};

const BUCKET_LABEL: Record<ReportBucket, string> = {
  approved: "Approved",
  pending: "Pending",
  rejected: "Rejected",
};

// Column header tone per bucket, aligned with the pin palette.
const BUCKET_TONE: Record<ReportBucket, string> = {
  pending: "bg-amber-100 text-amber-900 border-amber-200",
  rejected: "bg-red-100 text-red-900 border-red-200",
  approved: "bg-emerald-100 text-emerald-900 border-emerald-200",
};

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

  const reportById = useMemo(
    () => new Map(reports.map((r) => [r.id, r])),
    [reports],
  );

  // Rollup bucket per report from its subcontractor work items across ALL
  // sheets, so a report's dot color reflects its true overall status.
  const rollupByReport = useMemo(() => {
    const byReport = new Map<string, InspectionStatus[]>();
    for (const p of pins) {
      if (p.origin === "cm") continue;
      const arr = byReport.get(p.dprId) ?? [];
      arr.push(p.status);
      byReport.set(p.dprId, arr);
    }
    const out = new Map<string, ReportBucket>();
    byReport.forEach((statuses, dprId) => out.set(dprId, rollupBucket(statuses)));
    return out;
  }, [pins]);

  // One dot per report on the active sheet, placed at the centroid of that
  // report's subcontractor work pins on the sheet and colored by the report's
  // approval state. CM own-check pins don't define a report location.
  const reportDots = useMemo<MapPin[]>(() => {
    const byReport = new Map<string, { xs: number; ys: number; n: number }>();
    for (const p of pins) {
      if (p.basemapKey !== activeSheet) continue;
      if (p.origin === "cm") continue;
      if (p.pinX == null || p.pinY == null) continue;
      const acc = byReport.get(p.dprId) ?? { xs: 0, ys: 0, n: 0 };
      acc.xs += p.pinX;
      acc.ys += p.pinY;
      acc.n += 1;
      byReport.set(p.dprId, acc);
    }
    const dots: MapPin[] = [];
    byReport.forEach((acc, dprId) => {
      if (acc.n === 0) return;
      const report = reportById.get(dprId);
      if (!report) return;
      const bucket = rollupByReport.get(dprId) ?? "pending";
      dots.push({
        id: dprId,
        pinX: acc.xs / acc.n,
        pinY: acc.ys / acc.n,
        status: BUCKET_STATUS[bucket],
        title: `${report.subName} · ${formatDate(report.reportDate)} · ${
          BUCKET_LABEL[bucket]
        }`,
        size: "lg",
        badge: acc.n,
      });
    });
    return dots;
  }, [pins, activeSheet, reportById, rollupByReport]);

  // Project-wide report counts for the header strip (all sheets, all reports).
  const counts = useMemo(() => {
    const c: Record<ReportBucket, number> = {
      approved: 0,
      pending: 0,
      rejected: 0,
    };
    for (const r of reports) c[rollupByReport.get(r.id) ?? "pending"] += 1;
    return c;
  }, [reports, rollupByReport]);

  // Reports grouped by the same rollup bucket that colors the dots, in workflow
  // order (pending first, approved last), so the queue and the map agree.
  const grouped = useMemo(() => {
    const byBucket = new Map<ReportBucket, BoardReport[]>();
    for (const r of reports) {
      const bucket = rollupByReport.get(r.id) ?? "pending";
      const arr = byBucket.get(bucket) ?? [];
      arr.push(r);
      byBucket.set(bucket, arr);
    }
    return BUCKET_ORDER.map((bucket) => ({
      bucket,
      items: byBucket.get(bucket) ?? [],
    })).filter((g) => g.items.length > 0);
  }, [reports, rollupByReport]);

  function openReport(dprId: string) {
    router.push(`/projects/${projectId}/field-reports/${dprId}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Review Board</h2>
          <p className="text-xs text-muted-foreground">
            Every field report across the project as a dot on the site map,
            color-coded by approval state. Green is approved, amber is pending
            review, red is rejected (waiting on the sub). Click a dot to open the
            report and review it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Count label="Approved" n={counts.approved} tone="text-emerald-700" />
          <Count label="Pending" n={counts.pending} tone="text-amber-700" />
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
            <ReportLegend />
          </div>

          <InspectionMap
            basemapKey={activeSheet}
            pins={reportDots}
            onSelect={(dprId) => openReport(dprId)}
          />
          <p className="text-xs text-muted-foreground">
            {BASEMAPS[activeSheet].label}. Each dot is one field report; the
            number is how many work items it covers on this sheet.
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
              <div key={g.bucket} className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span
                    className={cn(
                      "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                      BUCKET_TONE[g.bucket],
                    )}
                  >
                    {BUCKET_LABEL[g.bucket]}
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
                          <span className="flex min-w-0 items-center gap-1.5">
                            {r.safetyIncident && (
                              <span
                                title="Safety incident reported"
                                className="shrink-0 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                              >
                                ⚠ Safety
                              </span>
                            )}
                            <span className="truncate text-sm font-medium">
                              {r.subName}
                            </span>
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

// Three-color key for the report dots (matches BUCKET_STATUS above).
function ReportLegend() {
  const buckets: ReportBucket[] = ["approved", "pending", "rejected"];
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      {buckets.map((b) => (
        <span key={b} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-full border border-white shadow"
            style={{ backgroundColor: STATUS_STYLE[BUCKET_STATUS[b]].pin }}
          />
          {BUCKET_LABEL[b]}
        </span>
      ))}
    </div>
  );
}

function PinTally({ tally }: { tally: Record<InspectionStatus, number> }) {
  // The field-report flow only ever produces these three; the legacy blue
  // "under review" state is never shown here.
  const order: InspectionStatus[] = ["submitted", "approved", "rejected"];
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
