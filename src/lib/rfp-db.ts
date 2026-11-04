/**
 * Type overlay for migration 0088 (the RFP workspace).
 *
 * Same idea as bd-db.ts: migrations are applied by hand, so the generated
 * types lag. Builds on DatabaseWithBd so one client sees both.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DatabaseWithBd } from "@/lib/bd-db";

type Pub = DatabaseWithBd["public"];
type T = Pub["Tables"];
type Optional<E> = { [K in keyof E]?: E[K] };

export type StateProfile = {
  id: string;
  state: string;
  labor: string | null;
  wage_determinations: string | null;
  licensing: string | null;
  contractor_bond_tax: string | null;
  sales_tax: string | null;
  lien_waivers: string | null;
  stormwater: string | null;
  codes: string | null;
  other_reviews: string | null;
  engineering: string | null;
  notes: string | null;
  verified_on: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RfpStepCheck = {
  id: string;
  opportunity_id: string;
  step_key: string;
  checked_by: string | null;
  checked_at: string;
};

export type RfpBidder = {
  id: string;
  opportunity_id: string;
  firm: string;
  package: string;
  kind: string;
  contact_name: string | null;
  contact_email: string | null;
  status: string;
  invited_on: string | null;
  intent_on: string | null;
  last_contact_on: string | null;
  bid_total: number | null;
  validity_date: string | null;
  wage_basis: string | null;
  bond_treatment: string | null;
  license_verified_on: string | null;
  license_note: string | null;
  decline_reason: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RfpBidderDoc = {
  id: string;
  bidder_id: string;
  doc_key: string;
  received_on: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

type Table<Row, Required extends keyof Row> = {
  Row: Row;
  Insert: Omit<Optional<Row>, Required> & Pick<Row, Required>;
  Update: Optional<Row>;
  Relationships: [];
};

export type DatabaseWithRfp = Omit<DatabaseWithBd, "public"> & {
  public: Omit<Pub, "Tables"> & {
    Tables: T & {
      bd_state_profiles: Table<StateProfile, "state">;
      rfp_step_checks: Table<RfpStepCheck, "opportunity_id" | "step_key">;
      rfp_bidders: Table<RfpBidder, "opportunity_id" | "firm" | "package">;
      rfp_bidder_docs: Table<RfpBidderDoc, "bidder_id" | "doc_key">;
    };
  };
};

export type RfpClient = SupabaseClient<DatabaseWithRfp, "public">;

/** Re-types an existing client so the RFP and BD tables are visible. Same auth, same RLS. */
export function rfpClient(supabase: unknown): RfpClient {
  return supabase as RfpClient;
}
