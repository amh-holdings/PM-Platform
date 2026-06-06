export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      billing_entries: {
        Row: {
          actual_amount: number | null
          afp_number: string | null
          billing_line_id: string
          cash_in_month: string | null
          created_at: string | null
          id: string
          notes: string | null
          paid_at: string | null
          pay_application_id: string | null
          period_month: string
          planned_amount: number | null
          retainage_amount: number | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string | null
          submitted_at: string | null
        }
        Insert: {
          actual_amount?: number | null
          afp_number?: string | null
          billing_line_id: string
          cash_in_month?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          paid_at?: string | null
          pay_application_id?: string | null
          period_month: string
          planned_amount?: number | null
          retainage_amount?: number | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
          submitted_at?: string | null
        }
        Update: {
          actual_amount?: number | null
          afp_number?: string | null
          billing_line_id?: string
          cash_in_month?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          paid_at?: string | null
          pay_application_id?: string | null
          period_month?: string
          planned_amount?: number | null
          retainage_amount?: number | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_entries_billing_line_id_fkey"
            columns: ["billing_line_id"]
            isOneToOne: false
            referencedRelation: "billing_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_lines: {
        Row: {
          change_order_id: string | null
          created_at: string | null
          description: string
          id: string
          item_number: string
          linked_task_wbs_codes: string[] | null
          notes: string | null
          project_id: string
          scheduled_value: number | null
          sort_order: number | null
          type: string | null
        }
        Insert: {
          change_order_id?: string | null
          created_at?: string | null
          description: string
          id?: string
          item_number: string
          linked_task_wbs_codes?: string[] | null
          notes?: string | null
          project_id: string
          scheduled_value?: number | null
          sort_order?: number | null
          type?: string | null
        }
        Update: {
          change_order_id?: string | null
          created_at?: string | null
          description?: string
          id?: string
          item_number?: string
          linked_task_wbs_codes?: string[] | null
          notes?: string | null
          project_id?: string
          scheduled_value?: number | null
          sort_order?: number | null
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_lines_change_order_id_fkey"
            columns: ["change_order_id"]
            isOneToOne: false
            referencedRelation: "change_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_lines_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      change_orders: {
        Row: {
          approved_at: string | null
          co_number: string
          co_value: number | null
          created_at: string | null
          description: string | null
          id: string
          notes: string | null
          project_id: string
          schedule_impact_days: number | null
          status: string | null
          submitted_at: string | null
        }
        Insert: {
          approved_at?: string | null
          co_number: string
          co_value?: number | null
          created_at?: string | null
          description?: string | null
          id?: string
          notes?: string | null
          project_id: string
          schedule_impact_days?: number | null
          status?: string | null
          submitted_at?: string | null
        }
        Update: {
          approved_at?: string | null
          co_number?: string
          co_value?: number | null
          created_at?: string | null
          description?: string | null
          id?: string
          notes?: string | null
          project_id?: string
          schedule_impact_days?: number | null
          status?: string | null
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "change_orders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_log: {
        Row: {
          comm_date: string | null
          comm_type: Database["public"]["Enums"]["comms_type"]
          created_at: string | null
          id: string
          logged_by_id: string | null
          notes: string
          participants: string | null
          project_id: string | null
          related_rfi_id: string | null
          related_wbs_sov_id: string | null
          subject: string | null
        }
        Insert: {
          comm_date?: string | null
          comm_type: Database["public"]["Enums"]["comms_type"]
          created_at?: string | null
          id?: string
          logged_by_id?: string | null
          notes: string
          participants?: string | null
          project_id?: string | null
          related_rfi_id?: string | null
          related_wbs_sov_id?: string | null
          subject?: string | null
        }
        Update: {
          comm_date?: string | null
          comm_type?: Database["public"]["Enums"]["comms_type"]
          created_at?: string | null
          id?: string
          logged_by_id?: string | null
          notes?: string
          participants?: string | null
          project_id?: string | null
          related_rfi_id?: string | null
          related_wbs_sov_id?: string | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comms_log_logged_by_id_fkey"
            columns: ["logged_by_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_log_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_log_related_rfi_id_fkey"
            columns: ["related_rfi_id"]
            isOneToOne: false
            referencedRelation: "rfis"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_log_related_wbs_sov_id_fkey"
            columns: ["related_wbs_sov_id"]
            isOneToOne: false
            referencedRelation: "wbs_sov"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_codes: {
        Row: {
          actual_cost: number | null
          code: string
          created_at: string | null
          description: string | null
          estimated_cost: number | null
          id: string
          is_change_order: boolean | null
          linked_task_wbs_codes: string[] | null
          name: string
          procurement_order_id: string | null
          project_id: string
          sort_order: number | null
          subcontractor_id: string | null
        }
        Insert: {
          actual_cost?: number | null
          code: string
          created_at?: string | null
          description?: string | null
          estimated_cost?: number | null
          id?: string
          is_change_order?: boolean | null
          linked_task_wbs_codes?: string[] | null
          name: string
          procurement_order_id?: string | null
          project_id: string
          sort_order?: number | null
          subcontractor_id?: string | null
        }
        Update: {
          actual_cost?: number | null
          code?: string
          created_at?: string | null
          description?: string | null
          estimated_cost?: number | null
          id?: string
          is_change_order?: boolean | null
          linked_task_wbs_codes?: string[] | null
          name?: string
          procurement_order_id?: string | null
          project_id?: string
          sort_order?: number | null
          subcontractor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_codes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_forecasts: {
        Row: {
          actual_amount: number | null
          cost_code_id: string
          created_at: string | null
          id: string
          notes: string | null
          period_month: string
          planned_amount: number | null
        }
        Insert: {
          actual_amount?: number | null
          cost_code_id: string
          created_at?: string | null
          id?: string
          notes?: string | null
          period_month: string
          planned_amount?: number | null
        }
        Update: {
          actual_amount?: number | null
          cost_code_id?: string
          created_at?: string | null
          id?: string
          notes?: string | null
          period_month?: string
          planned_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_forecasts_cost_code_id_fkey"
            columns: ["cost_code_id"]
            isOneToOne: false
            referencedRelation: "cost_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      dpr_delays: {
        Row: {
          cause_code: string
          created_at: string | null
          dpr_id: string
          hours_lost: number | null
          id: string
          impacted_schedule_task_id: string | null
          narrative: string | null
        }
        Insert: {
          cause_code: string
          created_at?: string | null
          dpr_id: string
          hours_lost?: number | null
          id?: string
          impacted_schedule_task_id?: string | null
          narrative?: string | null
        }
        Update: {
          cause_code?: string
          created_at?: string | null
          dpr_id?: string
          hours_lost?: number | null
          id?: string
          impacted_schedule_task_id?: string | null
          narrative?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dpr_delays_dpr_id_fkey"
            columns: ["dpr_id"]
            isOneToOne: false
            referencedRelation: "dprs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dpr_delays_impacted_schedule_task_id_fkey"
            columns: ["impacted_schedule_task_id"]
            isOneToOne: false
            referencedRelation: "schedule_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      dpr_deliveries: {
        Row: {
          created_at: string | null
          dpr_id: string
          id: string
          materials: string
          notes: string | null
          po_number: string | null
          procurement_order_id: string | null
          quantity: number | null
          unit_of_measure: string | null
          vendor_name: string | null
        }
        Insert: {
          created_at?: string | null
          dpr_id: string
          id?: string
          materials: string
          notes?: string | null
          po_number?: string | null
          procurement_order_id?: string | null
          quantity?: number | null
          unit_of_measure?: string | null
          vendor_name?: string | null
        }
        Update: {
          created_at?: string | null
          dpr_id?: string
          id?: string
          materials?: string
          notes?: string | null
          po_number?: string | null
          procurement_order_id?: string | null
          quantity?: number | null
          unit_of_measure?: string | null
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dpr_deliveries_dpr_id_fkey"
            columns: ["dpr_id"]
            isOneToOne: false
            referencedRelation: "dprs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dpr_deliveries_procurement_order_id_fkey"
            columns: ["procurement_order_id"]
            isOneToOne: false
            referencedRelation: "procurement_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      dpr_equipment: {
        Row: {
          created_at: string | null
          dpr_id: string
          equipment_name: string
          id: string
          notes: string | null
          on_rent: boolean | null
          quantity: number | null
          rental_company: string | null
        }
        Insert: {
          created_at?: string | null
          dpr_id: string
          equipment_name: string
          id?: string
          notes?: string | null
          on_rent?: boolean | null
          quantity?: number | null
          rental_company?: string | null
        }
        Update: {
          created_at?: string | null
          dpr_id?: string
          equipment_name?: string
          id?: string
          notes?: string | null
          on_rent?: boolean | null
          quantity?: number | null
          rental_company?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dpr_equipment_dpr_id_fkey"
            columns: ["dpr_id"]
            isOneToOne: false
            referencedRelation: "dprs"
            referencedColumns: ["id"]
          },
        ]
      }
      dpr_manpower: {
        Row: {
          created_at: string | null
          dpr_id: string
          headcount: number
          id: string
          notes: string | null
          ot_hours: number
          regular_hours: number
          subcontractor_id: string | null
          trade: string | null
        }
        Insert: {
          created_at?: string | null
          dpr_id: string
          headcount?: number
          id?: string
          notes?: string | null
          ot_hours?: number
          regular_hours?: number
          subcontractor_id?: string | null
          trade?: string | null
        }
        Update: {
          created_at?: string | null
          dpr_id?: string
          headcount?: number
          id?: string
          notes?: string | null
          ot_hours?: number
          regular_hours?: number
          subcontractor_id?: string | null
          trade?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dpr_manpower_dpr_id_fkey"
            columns: ["dpr_id"]
            isOneToOne: false
            referencedRelation: "dprs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dpr_manpower_subcontractor_id_fkey"
            columns: ["subcontractor_id"]
            isOneToOne: false
            referencedRelation: "subcontractors"
            referencedColumns: ["id"]
          },
        ]
      }
      dpr_quantities: {
        Row: {
          dpr_id: string | null
          id: string
          location_on_site: string | null
          notes: string | null
          quantity_installed: number | null
          wbs_sov_id: string | null
        }
        Insert: {
          dpr_id?: string | null
          id?: string
          location_on_site?: string | null
          notes?: string | null
          quantity_installed?: number | null
          wbs_sov_id?: string | null
        }
        Update: {
          dpr_id?: string | null
          id?: string
          location_on_site?: string | null
          notes?: string | null
          quantity_installed?: number | null
          wbs_sov_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dpr_quantities_dpr_id_fkey"
            columns: ["dpr_id"]
            isOneToOne: false
            referencedRelation: "dprs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dpr_quantities_wbs_sov_id_fkey"
            columns: ["wbs_sov_id"]
            isOneToOne: false
            referencedRelation: "wbs_sov"
            referencedColumns: ["id"]
          },
        ]
      }
      dpr_task_updates: {
        Row: {
          created_at: string | null
          dpr_id: string
          id: string
          installed_quantity: number | null
          new_pct_complete: number | null
          new_status: string | null
          notes: string | null
          previous_pct_complete: number | null
          previous_status: string | null
          schedule_task_id: string
        }
        Insert: {
          created_at?: string | null
          dpr_id: string
          id?: string
          installed_quantity?: number | null
          new_pct_complete?: number | null
          new_status?: string | null
          notes?: string | null
          previous_pct_complete?: number | null
          previous_status?: string | null
          schedule_task_id: string
        }
        Update: {
          created_at?: string | null
          dpr_id?: string
          id?: string
          installed_quantity?: number | null
          new_pct_complete?: number | null
          new_status?: string | null
          notes?: string | null
          previous_pct_complete?: number | null
          previous_status?: string | null
          schedule_task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dpr_task_updates_dpr_id_fkey"
            columns: ["dpr_id"]
            isOneToOne: false
            referencedRelation: "dprs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dpr_task_updates_schedule_task_id_fkey"
            columns: ["schedule_task_id"]
            isOneToOne: false
            referencedRelation: "schedule_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      dprs: {
        Row: {
          created_at: string | null
          crew_count: number | null
          delays: Json | null
          deliveries: Json | null
          equipment_on_site: Json | null
          foreman_id: string | null
          id: string
          near_miss: boolean | null
          project_id: string | null
          qc_rep_name: string | null
          report_date: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          safety_incident: boolean | null
          safety_narrative: string | null
          status: Database["public"]["Enums"]["dpr_status"] | null
          subcontractor_id: string | null
          submitted_at: string | null
          temp_high: number | null
          temp_low: number | null
          toolbox_attendees: number | null
          toolbox_topic: string | null
          total_man_hours: number | null
          weather_conditions: string | null
          work_narrative: string | null
        }
        Insert: {
          created_at?: string | null
          crew_count?: number | null
          delays?: Json | null
          deliveries?: Json | null
          equipment_on_site?: Json | null
          foreman_id?: string | null
          id?: string
          near_miss?: boolean | null
          project_id?: string | null
          qc_rep_name?: string | null
          report_date: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          safety_incident?: boolean | null
          safety_narrative?: string | null
          status?: Database["public"]["Enums"]["dpr_status"] | null
          subcontractor_id?: string | null
          submitted_at?: string | null
          temp_high?: number | null
          temp_low?: number | null
          toolbox_attendees?: number | null
          toolbox_topic?: string | null
          total_man_hours?: number | null
          weather_conditions?: string | null
          work_narrative?: string | null
        }
        Update: {
          created_at?: string | null
          crew_count?: number | null
          delays?: Json | null
          deliveries?: Json | null
          equipment_on_site?: Json | null
          foreman_id?: string | null
          id?: string
          near_miss?: boolean | null
          project_id?: string | null
          qc_rep_name?: string | null
          report_date?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          safety_incident?: boolean | null
          safety_narrative?: string | null
          status?: Database["public"]["Enums"]["dpr_status"] | null
          subcontractor_id?: string | null
          submitted_at?: string | null
          temp_high?: number | null
          temp_low?: number | null
          toolbox_attendees?: number | null
          toolbox_topic?: string | null
          total_man_hours?: number | null
          weather_conditions?: string | null
          work_narrative?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dprs_foreman_id_fkey"
            columns: ["foreman_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dprs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dprs_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dprs_subcontractor_id_fkey"
            columns: ["subcontractor_id"]
            isOneToOne: false
            referencedRelation: "subcontractors"
            referencedColumns: ["id"]
          },
        ]
      }
      pay_application_lines: {
        Row: {
          balance_to_finish: number | null
          billing_line_id: string | null
          created_at: string | null
          description: string
          id: string
          item_number: string
          materials_stored: number | null
          pay_application_id: string
          pct_complete: number | null
          retainage_amount: number | null
          scheduled_value: number | null
          sort_order: number | null
          total_completed_and_stored: number | null
          work_completed_previous: number | null
          work_completed_this_period: number | null
        }
        Insert: {
          balance_to_finish?: number | null
          billing_line_id?: string | null
          created_at?: string | null
          description: string
          id?: string
          item_number: string
          materials_stored?: number | null
          pay_application_id: string
          pct_complete?: number | null
          retainage_amount?: number | null
          scheduled_value?: number | null
          sort_order?: number | null
          total_completed_and_stored?: number | null
          work_completed_previous?: number | null
          work_completed_this_period?: number | null
        }
        Update: {
          balance_to_finish?: number | null
          billing_line_id?: string | null
          created_at?: string | null
          description?: string
          id?: string
          item_number?: string
          materials_stored?: number | null
          pay_application_id?: string
          pct_complete?: number | null
          retainage_amount?: number | null
          scheduled_value?: number | null
          sort_order?: number | null
          total_completed_and_stored?: number | null
          work_completed_previous?: number | null
          work_completed_this_period?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pay_application_lines_pay_application_id_fkey"
            columns: ["pay_application_id"]
            isOneToOne: false
            referencedRelation: "pay_applications"
            referencedColumns: ["id"]
          },
        ]
      }
      pay_applications: {
        Row: {
          amount_due: number | null
          app_number: string
          approved_at: string | null
          approved_by_owner: string | null
          created_at: string | null
          id: string
          notes: string | null
          paid_at: string | null
          pdf_storage_path: string | null
          period_end: string
          period_start: string
          previous_billings: number | null
          project_id: string
          status: string | null
          submitted_at: string | null
          submitted_by: string | null
          total_completed: number | null
          total_retainage: number | null
        }
        Insert: {
          amount_due?: number | null
          app_number: string
          approved_at?: string | null
          approved_by_owner?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          paid_at?: string | null
          pdf_storage_path?: string | null
          period_end: string
          period_start: string
          previous_billings?: number | null
          project_id: string
          status?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
          total_completed?: number | null
          total_retainage?: number | null
        }
        Update: {
          amount_due?: number | null
          app_number?: string
          approved_at?: string | null
          approved_by_owner?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          paid_at?: string | null
          pdf_storage_path?: string | null
          period_end?: string
          period_start?: string
          previous_billings?: number | null
          project_id?: string
          status?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
          total_completed?: number | null
          total_retainage?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pay_applications_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      photos: {
        Row: {
          caption: string | null
          created_at: string | null
          dpr_id: string | null
          id: string
          photo_type: Database["public"]["Enums"]["photo_type"] | null
          project_id: string | null
          storage_path: string
          taken_at: string | null
          uploaded_by_id: string | null
          wbs_sov_id: string | null
        }
        Insert: {
          caption?: string | null
          created_at?: string | null
          dpr_id?: string | null
          id?: string
          photo_type?: Database["public"]["Enums"]["photo_type"] | null
          project_id?: string | null
          storage_path: string
          taken_at?: string | null
          uploaded_by_id?: string | null
          wbs_sov_id?: string | null
        }
        Update: {
          caption?: string | null
          created_at?: string | null
          dpr_id?: string | null
          id?: string
          photo_type?: Database["public"]["Enums"]["photo_type"] | null
          project_id?: string | null
          storage_path?: string
          taken_at?: string | null
          uploaded_by_id?: string | null
          wbs_sov_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "photos_dpr_id_fkey"
            columns: ["dpr_id"]
            isOneToOne: false
            referencedRelation: "dprs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_uploaded_by_id_fkey"
            columns: ["uploaded_by_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_wbs_sov_id_fkey"
            columns: ["wbs_sov_id"]
            isOneToOne: false
            referencedRelation: "wbs_sov"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean | null
          created_at: string | null
          email: string
          full_name: string | null
          id: string
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          subcontractor_id: string | null
        }
        Insert: {
          active?: boolean | null
          created_at?: string | null
          email: string
          full_name?: string | null
          id: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          subcontractor_id?: string | null
        }
        Update: {
          active?: boolean | null
          created_at?: string | null
          email?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          subcontractor_id?: string | null
        }
        Relationships: []
      }
      project_documents: {
        Row: {
          category: Database["public"]["Enums"]["document_category"]
          description: string | null
          extracted_text: string | null
          file_name: string
          id: string
          mime_type: string | null
          pages_count: number | null
          project_id: string
          size_bytes: number | null
          storage_path: string
          text_error: string | null
          text_status: Database["public"]["Enums"]["document_text_status"]
          uploaded_at: string | null
          uploaded_by_id: string | null
        }
        Insert: {
          category?: Database["public"]["Enums"]["document_category"]
          description?: string | null
          extracted_text?: string | null
          file_name: string
          id?: string
          mime_type?: string | null
          pages_count?: number | null
          project_id: string
          size_bytes?: number | null
          storage_path: string
          text_error?: string | null
          text_status?: Database["public"]["Enums"]["document_text_status"]
          uploaded_at?: string | null
          uploaded_by_id?: string | null
        }
        Update: {
          category?: Database["public"]["Enums"]["document_category"]
          description?: string | null
          extracted_text?: string | null
          file_name?: string
          id?: string
          mime_type?: string | null
          pages_count?: number | null
          project_id?: string
          size_bytes?: number | null
          storage_path?: string
          text_error?: string | null
          text_status?: Database["public"]["Enums"]["document_text_status"]
          uploaded_at?: string | null
          uploaded_by_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_documents_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_documents_uploaded_by_id_fkey"
            columns: ["uploaded_by_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      procurement_orders: {
        Row: {
          actual_delivery_date: string | null
          created_at: string | null
          description: string | null
          document_id: string | null
          expected_delivery_date: string | null
          id: string
          notes: string | null
          ordered_date: string | null
          payment_terms_summary: string | null
          po_number: string | null
          project_id: string
          status: string | null
          total_value: number | null
          vendor_name: string
        }
        Insert: {
          actual_delivery_date?: string | null
          created_at?: string | null
          description?: string | null
          document_id?: string | null
          expected_delivery_date?: string | null
          id?: string
          notes?: string | null
          ordered_date?: string | null
          payment_terms_summary?: string | null
          po_number?: string | null
          project_id: string
          status?: string | null
          total_value?: number | null
          vendor_name: string
        }
        Update: {
          actual_delivery_date?: string | null
          created_at?: string | null
          description?: string | null
          document_id?: string | null
          expected_delivery_date?: string | null
          id?: string
          notes?: string | null
          ordered_date?: string | null
          payment_terms_summary?: string | null
          po_number?: string | null
          project_id?: string
          status?: string | null
          total_value?: number | null
          vendor_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "procurement_orders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      procurement_payments: {
        Row: {
          amount: number | null
          created_at: string | null
          expected_date: string | null
          id: string
          milestone_name: string
          notes: string | null
          paid_amount: number | null
          paid_at: string | null
          pct_of_total: number | null
          procurement_order_id: string
          sort_order: number | null
          trigger_event: string | null
        }
        Insert: {
          amount?: number | null
          created_at?: string | null
          expected_date?: string | null
          id?: string
          milestone_name: string
          notes?: string | null
          paid_amount?: number | null
          paid_at?: string | null
          pct_of_total?: number | null
          procurement_order_id: string
          sort_order?: number | null
          trigger_event?: string | null
        }
        Update: {
          amount?: number | null
          created_at?: string | null
          expected_date?: string | null
          id?: string
          milestone_name?: string
          notes?: string | null
          paid_amount?: number | null
          paid_at?: string | null
          pct_of_total?: number | null
          procurement_order_id?: string
          sort_order?: number | null
          trigger_event?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "procurement_payments_procurement_order_id_fkey"
            columns: ["procurement_order_id"]
            isOneToOne: false
            referencedRelation: "procurement_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          ahc_pm_id: string | null
          ahc_super_id: string | null
          client: string | null
          cod_date: string | null
          contract_value: number | null
          created_at: string | null
          id: string
          name: string
          ntp_date: string | null
          owner_payment_terms_days: number | null
          retainage_pct_default: number | null
          retainage_release_event: string | null
          status: string | null
          zip_code: string | null
        }
        Insert: {
          ahc_pm_id?: string | null
          ahc_super_id?: string | null
          client?: string | null
          cod_date?: string | null
          contract_value?: number | null
          created_at?: string | null
          id?: string
          name: string
          ntp_date?: string | null
          owner_payment_terms_days?: number | null
          retainage_pct_default?: number | null
          retainage_release_event?: string | null
          status?: string | null
          zip_code?: string | null
        }
        Update: {
          ahc_pm_id?: string | null
          ahc_super_id?: string | null
          client?: string | null
          cod_date?: string | null
          contract_value?: number | null
          created_at?: string | null
          id?: string
          name?: string
          ntp_date?: string | null
          owner_payment_terms_days?: number | null
          retainage_pct_default?: number | null
          retainage_release_event?: string | null
          status?: string | null
          zip_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_ahc_pm_id_fkey"
            columns: ["ahc_pm_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_ahc_super_id_fkey"
            columns: ["ahc_super_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rfis: {
        Row: {
          created_at: string | null
          date_answered: string | null
          date_issued: string | null
          date_needed: string | null
          id: string
          originator_id: string | null
          project_id: string | null
          question: string
          recipient_id: string | null
          response: string | null
          rfi_number: string | null
          status: Database["public"]["Enums"]["rfi_status"] | null
          wbs_sov_id: string | null
        }
        Insert: {
          created_at?: string | null
          date_answered?: string | null
          date_issued?: string | null
          date_needed?: string | null
          id?: string
          originator_id?: string | null
          project_id?: string | null
          question: string
          recipient_id?: string | null
          response?: string | null
          rfi_number?: string | null
          status?: Database["public"]["Enums"]["rfi_status"] | null
          wbs_sov_id?: string | null
        }
        Update: {
          created_at?: string | null
          date_answered?: string | null
          date_issued?: string | null
          date_needed?: string | null
          id?: string
          originator_id?: string | null
          project_id?: string | null
          question?: string
          recipient_id?: string | null
          response?: string | null
          rfi_number?: string | null
          status?: Database["public"]["Enums"]["rfi_status"] | null
          wbs_sov_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rfis_originator_id_fkey"
            columns: ["originator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rfis_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rfis_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rfis_wbs_sov_id_fkey"
            columns: ["wbs_sov_id"]
            isOneToOne: false
            referencedRelation: "wbs_sov"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_tasks: {
        Row: {
          assigned_to: string | null
          created_at: string | null
          description: string | null
          duration_days: number | null
          end_date: string | null
          id: string
          installed_quantity: number | null
          is_at_risk: boolean | null
          is_internal: boolean | null
          last_dpr_at: string | null
          level_code: number | null
          non_ahc_delay: boolean | null
          parent_wbs_code: string | null
          pct_complete: number | null
          phase: string | null
          predecessors: string | null
          project_id: string
          sort_order: number | null
          source_row_id: string | null
          start_date: string | null
          status: string | null
          status_source: string | null
          target_quantity: number | null
          task_name: string
          unit_of_measure: string | null
          wbs_code: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string | null
          description?: string | null
          duration_days?: number | null
          end_date?: string | null
          id?: string
          installed_quantity?: number | null
          is_at_risk?: boolean | null
          is_internal?: boolean | null
          last_dpr_at?: string | null
          level_code?: number | null
          non_ahc_delay?: boolean | null
          parent_wbs_code?: string | null
          pct_complete?: number | null
          phase?: string | null
          predecessors?: string | null
          project_id: string
          sort_order?: number | null
          source_row_id?: string | null
          start_date?: string | null
          status?: string | null
          status_source?: string | null
          target_quantity?: number | null
          task_name: string
          unit_of_measure?: string | null
          wbs_code: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string | null
          description?: string | null
          duration_days?: number | null
          end_date?: string | null
          id?: string
          installed_quantity?: number | null
          is_at_risk?: boolean | null
          is_internal?: boolean | null
          last_dpr_at?: string | null
          level_code?: number | null
          non_ahc_delay?: boolean | null
          parent_wbs_code?: string | null
          pct_complete?: number | null
          phase?: string | null
          predecessors?: string | null
          project_id?: string
          sort_order?: number | null
          source_row_id?: string | null
          start_date?: string | null
          status?: string | null
          status_source?: string | null
          target_quantity?: number | null
          task_name?: string
          unit_of_measure?: string | null
          wbs_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      subcontractors: {
        Row: {
          active: boolean | null
          coi_status: string | null
          company_name: string
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          contract_value: number | null
          created_at: string | null
          id: string
          payment_terms: string | null
          payment_terms_days: number | null
          project_id: string | null
          retainage_pct: number | null
          trade: string | null
          w9_status: string | null
        }
        Insert: {
          active?: boolean | null
          coi_status?: string | null
          company_name: string
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          contract_value?: number | null
          created_at?: string | null
          id?: string
          payment_terms?: string | null
          payment_terms_days?: number | null
          project_id?: string | null
          retainage_pct?: number | null
          trade?: string | null
          w9_status?: string | null
        }
        Update: {
          active?: boolean | null
          coi_status?: string | null
          company_name?: string
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          contract_value?: number | null
          created_at?: string | null
          id?: string
          payment_terms?: string | null
          payment_terms_days?: number | null
          project_id?: string | null
          retainage_pct?: number | null
          trade?: string | null
          w9_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subcontractors_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      submittals: {
        Row: {
          created_at: string | null
          file_url: string | null
          id: string
          item_description: string
          manufacturer: string | null
          notes: string | null
          project_id: string | null
          reviewed_date: string | null
          spec_section: string | null
          status: Database["public"]["Enums"]["submittal_status"] | null
          submitted_by_id: string | null
          submitted_date: string | null
        }
        Insert: {
          created_at?: string | null
          file_url?: string | null
          id?: string
          item_description: string
          manufacturer?: string | null
          notes?: string | null
          project_id?: string | null
          reviewed_date?: string | null
          spec_section?: string | null
          status?: Database["public"]["Enums"]["submittal_status"] | null
          submitted_by_id?: string | null
          submitted_date?: string | null
        }
        Update: {
          created_at?: string | null
          file_url?: string | null
          id?: string
          item_description?: string
          manufacturer?: string | null
          notes?: string | null
          project_id?: string | null
          reviewed_date?: string | null
          spec_section?: string | null
          status?: Database["public"]["Enums"]["submittal_status"] | null
          submitted_by_id?: string | null
          submitted_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "submittals_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submittals_submitted_by_id_fkey"
            columns: ["submitted_by_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      wbs_sov: {
        Row: {
          actual_finish: string | null
          actual_start: string | null
          baseline_finish: string | null
          baseline_start: string | null
          billed_to_date: number | null
          contract_value: number | null
          created_at: string | null
          description: string
          float_days: number | null
          forecast_finish: string | null
          forecast_start: string | null
          id: string
          is_critical_path: boolean | null
          pct_complete_ahc: number | null
          pct_complete_sub: number | null
          project_id: string | null
          quantity: number | null
          retainage_pct: number | null
          subcontractor_id: string | null
          trade: string | null
          unit: string | null
          unit_cost: number | null
          wbs_code: string
        }
        Insert: {
          actual_finish?: string | null
          actual_start?: string | null
          baseline_finish?: string | null
          baseline_start?: string | null
          billed_to_date?: number | null
          contract_value?: number | null
          created_at?: string | null
          description: string
          float_days?: number | null
          forecast_finish?: string | null
          forecast_start?: string | null
          id?: string
          is_critical_path?: boolean | null
          pct_complete_ahc?: number | null
          pct_complete_sub?: number | null
          project_id?: string | null
          quantity?: number | null
          retainage_pct?: number | null
          subcontractor_id?: string | null
          trade?: string | null
          unit?: string | null
          unit_cost?: number | null
          wbs_code: string
        }
        Update: {
          actual_finish?: string | null
          actual_start?: string | null
          baseline_finish?: string | null
          baseline_start?: string | null
          billed_to_date?: number | null
          contract_value?: number | null
          created_at?: string | null
          description?: string
          float_days?: number | null
          forecast_finish?: string | null
          forecast_start?: string | null
          id?: string
          is_critical_path?: boolean | null
          pct_complete_ahc?: number | null
          pct_complete_sub?: number | null
          project_id?: string | null
          quantity?: number | null
          retainage_pct?: number | null
          subcontractor_id?: string | null
          trade?: string | null
          unit?: string | null
          unit_cost?: number | null
          wbs_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "wbs_sov_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wbs_sov_subcontractor_id_fkey"
            columns: ["subcontractor_id"]
            isOneToOne: false
            referencedRelation: "subcontractors"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_billing_line_totals: {
        Row: {
          billing_line_id: string | null
          project_id: string | null
          item_number: string | null
          scheduled_value: number | null
          total_planned: number | null
          total_billed: number | null
          total_retainage: number | null
          remaining_to_bill: number | null
        }
        Relationships: []
      }
      v_project_billing_summary: {
        Row: {
          project_id: string | null
          total_scheduled: number | null
          total_billed: number | null
          total_retainage: number | null
          future_planned: number | null
        }
        Relationships: []
      }
      v_cost_code_totals: {
        Row: {
          cost_code_id: string | null
          project_id: string | null
          code: string | null
          estimated_cost: number | null
          total_planned: number | null
          total_actual: number | null
          remaining_budget: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      comms_type:
        | "phone"
        | "email"
        | "meeting"
        | "site_visit"
        | "text"
        | "other"
      document_category:
        | "prime_contract"
        | "amendment"
        | "exhibit"
        | "subcontract"
        | "drawing"
        | "spec"
        | "submittal"
        | "rfi"
        | "daily_log"
        | "email"
        | "other"
      document_text_status:
        | "pending"
        | "processing"
        | "ready"
        | "failed"
        | "skipped"
      dpr_status: "draft" | "submitted" | "approved" | "returned"
      photo_type: "progress" | "safety" | "delivery" | "issue" | "eod" | "other"
      rfi_status: "open" | "answered" | "closed"
      submittal_status:
        | "pending"
        | "approved"
        | "approved_as_noted"
        | "revise_resubmit"
        | "rejected"
      user_role:
        | "phil"
        | "zarina"
        | "ahc_super"
        | "sub_pm"
        | "sub_foreman"
        | "owner"
        | "counsel"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      comms_type: ["phone", "email", "meeting", "site_visit", "text", "other"],
      document_category: [
        "prime_contract",
        "amendment",
        "exhibit",
        "subcontract",
        "drawing",
        "spec",
        "submittal",
        "rfi",
        "daily_log",
        "email",
        "other",
      ],
      document_text_status: [
        "pending",
        "processing",
        "ready",
        "failed",
        "skipped",
      ],
      dpr_status: ["draft", "submitted", "approved", "returned"],
      photo_type: ["progress", "safety", "delivery", "issue", "eod", "other"],
      rfi_status: ["open", "answered", "closed"],
      submittal_status: [
        "pending",
        "approved",
        "approved_as_noted",
        "revise_resubmit",
        "rejected",
      ],
      user_role: [
        "phil",
        "zarina",
        "ahc_super",
        "sub_pm",
        "sub_foreman",
        "owner",
        "counsel",
      ],
    },
  },
} as const
