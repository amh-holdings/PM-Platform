/**
 * Type overlay for migrations 0088 and 0090 (the bid analyzer).
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

export type RfpRound = {
  id: string;
  opportunity_id: string | null;
  project_id: string | null;
  kind: string;
  label: string;
  state: string | null;
  due_date: string | null;
  status: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RfpBidder = {
  id: string;
  round_id: string;
  opportunity_id: string | null;
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
  // 0090: the last extraction
  source_file_name: string | null;
  printed_total: number | null;
  extracted_at: string | null;
  extraction_notes: string | null;
  defects: string[];
  lines_confirmed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RfpBidLine = {
  id: string;
  bidder_id: string;
  package: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  amount: number | null;
  source_ref: string | null;
  sort_order: number;
  created_at: string;
};

export type RfpRoundPackage = {
  id: string;
  round_id: string;
  package: string;
  estimate: number | null;
  carried_bidder_id: string | null;
  created_at: string;
};

export type RfpRoundCostCode = {
  id: string;
  round_id: string;
  package: string;
  cost_code_id: string;
  created_at: string;
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
      rfp_rounds: Table<RfpRound, "label">;
      rfp_bidders: Table<RfpBidder, "round_id" | "firm" | "package">;
      rfp_bid_lines: Table<RfpBidLine, "bidder_id" | "package" | "description">;
      rfp_round_packages: Table<RfpRoundPackage, "round_id" | "package">;
      rfp_round_cost_codes: Table<RfpRoundCostCode, "round_id" | "package" | "cost_code_id">;
      rfp_bidder_docs: Table<RfpBidderDoc, "bidder_id" | "doc_key">;
    };
  };
};

export type RfpClient = SupabaseClient<DatabaseWithRfp, "public">;

/** Re-types an existing client so the RFP and BD tables are visible. Same auth, same RLS. */
export function rfpClient(supabase: unknown): RfpClient {
  return supabase as RfpClient;
}
