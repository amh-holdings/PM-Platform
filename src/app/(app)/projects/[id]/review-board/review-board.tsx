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

// The three buckets Phil asked for on the map: a report is Approved, Rejected
// (returned to the sub), or otherwise Pending review. Each maps to the shared
// QA/QC dot palette so the colors match everywhere else in the app.
type ReportBucket = "approved" | "pending" | "rejected";

function reportBucket(state: ReportReviewState): ReportBucket {
  if (state === "approved") return "approved";
  if (state === "returned") return "rejected";
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
      const bucket = reportBucket(report.state);
      dots.push({
        id: dprId,
        pinX: acc.xs / acc.n,
        pinY: acc.ys / acc.n,
        status: BUCKET_STATUS[bucket],
        title: `${report.subName} · ${formatDate(report.reportDate)} · ${
          REPORT_STATE_LABEL[report.state]
        }`,
        size: "lg",
        badge: acc.n,
      });
    });
    return dots;
  }, [pins, activeSheet, reportById]);

  // Project-wide report counts for the header strip (all sheets, all reports).
  const counts = useMemo(() => {
    const c: Record<ReportBucket, number> = {
      approved: 0,
      pending: 0,
      rejected: 0,
    };
    for (const r of reports) c[reportBucket(r.state)] += 1;
    return c;
  }, [reports]);

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
