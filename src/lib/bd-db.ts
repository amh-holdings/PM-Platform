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
  // 0078: account tracking
  relationship_stage: string;
  tier: string;
  // 0079: the owner, who may have no login
  bd_owner_id: string | null;
  next_step: string | null;
  next_touch_date: string | null;
};

/** A BD owner (0079). Email is optional; when set, it links the name to a login. */
export type BdOwner = {
  id: string;
  name: string;
  email: string | null;
  created_at: string;
  updated_at: string;
};

export function ownerLabel(ownerId: string | null, ownerName: Map<string, string>): string {
  return (ownerId && ownerName.get(ownerId)) || "-";
}

export type BdContact = {
  id: string;
  company_id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  is_decision_maker: boolean;
  notes: string | null;
  // 0080
  status: string;
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
  bd_owner_id: string | null;
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

/** Every client and bid stage change, written by trigger (0080). */
export type BdStageChange = {
  id: string;
  company_id: string;
  opportunity_id: string | null;
  from_stage: string;
  to_stage: string;
  changed_by: string | null;
  changed_at: string;
};

/** One priced line of a bid form, sorted into a category (0081). */
export type BdCostLine = {
  id: string;
  bid_id: string;
  category: string;
  label: string;
  amount: number;
  source_file: string;
  source_row: number;
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
      bd_owners: Table<BdOwner, "name">;
      bd_companies: Table<BdCompany, "name">;
      bd_contacts: Table<BdContact, "company_id" | "name">;
      bd_opportunities: Table<BdOpportunity, "company_id" | "name">;
      bd_bids: Table<BdBid, "opportunity_id" | "submitted_on" | "price">;
      bd_activities: Table<BdActivity, "company_id">;
      bd_bid_cost_lines: Table<BdCostLine, "bid_id" | "category" | "label" | "amount" | "source_file" | "source_row">;
      bd_stage_history: Table<BdStageChange, "company_id" | "from_stage" | "to_stage">;
    };
  };
};

export type BdClient = SupabaseClient<DatabaseWithBd, "public">;

/** Re-types an existing client so the BD tables are visible. Same auth, same RLS. */
export function bdClient(supabase: unknown): BdClient {
  return supabase as BdClient;
}

export async function loadBdOwners(supabase: unknown): Promise<BdOwner[]> {
  const { data } = await bdClient(supabase).from("bd_owners").select("*").order("name");
  return data ?? [];
}

/** The owner a signed-in user is: the one carrying their email. */
export function ownerIdForEmail(owners: BdOwner[], email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.toLowerCase();
  return owners.find((o) => o.email?.toLowerCase() === e)?.id ?? null;
}

export type BdPerson = { id: string; name: string };

/**
 * People with a login who can log BD activity: Phil and the bd users. RLS lets
 * a bd user read exactly these profiles (0074); Phil reads all and we filter.
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
