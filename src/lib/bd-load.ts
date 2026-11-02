import "server-only";

import { createClient } from "@/lib/supabase/server";
import {
  bdClient,
  loadBdOwners,
  ownerIdForEmail,
  type BdBid,
  type BdCompany,
  type BdOpportunity,
  type BdOwner,
} from "@/lib/bd-db";

export type PipelineData = {
  companies: BdCompany[];
  companyName: Map<string, string>;
  opps: BdOpportunity[];
  bids: BdBid[];
  owners: BdOwner[];
  ownerName: Map<string, string>;
  /** Most recent touch per opportunity / per company (YYYY-MM-DD). */
  lastTouchByOpp: Map<string, string>;
  lastTouchByCompany: Map<string, string>;
  /** The owner the signed-in user is, matched by email. */
  me: string | null;
};

/**
 * The whole BD book in one read. AHC chases tens of jobs a year, not
 * thousands, so every BD page loads everything and filters in memory - one
 * definition of each metric, no per-page query drift.
 */
export async function loadPipeline(): Promise<PipelineData> {
  const supabase = createClient();
  const db = bdClient(supabase);
  const [
    {
      data: { user },
    },
    companies,
    opps,
    bids,
    acts,
    owners,
  ] = await Promise.all([
    supabase.auth.getUser(),
    db.from("bd_companies").select("*").order("name"),
    db.from("bd_opportunities").select("*").order("updated_at", { ascending: false }),
    db.from("bd_bids").select("*").order("submitted_on", { ascending: false }),
    db.from("bd_activities").select("company_id, opportunity_id, occurred_on"),
    loadBdOwners(supabase),
  ]);

  const lastTouchByOpp = new Map<string, string>();
  const lastTouchByCompany = new Map<string, string>();
  for (const a of acts.data ?? []) {
    if (a.opportunity_id && (lastTouchByOpp.get(a.opportunity_id) ?? "") < a.occurred_on) {
      lastTouchByOpp.set(a.opportunity_id, a.occurred_on);
    }
    if ((lastTouchByCompany.get(a.company_id) ?? "") < a.occurred_on) {
      lastTouchByCompany.set(a.company_id, a.occurred_on);
    }
  }

  const companyRows = companies.data ?? [];
  return {
    companies: companyRows,
    companyName: new Map(companyRows.map((c) => [c.id, c.name])),
    opps: opps.data ?? [],
    bids: (bids.data ?? []).map((b) => ({ ...b, price: Number(b.price) })),
    owners,
    ownerName: new Map(owners.map((o) => [o.id, o.name])),
    lastTouchByOpp,
    lastTouchByCompany,
    me: ownerIdForEmail(owners, user?.email),
  };
}

/** Numeric columns arrive as strings from PostgREST; the math wants numbers. */
export function oppLite(o: BdOpportunity) {
  const n = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));
  return {
    id: o.id,
    stage: o.stage,
    bd_owner_id: o.bd_owner_id,
    company_id: o.company_id,
    est_value: n(o.est_value),
    probability_pct: o.probability_pct,
    size_mw_dc: n(o.size_mw_dc),
    next_follow_up_date: o.next_follow_up_date,
    expected_decision_date: o.expected_decision_date,
    outcome_date: o.outcome_date,
    loss_reason: o.loss_reason,
  };
}
