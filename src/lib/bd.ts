// Business development: stages, cadence and the pipeline math. Pure - no
// Supabase, no server imports - so pages, actions and the test script share
// one definition of "win rate".
//
// Definitions (agreed with Phil 2026-10-09):
//   - Decided  = won + lost. No-bid and dead never count either way.
//   - Win rate (count) = won / decided.
//   - Win rate ($)     = $ won / $ decided, priced at each opportunity's latest
//                        bid revision. A decided job with no bid on file counts
//                        in the count rate and is left out of the $ rate.
//   - Weighted pipeline = sum over open jobs of value x probability, where
//                        value is the latest bid (else the estimate) and
//                        probability is the override (else the stage default).

export const BD_STAGES = [
  "lead",
  "bidding",
  "submitted",
  "shortlist",
  "won",
  "lost",
  "no_bid",
  "dead",
] as const;
export type BdStage = (typeof BD_STAGES)[number];

export const OPEN_STAGES: readonly BdStage[] = ["lead", "bidding", "submitted", "shortlist"];
export const CLOSED_STAGES: readonly BdStage[] = ["won", "lost", "no_bid", "dead"];

export function isOpenStage(stage: string): boolean {
  return (OPEN_STAGES as readonly string[]).includes(stage);
}

export const STAGE_LABEL: Record<BdStage, string> = {
  lead: "Lead",
  bidding: "Bidding",
  submitted: "Submitted",
  shortlist: "Shortlist / BAFO",
  won: "Won",
  lost: "Lost",
  no_bid: "No-bid",
  dead: "Dead",
};

// Default win probability by stage, used for the weighted pipeline when an
// opportunity has no override.
export const STAGE_PROBABILITY: Record<BdStage, number> = {
  lead: 10,
  bidding: 25,
  submitted: 35,
  shortlist: 60,
  won: 100,
  lost: 0,
  no_bid: 0,
  dead: 0,
};

// Days to the next follow-up when one is logged, by stage. Submitted is 7 days
// after the bid goes in (set by the bid action), then every 14.
export const FOLLOW_UP_DAYS: Record<BdStage, number> = {
  lead: 30,
  bidding: 7,
  submitted: 14,
  shortlist: 7,
  won: 0,
  lost: 0,
  no_bid: 0,
  dead: 0,
};
export const FIRST_FOLLOW_UP_AFTER_BID_DAYS = 7;
export const STALE_CLIENT_DAYS = 60;

export const LOSS_REASONS = [
  "price",
  "schedule",
  "scope",
  "relationship",
  "in_house",
  "unknown",
] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

export const LOSS_REASON_LABEL: Record<LossReason, string> = {
  price: "Price",
  schedule: "Schedule",
  scope: "Scope or qualifications",
  relationship: "Relationship / incumbent",
  in_house: "Went in-house / self-perform",
  unknown: "Unknown / never told",
};

export const REVISION_TYPES = ["indicative", "final", "bafo"] as const;
export const REVISION_LABEL: Record<(typeof REVISION_TYPES)[number], string> = {
  indicative: "Indicative",
  final: "Final",
  bafo: "BAFO",
};

export const EQUIPMENT_BASES = ["epc_furnished", "owner_furnished", "partial"] as const;
export const EQUIPMENT_LABEL: Record<(typeof EQUIPMENT_BASES)[number], string> = {
  epc_furnished: "EPC-furnished",
  owner_furnished: "Owner-furnished",
  partial: "Partial",
};

export const COMPANY_TYPES = ["Developer", "IPP", "Utility", "EPC", "Other"] as const;

export const ACTIVITY_TYPES = ["call", "email", "meeting", "site_visit", "text", "other"] as const;
export const ACTIVITY_LABEL: Record<(typeof ACTIVITY_TYPES)[number], string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  site_visit: "Site visit",
  text: "Text",
  other: "Other",
};

// ---------------------------------------------------------------- dates ----

