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
      [_ in never]: never
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
