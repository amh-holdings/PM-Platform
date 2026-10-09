/**
 * Type overlay for migration 0074 (business development tables).
 *
 * Same idea as database.types.co.ts: migrations are applied by hand, so the
 * generated types lag. Once 0074 is applied and `npm run db:types` has run,
 * this overlay can go and bdClient() call sites become plain clients.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type Pub = Database["public"];
type T = Pub["Tables"];
type Optional<E> = { [K in keyof E]?: E[K] };

export type BdCompany = {
  id: string;
  name: string;
  company_type: string;
  state: string | null;
  website: string | null;
  owner_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BdContact = {
  id: string;
  company_id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  is_decision_maker: boolean;
  notes: string | null;
  created_at: string;
};

export type BdOpportunity = {
  id: string;
  company_id: string;
  contact_id: string | null;
  name: string;
  state: string | null;
  county: string | null;
  size_mw_dc: number | null;
  size_mwh: number | null;
  stage: string;
  owner_id: string | null;
  source: string | null;
  est_value: number | null;
  probability_pct: number | null;
  bid_due_date: string | null;
  expected_decision_date: string | null;
  next_follow_up_date: string | null;
  outcome_date: string | null;
  loss_reason: string | null;
  winner: string | null;
  winning_price: number | null;
  outcome_notes: string | null;
  project_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BdBid = {
  id: string;
  opportunity_id: string;
  revision_type: string;
  submitted_on: string;
  price: number;
  margin_pct: number | null;
  equipment_basis: string;
  exclusions: string | null;
  proposal_url: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export type BdActivity = {
  id: string;
  company_id: string;
  opportunity_id: string | null;
  contact_id: string | null;
  activity_type: string;
  occurred_on: string;
  notes: string | null;
  logged_by: string | null;
  created_at: string;
};

type Table<Row, Required extends keyof Row> = {
  Row: Row;
  Insert: Omit<Optional<Row>, Required> & Pick<Row, Required>;
  Update: Optional<Row>;
  Relationships: [];
};

export type DatabaseWithBd = Omit<Database, "public"> & {
  public: Omit<Pub, "Tables"> & {
    Tables: T & {
      bd_companies: Table<BdCompany, "name">;
      bd_contacts: Table<BdContact, "company_id" | "name">;
      bd_opportunities: Table<BdOpportunity, "company_id" | "name">;
      bd_bids: Table<BdBid, "opportunity_id" | "submitted_on" | "price">;
      bd_activities: Table<BdActivity, "company_id">;
    };
  };
};

export type BdClient = SupabaseClient<DatabaseWithBd, "public">;

/** Re-types an existing client so the BD tables are visible. Same auth, same RLS. */
export function bdClient(supabase: unknown): BdClient {
  return supabase as BdClient;
}

export type BdPerson = { id: string; name: string };

/**
 * People who can own an opportunity: Phil and the bd users. RLS lets a bd
 * user read exactly these profiles (0074); Phil reads all and we filter.
 */
export async function loadBdPeople(supabase: unknown): Promise<BdPerson[]> {
  const { data } = await (supabase as SupabaseClient)
    .from("profiles")
    .select("id, full_name, email, role")
    .in("role", ["phil", "bd"])
    .eq("active", true);
  return (data ?? [])
    .map((p: { id: string; full_name: string | null; email: string | null }) => ({
      id: p.id,
      name: p.full_name || p.email || "Unknown",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