/** Today as YYYY-MM-DD in Eastern time, where the team works. */
export function todayIso(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// ------------------------------------------------------------- the math ----

export type BidLite = {
  opportunity_id: string;
  submitted_on: string;
  price: number;
  equipment_basis: string;
  created_at?: string | null;
};

export type OppLite = {
  id: string;
  stage: string;
  owner_id: string | null;
  company_id: string;
  est_value: number | null;
  probability_pct: number | null;
  size_mw_dc: number | null;
  next_follow_up_date: string | null;
  expected_decision_date: string | null;
  outcome_date: string | null;
  loss_reason: string | null;
};

/** Latest revision per opportunity: by submitted date, then entry time. */
export function latestBidByOpp<B extends BidLite>(bids: B[]): Map<string, B> {
  const out = new Map<string, B>();
  for (const b of bids) {
    const cur = out.get(b.opportunity_id);
    if (
      !cur ||
      b.submitted_on > cur.submitted_on ||
      (b.submitted_on === cur.submitted_on && (b.created_at ?? "") > (cur.created_at ?? ""))
    ) {
      out.set(b.opportunity_id, b);
    }
  }
  return out;
}

/** First submission date per opportunity, the start of the decision clock. */
export function firstBidDateByOpp(bids: BidLite[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of bids) {
    const cur = out.get(b.opportunity_id);
    if (!cur || b.submitted_on < cur) out.set(b.opportunity_id, b.submitted_on);
  }
  return out;
}

/** $/W DC. Null when the size is unknown. */
export function dollarsPerWatt(price: number, sizeMwDc: number | null): number | null {
  if (!sizeMwDc || sizeMwDc <= 0) return null;
  return price / (sizeMwDc * 1_000_000);
}

export function opportunityValue(opp: OppLite, latest: BidLite | undefined): number | null {
  return latest ? latest.price : opp.est_value;
}

export function probabilityOf(opp: OppLite): number {
  if (opp.probability_pct !== null && opp.probability_pct !== undefined) return opp.probability_pct;
  return STAGE_PROBABILITY[opp.stage as BdStage] ?? 0;
}

export type WinRate = {
  won: number;
  lost: number;
  rateCount: number | null;
  wonDollars: number;
  decidedDollars: number;
  rateDollars: number | null;
};

export function winRate(opps: OppLite[], latest: Map<string, BidLite>): WinRate {
  let won = 0;
  let lost = 0;
  let wonDollars = 0;
  let decidedDollars = 0;
  for (const o of opps) {
    if (o.stage !== "won" && o.stage !== "lost") continue;
    if (o.stage === "won") won += 1;
    else lost += 1;
    const bid = latest.get(o.id);
    if (!bid) continue;
    decidedDollars += bid.price;
    if (o.stage === "won") wonDollars += bid.price;
  }
  const decided = won + lost;
  return {
    won,
    lost,
    rateCount: decided ? won / decided : null,
    wonDollars,
    decidedDollars,
    rateDollars: decidedDollars ? wonDollars / decidedDollars : null,
  };
}

export function pipeline(
  opps: OppLite[],
  latest: Map<string, BidLite>,
): { count: number; total: number; weighted: number } {
  let count = 0;
  let total = 0;
  let weighted = 0;
  for (const o of opps) {
    if (!isOpenStage(o.stage)) continue;
    count += 1;
    const v = opportunityValue(o, latest.get(o.id)) ?? 0;
    total += v;
    weighted += (v * probabilityOf(o)) / 100;
  }
  return { count, total, weighted };
}

export type QueueBucket = "overdue" | "today" | "week" | "later";

/** Where an open opportunity sits in the follow-up queue. */
export function queueBucket(nextFollowUp: string | null, today: string): QueueBucket {
  if (!nextFollowUp) return "overdue"; // the database forbids this; treat as urgent if it slips in
  const d = daysBetween(today, nextFollowUp);
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  if (d <= 7) return "week";
  return "later";
}

/** Open, and the client's expected decision date has passed: ask for the outcome. */
export function needsOutcome(opp: OppLite, today: string): boolean {
  return (
    isOpenStage(opp.stage) &&
    opp.stage !== "lead" &&
    !!opp.expected_decision_date &&
    opp.expected_decision_date < today
  );
}

export function lossReasonMix(opps: OppLite[]): { reason: LossReason; count: number }[] {
  const counts = new Map<LossReason, number>();
  for (const o of opps) {
    if (o.stage !== "lost") continue;
    const r = (o.loss_reason ?? "unknown") as LossReason;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return LOSS_REASONS.map((reason) => ({ reason, count: counts.get(reason) ?? 0 })).filter(
    (r) => r.count > 0,
  );
}

/** Median days from first bid to decision, over decided jobs that have both dates. */
export function medianCycleDays(opps: OppLite[], firstBid: Map<string, string>): number | null {
  const days: number[] = [];
  for (const o of opps) {
    if ((o.stage !== "won" && o.stage !== "lost") || !o.outcome_date) continue;
    const start = firstBid.get(o.id);
    if (!start) continue;
    days.push(daysBetween(start, o.outcome_date));
  }
  if (!days.length) return null;
  days.sort((a, b) => a - b);
  const mid = Math.floor(days.length / 2);
  return days.length % 2 ? days[mid] : Math.round((days[mid - 1] + days[mid]) / 2);
}

export function formatPct(rate: number | null): string {
  return rate === null ? "-" : `${Math.round(rate * 100)}%`;
}

export function formatPerWatt(v: number | null): string {
  return v === null ? "-" : `$${v.toFixed(3)}/W`;
}

/** Whole-dollar compact form for tiles: $12.4M, $850K. Tables use formatCurrency. */
export function formatCompactUsd(v: number | null): string {
  if (v === null) return "-";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}
