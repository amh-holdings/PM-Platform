// Measuring a contract line by the commodity tracker.
//
// Dimension, on AFP 13's Civil Roads line: "Invoice percentage billed needs to
// match commodity tracker." The app could not do that. Progress came from the
// schedule, or from a rule of credit on lines that carry one, and nothing ever
// read daily_production. So the owner reconciles against one instrument and the
// contractor bills off another, and on 6.02 they disagreed by eight points -
// 55.82% of duration-weighted schedule against 48.04% of tracked civil work.
//
// This is the third basis, and the order of precedence is deliberate:
//
//   1. A rule of credit. An explicit agreement with the owner about how the
//      line earns beats any measurement, because it IS the agreement.
//   2. The commodity tracker, where the reading can be trusted. Both parties
//      look at this sheet daily, which is exactly what makes it worth billing
//      from.
//   3. Duration-weighted schedule progress. The old default, and still the
//      right answer for a line no commodity measures.
//
// WHEN A READING CAN BE TRUSTED
// A 'pct' commodity is self-describing: the client's form collects a DAILY
// percent and the cumulative sum is the percent complete, so no denominator is
// needed and none can be wrong.
//
// Every other unit needs a verified total. Fifteen of Sweet Springs' eighteen
// commodities still carry the January-2025 template placeholders - 250 ft of
// road install and 500 ft of trenching on a $3.95M project - and a percentage
// over a made-up denominator is worse than no percentage, because it looks
// like one. Those are reported as ignored, with the reason, rather than
// silently dropped: a line reading 0% because nobody verified a total should
// say so.

/** One commodity's standing on a line, assembled from the tracker. */
export type CommodityReading = {
  key: string;
  label: string;
  /** 'ft' | 'ea' | 'rows' | 'pct', as the client's form defines it. */
  uom: string;
  totalQuantity: number | null;
  totalVerified: boolean;
  /** Sum of CONFIRMED daily production. Unconfirmed rows are proposals. */
  toDate: number;
  /** Latest production date behind `toDate`, for the reason line. */
  lastDate: string | null;
};

export type CommodityUse = {
  key: string;
  label: string;
  /** 0 to 1. */
  pct: number;
  note: string;
};

export type CommodityIgnored = {
  key: string;
  label: string;
  reason: string;
};

export type CommodityMeasure = {
  /** 0 to 1, capped. */
  pct: number;
  used: CommodityUse[];
  ignored: CommodityIgnored[];
  /** One sentence for the panel. */
  summary: string;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? 1 : n;
}

/**
 * Whether a unit is already a percent.
 *
 * src/lib/commodities.ts declares the unit as "pct" and the database stores
 * "%". Both are in use and neither is going to be migrated for this, so both
 * are accepted here rather than in one caller that the next caller forgets.
 */
export function isPercentUom(uom: string): boolean {
  const u = String(uom ?? "").trim().toLowerCase();
  return u === "pct" || u === "%" || u === "percent";
}

function pctOf(r: CommodityReading): { pct: number; note: string } | null {
  const to = Number(r.toDate ?? 0);
  if (isPercentUom(r.uom)) {
    return {
      pct: clamp01(to / 100),
      note: `${to.toFixed(2)}% reported to date${r.lastDate ? ` through ${r.lastDate}` : ""}`,
    };
  }
  const total = Number(r.totalQuantity ?? 0);
  if (!r.totalVerified || !(total > 0)) return null;
  return {
    pct: clamp01(to / total),
    note: `${to} of ${total} ${r.uom}${r.lastDate ? ` through ${r.lastDate}` : ""}`,
  };
}

/**
 * The line's percent complete per the tracker, or null when nothing on it can
 * be trusted - in which case the caller falls back rather than billing zero.
 *
 * Several trusted commodities on one line are averaged with equal weight.
 * There is no better basis available: the tracker records quantities, not
 * values, so it cannot say that 400 ft of road is worth more than 60% of the
 * civil work. Where that matters, the line wants a rule of credit, which is
 * the layer built for saying what a scope is worth.
 */
export function measureFromCommodities(
  readings: readonly CommodityReading[],
): CommodityMeasure | null {
  const used: CommodityUse[] = [];
  const ignored: CommodityIgnored[] = [];

  for (const r of readings) {
    const hit = pctOf(r);
    if (!hit) {
      ignored.push({
        key: r.key,
        label: r.label,
        reason: !(Number(r.totalQuantity ?? 0) > 0)
          ? `no total quantity recorded, so ${r.uom} cannot become a percent`
          : "total is an unverified placeholder - verify it before billing from this row",
      });
      continue;
    }
    used.push({ key: r.key, label: r.label, pct: hit.pct, note: hit.note });
  }

  if (used.length === 0) return null;

  const pct = clamp01(used.reduce((s, u) => s + u.pct, 0) / used.length);
  const summary =
    used.length === 1
      ? `Commodity tracker: ${used[0].label} at ${(used[0].pct * 100).toFixed(2)}% (${used[0].note})`
      : `Commodity tracker: ${(pct * 100).toFixed(2)}%, the equal-weight mean of ${used
          .map((u) => `${u.label} ${(u.pct * 100).toFixed(2)}%`)
          .join(", ")}`;

  return { pct, used, ignored, summary };
}
