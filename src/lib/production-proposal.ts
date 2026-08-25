// Turning a day's Field Report into proposed commodity production.
//
// This is the classification half of the tracker's auto-fill: pure functions,
// no database, no Supabase. The DB half lives in production-proposal-run.ts and
// the historical reconstruction script (scripts/commodity/propose-backfill.ts)
// imports from here too, so the rules that judged August cannot drift from the
// rules judging tomorrow.
//
// WHAT A PROPOSAL IS AND IS NOT
// A proposal is an unconfirmed row on the tracker with a written basis attached.
// It is never billable and never pushed to the owner until Phil saves it. The
// point is not to be right unattended - it is to put a defensible starting
// number and its reasoning in front of the reviewer, instead of a blank cell he
// has to reconstruct from a narrative three weeks later.

/** A day's evidence, assembled from the Field Report and the CM's log. */
export type DayEvidence = {
  date: string;
  narrative: string;
  cmLog: string;
  /** Pin titles, e.g. "5.1.1.6 Construct Basin 1 ESC". */
  pinTitles: string[];
  crewCount: number | null;
};

/** Commodity as the proposer needs to see it. */
export type ProposalCommodity = {
  id: string;
  key: string;
  label: string;
  /** 'ft' | 'ea' | 'rows' | '%' as stored on the commodities table. */
  uom: string;
};

export type ProposedValue = {
  commodityKey: string;
  quantity: number;
  /** Plain-English account of how the number was reached. */
  basis: string;
};

// ===== Keyword rules =====
// Order matters: a day that mentions a basin or ditch is civil work even when
// the verb is "grubbing", because the scope is what classifies it, not the
// activity. Every matched keyword is reported back as evidence.

export const CIVIL_WORK_KEYWORDS = [
  "basin",
  "diversion",
  "ditch",
  "culvert",
  "grading",
  "stabiliz",
  "seeding",
  "swale",
  "riprap",
  "check dam",
  "rcp",
];

export const SITE_PREP_KEYWORDS = [
  "clearing",
  "grubbing",
  "grabbing", // recurring typo for "grubbing" in the CM logs
  "logging",
  "log load",
  "log truck",
  "pulpwood",
  "chip",
  "mulch",
  "silt fence",
  "timber",
  "lod",
  "limits of disturbance",
  "debris",
  "laydown",
  "lay down",
];

export const ROAD_KEYWORDS = ["road", "entrance way", "entranceway", "access road"];

/** Commodity key -> the keywords that signal it. */
export const KEYWORDS_BY_COMMODITY: Record<string, string[]> = {
  site_prep: SITE_PREP_KEYWORDS,
  civil_work: CIVIL_WORK_KEYWORDS,
};

// Commodities a keyword can FLAG but must never VALUE. Clearing debris off the
// entrance is a precursor to road install, not road install; proposing footage
// there would invent scope. The day gets a note and a blank cell.
export const FLAG_ONLY_KEYWORDS: Record<string, string[]> = {
  road_install: ROAD_KEYWORDS,
};

export function matched(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k));
}

// Count truck loads in ONE source. Matches "7 log loads out", "2 loads of
// chips", "3 mulch trucks out", "5 truck loads of timber".
export function countLoadsIn(text: string): number {
  const lower = text.toLowerCase();
  let total = 0;
  const patterns = [
    /(\d+)\s+(?:\w+\s+){0,2}?loads?\b/g,
    /(\d+)\s+(?:\w+\s+){0,2}?trucks?\s+out\b/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n < 100) total += n;
    }
  }
  return total;
}

// The sub's narrative and the CM's log describe the SAME trucks. Summing the two
// double-counts every day where both itemised the haul-off, and under-weights
// every day where only one of them did - which then skews any distributed
// percent toward whichever days happened to be written up twice. Take the
// higher of the two instead: the more complete account of one day's hauling.
export function countLoads(narrative: string, cmLog: string): number {
  return Math.max(countLoadsIn(narrative), countLoadsIn(cmLog));
}

