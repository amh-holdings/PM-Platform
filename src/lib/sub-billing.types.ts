// Row types for the sub-billing tables (migration 0038).
//
// database.types.ts is regenerated from the live schema, so hand-editing it
// would be lost on the next pull. These four tables are declared here instead
// and merged into the generated Database type, which keeps every query against
// them fully typed without touching the generated file. Once 0038 is applied
// and the types are regenerated, this file can be deleted and the imports
// pointed back at database.types.ts.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

export type VerificationMethod =
  | "schedule"
  | "commodity"
  | "milestone"
  | "on_site"
  | "time"
  | "manual"
  | "unmapped";

export type SubPayAppStatus =
  | "received"
  | "under_review"
  | "cm_recommended"
  | "approved"
  | "rejected"
  | "paid";

export type SubSovLineRow = {
  id: string;
  project_id: string;
  subcontractor_id: string;
  item_number: string;
  section_code: string | null;
  section_name: string | null;
  description: string;
  scheduled_value: number | null;
  quantity: number | null;
  unit: string | null;
  unit_cost: number | null;
  is_change_order: boolean;
  change_order_ref: string | null;
  verification_method: VerificationMethod;
  linked_task_wbs_codes: string[] | null;
  linked_commodity_ids: string[] | null;
  milestone_task_wbs_code: string | null;
  mapping_notes: string | null;
  mapping_confirmed_at: string | null;
  mapping_confirmed_by: string | null;
  sort_order: number | null;
  active: boolean;
  created_at: string | null;
};

export type SubPayAppRow = {
  id: string;
  project_id: string;
  subcontractor_id: string;
  app_number: number;
  app_date: string | null;
  period_start: string | null;
  period_end: string;
  retainage_pct: number | null;
  payment_terms_days: number | null;
  due_date: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_total: number | null;
  billed_previous: number | null;
  billed_this_period: number | null;
  billed_to_date: number | null;
  retainage_this_period: number | null;
  retainage_to_date: number | null;
  amount_due: number | null;
  approved_this_period: number | null;
  approved_retainage: number | null;
  approved_amount_due: number | null;
  status: SubPayAppStatus;
  lien_waiver_received: boolean;
  lien_waiver_amount: number | null;
  lien_waiver_through_date: string | null;
  source_document_path: string | null;
  entered_by: string | null;
  entered_at: string | null;
  cm_reviewed_by: string | null;
  cm_reviewed_at: string | null;
  cm_notes: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_notes: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string | null;
};

export type SubPayAppLineRow = {
  id: string;
  sub_pay_app_id: string;
  sub_sov_line_id: string | null;
  item_number: string;
  description: string;
  scheduled_value: number | null;
  from_previous: number | null;
  this_period: number | null;
  materials_stored: number | null;
  total_completed: number | null;
  pct_billed: number | null;
  balance_to_finish: number | null;
  retainage_amount: number | null;
  verified_pct: number | null;
  verified_amount: number | null;
  verification_source: string | null;
  verification_confidence: "high" | "medium" | "low" | "none" | null;
  verification_detail: string | null;
  variance_amount: number | null;
  variance_pct: number | null;
  flag_level: "ok" | "review" | "flag" | "unverifiable" | null;
  approved_this_period: number | null;
  cm_note: string | null;
  reviewer_note: string | null;
  sort_order: number | null;
  created_at: string | null;
};

export type SubPayAppCheckRow = {
  id: string;
  sub_pay_app_id: string;
  check_key: string;
  label: string;
  severity: "error" | "warning" | "info";
  status: "pass" | "warn" | "fail" | "skip";
  expected: number | null;
  actual: number | null;
  delta: number | null;
  message: string | null;
  line_item_number: string | null;
  ran_at: string | null;
};

export type SubBillingSummaryRow = {
  subcontractor_id: string;
  project_id: string | null;
  company_name: string;
  contract_value: number | null;
  retainage_pct: number | null;
  sov_total: number | null;
  sov_line_count: number | null;
  unmapped_lines: number | null;
  apps_received: number | null;
  billed_to_date: number | null;
  approved_to_date: number | null;
  paid_to_date: number | null;
  retainage_held: number | null;
  pct_approved: number | null;
};

type Tbl<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

export type SubBillingDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables" | "Views"> & {
    Tables: Database["public"]["Tables"] & {
      sub_sov_lines: Tbl<SubSovLineRow>;
      sub_pay_apps: Tbl<SubPayAppRow>;
      sub_pay_app_lines: Tbl<SubPayAppLineRow>;
      sub_pay_app_checks: Tbl<SubPayAppCheckRow>;
    };
    Views: Database["public"]["Views"] & {
      v_sub_billing_summary: {
        Row: SubBillingSummaryRow;
        Relationships: [];
      };
    };
  };
};

export type SubBillingClient = SupabaseClient<SubBillingDatabase>;
