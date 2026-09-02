"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { saveDailyProduction } from "../../production-actions";

type Commodity = {
  id: string;
  key: string;
  label: string;
  category: "civil" | "electrical" | "mechanical";
  uom: string;
  totalQuantity: number | null;
  totalVerified: boolean;
};

type Evidence = {
  sub: string | null;
  cm: string | null;
  crew: number | null;
  reportStatus: string | null;
};

type Props = {
  projectId: string;
  commodities: Commodity[];
  dates: string[];
  initialValues: Record<string, Record<string, number>>;
  /** date -> commodity key -> how this auto-filled number was reached. */
  autoBasis: Record<string, Record<string, string>>;
  evidence: Record<string, Evidence>;
  projectTotals: Record<string, number>;
  range: { from: string; to: string };
  canEdit: boolean;
  syncedCount: number;
  autoFilledCount: number;
};

const CATEGORY_LABEL = {
  civil: "Civil",
  electrical: "Electrical",
  mechanical: "Mechanical",
} as const;

function cellKey(date: string, key: string) {
  return `${date}|${key}`;
}

function weekday(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
}

function isWeekend(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

export function ProductionGrid({
  projectId,
  commodities,
  dates,
  initialValues,
  autoBasis,
  evidence,
  projectTotals,
  range,
  canEdit,
  syncedCount,
  autoFilledCount,
}: Props) {
  const router = useRouter();

  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  function currentValue(date: string, key: string): string {
    const edit = edits.get(cellKey(date, key));
    if (edit != null) return edit;
    const v = initialValues[date]?.[key];
    return v == null ? "" : String(v);
  }

  // The report's reasoning stands only until Phil types over it: once he does,
  // the number is his and attributing it to the report would be misleading.
  function reportBasis(date: string, key: string): string | null {
    if (edits.has(cellKey(date, key))) return null;
    return autoBasis[date]?.[key] ?? null;
  }

  function patch(date: string, key: string, value: string) {
    setSaved(null);
    setEdits((prev) => {
      const next = new Map(prev);
      next.set(cellKey(date, key), value);
      return next;
    });
  }

  // Only commodities with something to show are given a column by default -
  // eighteen columns on a laptop is unreadable, and fourteen of them are zero
  // for months at a time. "Show all" opens the rest when scope starts.
  const [showAll, setShowAll] = useState(false);
  const activeCommodities = useMemo(() => {
    if (showAll) return commodities;
    const withData = commodities.filter((c) => {
      if ((projectTotals[c.key] ?? 0) > 0) return true;
      return dates.some((d) => {
        const v = currentValue(d, c.key);
        return v !== "" && Number(v) > 0;
      });
    });
    return withData.length > 0 ? withData : commodities.slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commodities, showAll, projectTotals, dates, edits, initialValues]);

  const windowTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of activeCommodities) {
      let sum = 0;
      for (const d of dates) {
        const v = Number(currentValue(d, c.key));
        if (Number.isFinite(v)) sum += v;
      }
      out[c.key] = sum;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCommodities, dates, edits, initialValues]);

  // The alarm this page needed: a day whose report the CM approved but which
  // carries no production at all. Under-billing hides here - an approved report
  // is work that happened, and a blank row is the owner being told it did not.
  const uncoveredDays = useMemo(
    () =>
      dates.filter((d) => {
        if (evidence[d]?.reportStatus !== "approved") return false;
        return !commodities.some((c) => currentValue(d, c.key) !== "");
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dates, evidence, commodities, edits, initialValues],
  );

  const dirtyCount = edits.size;

  function applyRange() {
    router.push(`/projects/${projectId}/production?from=${from}&to=${to}`);
  }

  async function onSave() {
    setError(null);
    setSaved(null);
    if (dirtyCount === 0) return;
    setSaving(true);
    // Only what Phil actually typed. Auto-filled cells are already filed, so
    // sweeping them into the save would rewrite untouched rows as his and cost
    // the tracker the provenance that says the report produced them.
    const cells = Array.from(edits.entries()).map(([k, raw]) => {
      const [productionDate, commodityKey] = k.split("|");
      return {
        productionDate,
        commodityKey,
        quantity: raw.trim() === "" ? 0 : Number(raw),
      };
    });
    const res = await saveDailyProduction({ projectId, cells });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEdits(new Map());
    setSaved(
      `Filed ${res.written} correction${res.written === 1 ? "" : "s"}.`,
    );
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {/* ===== Range picker ===== */}
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="prod-from">From</Label>
            <Input
              id="prod-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-[10.5rem]"
            />
          </div>
          <div>
            <Label htmlFor="prod-to">To</Label>
            <Input
              id="prod-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-[10.5rem]"
            />
          </div>
          <Button type="button" variant="outline" onClick={applyRange}>
            Pull dates
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll
                ? "Show active only"
                : `Show all ${commodities.length} commodities`}
            </Button>
            {canEdit && (
              <Button
                type="button"
                onClick={onSave}
                disabled={saving || dirtyCount === 0}
              >
                {saving
                  ? "Saving..."
                  : dirtyCount > 0
                    ? `Save ${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`
                    : "Saved"}
              </Button>
            )}
          </div>
        </div>

        {!canEdit && (
          <p className="mt-3 text-xs text-muted-foreground">
            Read-only. The daily production report is filed by Phil.
          </p>
        )}
        {autoFilledCount > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {autoFilledCount} value{autoFilledCount === 1 ? "" : "s"} filled
              from approved Field Reports.
            </span>{" "}
            Marked below. Hover a cell for how the figure was reached, or open
            the day&apos;s report on the right. They are already counted - type
            over any that reads wrong.
          </p>
        )}
        {uncoveredDays.length > 0 && (
          <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span className="font-medium">
              {uncoveredDays.length} approved report
              {uncoveredDays.length === 1 ? "" : "s"} with nothing on the tracker:
            </span>{" "}
            {uncoveredDays.join(", ")}. The report described work the classifier
            could not put a number to - read it in the right-hand column and
            enter the quantities.
          </p>
        )}
        {syncedCount > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            {syncedCount} value{syncedCount === 1 ? " has" : "s have"} already been
            sent to the owner. Changing those means correcting their sheet too.
          </p>
        )}
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        {saved && <p className="mt-3 text-xs text-muted-foreground">{saved}</p>}
      </section>

      {/* ===== Grid ===== */}
      <section className="rounded-lg border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Date
                </th>
                {activeCommodities.map((c) => (
                  <th
                    key={c.key}
                    className="whitespace-nowrap px-2 py-2 text-right text-xs font-semibold"
                  >
                    {c.label}
                    <div className="font-normal text-muted-foreground">
                      {c.uom} &middot; {CATEGORY_LABEL[c.category]}
                    </div>
                  </th>
                ))}
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Field report
                </th>
              </tr>
            </thead>
            <tbody>
              {dates.map((date) => {
                const ev = evidence[date];
                const hasReport = Boolean(ev?.sub || ev?.cm);
                const open = openDate === date;
                return (
                  <tr
                    key={date}
                    className={cn(
                      "border-b last:border-b-0",
                      isWeekend(date) && "bg-muted/20",
                    )}
                  >
                    <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-1.5 font-medium">
                      {date}
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        {weekday(date)}
                      </span>
                    </td>
                    {activeCommodities.map((c) => {
                      const basis = reportBasis(date, c.key);
                      return (
                        <td key={c.key} className="px-1 py-1">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            inputMode="decimal"
                            aria-label={
                              basis
                                ? `${c.label} on ${date}, filled from the approved field report`
                                : `${c.label} on ${date}`
                            }
                            title={basis ?? undefined}
                            disabled={!canEdit}
                            placeholder="0"
                            value={currentValue(date, c.key)}
                            onChange={(e) => patch(date, c.key, e.target.value)}
                            className={cn(
                              "h-8 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums",
                              "focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60",
                              // Filed from the report, not pending on anyone. A
                              // dotted underline says "there is a story behind
                              // this figure, hover it" without the alarm colour
                              // that used to mean "unbilled until you click".
                              basis && "border-dashed border-muted-foreground/50",
                              edits.has(cellKey(date, c.key)) &&
                                "border-foreground/60 bg-accent/40",
                            )}
                          />
                        </td>
                      );
                    })}
                    <td className="max-w-[26rem] px-3 py-1.5 text-xs text-muted-foreground">
                      {ev?.reportStatus === "approved" &&
                        !commodities.some((c) => currentValue(date, c.key) !== "") && (
                          <span className="mr-1 rounded bg-destructive/15 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive">
                            nothing filed
                          </span>
                        )}
                      {hasReport ? (
                        <button
                          type="button"
                          className="text-left underline-offset-2 hover:underline"
                          onClick={() => setOpenDate(open ? null : date)}
                        >
                          {open
                            ? "Hide"
                            : (ev?.sub || ev?.cm || "").slice(0, 70).trim() + "..."}
                        </button>
                      ) : (
                        <span className="italic">no report</span>
                      )}
                      {open && (
                        <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2">
                          <div>
                            <span className="font-medium text-foreground">
                              Sub report
                            </span>
                            {ev?.crew != null && (
                              <span className="ml-1">(crew {ev.crew})</span>
                            )}
                            <p className="mt-0.5 whitespace-pre-wrap">
                              {ev?.sub || "none"}
                            </p>
                          </div>
                          <div>
                            <span className="font-medium text-foreground">
                              CM log
                            </span>
                            <p className="mt-0.5 whitespace-pre-wrap">
                              {ev?.cm || "none"}
                            </p>
                          </div>
                          {Object.keys(autoBasis[date] ?? {}).length > 0 && (
                            <div>
                              <span className="font-medium text-foreground">
                                How these numbers were reached
                              </span>
                              <ul className="mt-0.5 space-y-1">
                                {Object.entries(autoBasis[date] ?? {}).map(
                                  ([key, basis]) => (
                                    <li key={key}>
                                      <span className="font-medium">
                                        {commodities.find((c) => c.key === key)
                                          ?.label ?? key}
                                      </span>
                                      : {basis}
                                    </li>
                                  ),
                                )}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 bg-muted/40 font-medium">
                <td className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-xs uppercase tracking-wide">
                  Range total
                </td>
                {activeCommodities.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right tabular-nums">
                    {Math.round((windowTotals[c.key] ?? 0) * 100) / 100}
                  </td>
                ))}
                <td />
              </tr>
              <tr className="bg-muted/20 text-xs text-muted-foreground">
                <td className="sticky left-0 z-10 bg-muted/20 px-3 py-2 uppercase tracking-wide">
                  Project to date
                </td>
                {activeCommodities.map((c) => {
                  const total = projectTotals[c.key] ?? 0;
                  const target = c.totalQuantity;
                  const pct =
                    c.uom === "%"
                      ? total
                      : target && target > 0
                        ? (total / target) * 100
                        : null;
                  return (
                    <td key={c.key} className="px-3 py-2 text-right tabular-nums">
                      {Math.round(total * 100) / 100}
                      {pct != null && (
                        <div
                          className={cn(
                            !c.totalVerified && c.uom !== "%" && "italic",
                          )}
                          title={
                            !c.totalVerified && c.uom !== "%"
                              ? "Target is an unverified placeholder from the owner's template"
                              : undefined
                          }
                        >
                          {Math.round(pct)}%{!c.totalVerified && c.uom !== "%" ? "?" : ""}
                        </div>
                      )}
                    </td>
                  );
                })}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>
  );
}