/**
 * How much production a day represents, on an arbitrary but consistent scale.
 * Loads are the strongest signal; crew size is a weak tiebreaker so a day with
 * people on site but no hauling still scores above zero.
 */
export function activityScore(day: DayEvidence): number {
  const loads = countLoads(day.narrative, day.cmLog);
  return loads * 2 + (day.crewCount ?? 0) * 0.5;
}

export function combinedText(day: DayEvidence): string {
  return [day.narrative, day.cmLog, day.pinTitles.join(" ")].join("\n");
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Percent-of-scope commodities calibrated from the project's own record.
 *
 * A percent cannot be read off one day's narrative, and a hard-coded daily
 * figure would be a number that appeared from nowhere. So the rate comes from
 * what is ALREADY CONFIRMED on this project: the percent Phil has signed off
 * for a commodity, divided by the activity that earned it. Today's score times
 * that rate is the proposal.
 *
 * This is self-correcting. Every time Phil overrides a proposed percent, the
 * rate that produced it moves toward his number, so the next proposal is closer.
 * With no confirmed history the rate is unknown and NOTHING is proposed - a
 * blank cell and a note beats a fabricated percent.
 */
export type ConfirmedHistory = {
  /** commodityKey -> total confirmed percent to date. */
  totalByCommodity: Record<string, number>;
  /** commodityKey -> total activity score on the days that percent covers. */
  scoreByCommodity: Record<string, number>;
  /**
   * commodityKey -> the MEDIAN confirmed day for that scope. The ceiling on any
   * single proposal. See proposeForDay for why the median and not the mean or
   * the max.
   */
  typicalDailyByCommodity: Record<string, number>;
};

export function percentRate(
  history: ConfirmedHistory,
  commodityKey: string,
): number | null {
  const total = history.totalByCommodity[commodityKey];
  const score = history.scoreByCommodity[commodityKey];
  if (!total || !score || score <= 0) return null;
  return total / score;
}

export type ProposalInput = {
  day: DayEvidence;
  commodities: ProposalCommodity[];
  history: ConfirmedHistory;
  /**
   * Percent already confirmed or proposed against each commodity across the
   * whole project. A percent scope cannot be pushed past 100 by a proposal.
   */
  committedPercent: Record<string, number>;
  /**
   * Quantities read straight off the report's pins, keyed by commodity key,
   * where commodity_task_links maps the pin's WBS task to a commodity AND the
   * units agree. Real measured data - it always wins over a keyword guess.
   */
  pinQuantities?: Record<string, { quantity: number; source: string }>;
};

export type ProposalResult = {
  values: ProposedValue[];
  /** Commodities the evidence mentions but that must not be valued. */
  flags: { commodityKey: string; note: string }[];
  /** Why an eligible commodity got no number, so the gap is explained. */
  skipped: { commodityKey: string; reason: string }[];
};

export function proposeForDay(input: ProposalInput): ProposalResult {
  const { day, commodities, history, committedPercent } = input;
  const byKey = new Map(commodities.map((c) => [c.key, c]));
  const text = combinedText(day);
  const score = activityScore(day);
  const loads = countLoads(day.narrative, day.cmLog);

  const values: ProposedValue[] = [];
  const flags: ProposalResult["flags"] = [];
  const skipped: ProposalResult["skipped"] = [];

  // ---- 1. Measured pin quantities win outright ----
  const claimedByPin = new Set<string>();
  for (const [key, pin] of Object.entries(input.pinQuantities ?? {})) {
    const spec = byKey.get(key);
    if (!spec || pin.quantity <= 0) continue;
    claimedByPin.add(key);
    values.push({
      commodityKey: key,
      quantity: round(pin.quantity, 3),
      basis: `Measured on the report: ${pin.source} = ${pin.quantity} ${spec.uom}.`,
    });
  }

  // ---- 2. Keyword-classified commodities ----
  for (const [key, keywords] of Object.entries(KEYWORDS_BY_COMMODITY)) {
    if (claimedByPin.has(key)) continue;
    const spec = byKey.get(key);
    if (!spec) continue;
    const hits = matched(text, keywords);
    if (hits.length === 0) continue;

    if (spec.uom !== "%") {
      // A quantity scope needs a measured number and the narrative has none.
      skipped.push({
        commodityKey: key,
        reason: `Report mentions ${hits.join(", ")} but carries no measured ${spec.uom} for ${spec.label}. Enter it by hand.`,
      });
      continue;
    }

    const rate = percentRate(history, key);
    if (rate == null) {
      skipped.push({
        commodityKey: key,
        reason: `Report mentions ${hits.join(", ")}, but ${spec.label} has no confirmed history to set a daily rate from. First one is yours to judge.`,
      });
      continue;
    }
    if (score <= 0) {
      skipped.push({
        commodityKey: key,
        reason: `Report mentions ${hits.join(", ")} but records no truck loads and no crew count, so there is nothing to scale a percent by.`,
      });
      continue;
    }

    const raw = round(rate * score);
    const already = committedPercent[key] ?? 0;
    const headroom = round(Math.max(0, 100 - already));

    // AN ESTIMATE MAY PROPOSE A TYPICAL DAY, NEVER AN EXCEPTIONAL ONE.
    //
    // rate x score is linear in truck loads and the field does not oblige.
    // Sweet Springs went from 6-8 loads a day clearing the LOD to 18-19 a day
    // hauling debris out of one entranceway, and the raw rate reads that as
    // 16-21% of the ENTIRE site-prep scope in a single day. It plainly was not:
    // those loads came off one corner of the site. Unbounded, three days of
    // detailed CM logs took the scope from 60% to 95% complete.
    //
    // The real limit is that a percent of scope is not knowable from a
    // narrative at all - the backfill script only managed it because a human
    // supplied the cumulative figure and it distributed WITHIN a known total.
    // Live, there is no such anchor. So the proposal is capped at the median
    // confirmed day for that scope:
    //
    //   MEDIAN, not the mean, because a couple of big days drag a mean up and
    //   the whole point is to be unmoved by outliers.
    //   MEDIAN, not the max, because matching the best day on record whenever
    //   the CM happens to write a thorough log is exactly the failure above.
    //
    // Under-proposing is the safe direction. A number that is low anchors Phil
    // toward reading the report; a number that is high anchors him toward
    // accepting it. He can always type something bigger.
    const ceiling = history.typicalDailyByCommodity[key];
    const bounded = ceiling != null && ceiling > 0 ? Math.min(raw, ceiling) : raw;
    const quantity = Math.min(bounded, headroom);

    if (quantity <= 0) {
      skipped.push({
        commodityKey: key,
        reason: `${spec.label} is already at ${round(already)}% of scope, so there is no headroom left to propose into.`,
      });
      continue;
    }

    let capNote = "";
    if (bounded < raw) {
      capNote += ` Held down from ${raw}% to a typical confirmed day for this scope (${round(ceiling!)}%) - truck loads do not scale with percent of scope, so the raw figure is not trustworthy on its own.`;
    }
    if (quantity < bounded) {
      capNote += ` Trimmed to ${round(quantity)}% because the scope is already at ${round(already)}%.`;
    }
    values.push({
      commodityKey: key,
      quantity,
      basis:
        `${loads} truck load(s), crew ${day.crewCount ?? "not stated"} -> activity score ${round(score)}. ` +
        `Matched: ${hits.join(", ")}. Applied this project's confirmed rate of ` +
        `${round(rate, 4)}% per point of activity.${capNote}`,
    });
  }

  // ---- 3. Flag-only commodities ----
  for (const [key, keywords] of Object.entries(FLAG_ONLY_KEYWORDS)) {
    if (claimedByPin.has(key)) continue;
    if (!byKey.has(key)) continue;
    const hits = matched(text, keywords);
    if (hits.length === 0) continue;
    flags.push({
      commodityKey: key,
      note: `Mentions ${hits.join(", ")}. Reads as clearing near the entrance rather than road construction, so no footage is proposed. Confirm if it was real road install.`,
    });
  }

  return { values, flags, skipped };
}
