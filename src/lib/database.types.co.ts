/**
 * Type overlay for migration 0046 (change order buildup).
 *
 * database.types.ts is generated from the LIVE database, and migrations here
 * are applied by hand in the Supabase SQL editor. So between "code written"
 * and "migration applied" the generated types do not know about the new
 * tables or columns. This overlay teaches the client about them so the app
 * stays fully typed instead of falling back to `any`.
 *
 * Once 0046 is applied and `npm run db:types` has been run, this file is
 * redundant and can be deleted along with the `coClient()` call sites.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type Pub = Database["public"];
type T = Pub["Tables"];

type CostLineRow = {
  id: string;
  change_order_id: string;
  project_id: string;
  sort_order: number | null;
  category: string;
  description: string;
  vendor_name: string | null;
  quantity: number;
  unit: string | null;
  unit_cost: number;
  /** Generated column - read only. */
  extended_cost: number;
  markup_pct: number | null;
  cost_code_id: string | null;
  notes: string | null;
  created_at: string | null;
};

type AttachmentRow = {
  id: string;
  change_order_id: string;
  cost_line_id: string | null;
  project_id: string;
  kind: string;
  file_name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  description: string | null;
  uploaded_by_id: string | null;
  uploaded_at: string | null;
};

type EventRow = {
  id: string;
  change_order_id: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  actor_id: string | null;
  created_at: string | null;
};

/** Columns migration 0046 adds to change_orders. */
type CoAdds = {
  date_of_change_order: string | null;
  reason: string | null;
  mech_completion_delta_days: number | null;
  subst_completion_delta_days: number | null;
  exhibit_e_impact: string | null;
  capacity_ratio_impact: string | null;
  design_basis_impact: string | null;
  other_impacts: string | null;
  bond_pct: number | null;
  tax_pct: number | null;
  internal_review_at: string | null;
  rejected_at: string | null;
  voided_at: string | null;
  billing_line_id: string | null;
};

/** Columns migration 0046 adds to projects, all for Exhibit H's header. */
type ProjectAdds = {
  agreement_date: string | null;
  original_contract_value: number | null;
  guaranteed_mechanical_completion_date: string | null;
  guaranteed_substantial_completion_date: string | null;
  contractor_legal_name: string | null;
  contractor_signatory_name: string | null;
  contractor_signatory_title: string | null;
};

type Optional<E> = { [K in keyof E]?: E[K] };

export type DatabaseWithCo = Omit<Database, "public"> & {
  public: Omit<Pub, "Tables"> & {
    Tables: Omit<T, "change_orders" | "projects"> & {
      change_orders: {
        Row: T["change_orders"]["Row"] & CoAdds;
        Insert: T["change_orders"]["Insert"] & Optional<CoAdds>;
        Update: T["change_orders"]["Update"] & Optional<CoAdds>;
        Relationships: T["change_orders"]["Relationships"];
      };
      projects: {
        Row: T["projects"]["Row"] & ProjectAdds;
        Insert: T["projects"]["Insert"] & Optional<ProjectAdds>;
        Update: T["projects"]["Update"] & Optional<ProjectAdds>;
        Relationships: T["projects"]["Relationships"];
      };
      change_order_cost_lines: {
        Row: CostLineRow;
        Insert: Omit<Optional<CostLineRow>, "change_order_id" | "project_id" | "description" | "extended_cost"> & {
          change_order_id: string;
          project_id: string;
          description: string;
        };
        Update: Omit<Optional<CostLineRow>, "extended_cost">;
        Relationships: [];
      };
      change_order_attachments: {
        Row: AttachmentRow;
        Insert: Omit<Optional<AttachmentRow>, "change_order_id" | "project_id" | "file_name" | "storage_path"> & {
          change_order_id: string;
          project_id: string;
          file_name: string;
          storage_path: string;
        };
        Update: Optional<AttachmentRow>;
        Relationships: [];
      };
      change_order_events: {
        Row: EventRow;
        Insert: Omit<Optional<EventRow>, "change_order_id" | "to_status"> & {
          change_order_id: string;
          to_status: string;
        };
        Update: Optional<EventRow>;
        Relationships: [];
      };
    };
  };
};

export type CoClient = SupabaseClient<DatabaseWithCo, "public">;

/**
 * Re-types an existing Supabase client so the 0046 tables and columns are
 * visible. Same client, same auth, same RLS - only the compile-time view
 * changes.
 */
export function coClient(supabase: unknown): CoClient {
  return supabase as CoClient;
}
