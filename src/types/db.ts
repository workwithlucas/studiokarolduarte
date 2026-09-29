export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      appointment_addons: {
        Row: {
          addon_id: string
          appointment_id: string
          duration_delta_min: number
          price_delta_cents: number
        }
        Insert: {
          addon_id: string
          appointment_id: string
          duration_delta_min: number
          price_delta_cents: number
        }
        Update: {
          addon_id?: string
          appointment_id?: string
          duration_delta_min?: number
          price_delta_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "appointment_addons_addon_id_fkey"
            columns: ["addon_id"]
            isOneToOne: false
            referencedRelation: "service_addons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_addons_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          action: Database["public"]["Enums"]["service_action"]
          cancel_reason: string | null
          cancelled_at: string | null
          client_id: string
          client_package_id: string | null
          completed_at: string | null
          confirmed_at: string | null
          created_at: string
          duration_min: number
          ends_at: string
          id: string
          idempotency_key: string | null
          notes: string | null
          price_cents: number
          professional_id: string
          service_id: string
          source: Database["public"]["Enums"]["appointment_source"]
          starts_at: string
          status: Database["public"]["Enums"]["appointment_status"]
          updated_at: string
        }
        Insert: {
          action: Database["public"]["Enums"]["service_action"]
          cancel_reason?: string | null
          cancelled_at?: string | null
          client_id: string
          client_package_id?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          duration_min: number
          ends_at: string
          id?: string
          idempotency_key?: string | null
          notes?: string | null
          price_cents: number
          professional_id: string
          service_id: string
          source: Database["public"]["Enums"]["appointment_source"]
          starts_at: string
          status?: Database["public"]["Enums"]["appointment_status"]
          updated_at?: string
        }
        Update: {
          action?: Database["public"]["Enums"]["service_action"]
          cancel_reason?: string | null
          cancelled_at?: string | null
          client_id?: string
          client_package_id?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          duration_min?: number
          ends_at?: string
          id?: string
          idempotency_key?: string | null
          notes?: string | null
          price_cents?: number
          professional_id?: string
          service_id?: string
          source?: Database["public"]["Enums"]["appointment_source"]
          starts_at?: string
          status?: Database["public"]["Enums"]["appointment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_stats"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "appointments_client_package_id_fkey"
            columns: ["client_package_id"]
            isOneToOne: false
            referencedRelation: "client_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_client_package_id_fkey"
            columns: ["client_package_id"]
            isOneToOne: false
            referencedRelation: "v_client_packages"
            referencedColumns: ["client_package_id"]
          },
          {
            foreignKeyName: "appointments_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: string
          at: string
          entity: string
          entity_id: string | null
          id: number
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type: string
          at?: string
          entity: string
          entity_id?: string | null
          id?: never
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: string
          at?: string
          entity?: string
          entity_id?: string | null
          id?: never
        }
        Relationships: []
      }
      client_packages: {
        Row: {
          client_id: string
          expires_at: string
          id: string
          price_cents: number
          sessions_total: number
          sold_at: string
          template_id: string
        }
        Insert: {
          client_id: string
          expires_at: string
          id?: string
          price_cents: number
          sessions_total: number
          sold_at?: string
          template_id: string
        }
        Update: {
          client_id?: string
          expires_at?: string
          id?: string
          price_cents?: number
          sessions_total?: number
          sold_at?: string
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_packages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_packages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_stats"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_packages_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "package_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          archived: boolean
          birthday: string | null
          created_at: string
          external_code: string | null
          id: string
          name: string
          notes: string | null
          phone_e164: string | null
        }
        Insert: {
          archived?: boolean
          birthday?: string | null
          created_at?: string
          external_code?: string | null
          id?: string
          name: string
          notes?: string | null
          phone_e164?: string | null
        }
        Update: {
          archived?: boolean
          birthday?: string | null
          created_at?: string
          external_code?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone_e164?: string | null
        }
        Relationships: []
      }
      ledger_entries: {
        Row: {
          amount_cents: number
          appointment_id: string | null
          client_id: string
          client_package_id: string | null
          created_at: string
          description: string
          due_date: string
          id: string
          professional_id: string | null
          voided_at: string | null
        }
        Insert: {
          amount_cents: number
          appointment_id?: string | null
          client_id: string
          client_package_id?: string | null
          created_at?: string
          description: string
          due_date: string
          id?: string
          professional_id?: string | null
          voided_at?: string | null
        }
        Update: {
          amount_cents?: number
          appointment_id?: string | null
          client_id?: string
          client_package_id?: string | null
          created_at?: string
          description?: string
          due_date?: string
          id?: string
          professional_id?: string | null
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ledger_entries_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_entries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_entries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_stats"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "ledger_entries_client_package_id_fkey"
            columns: ["client_package_id"]
            isOneToOne: false
            referencedRelation: "client_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_entries_client_package_id_fkey"
            columns: ["client_package_id"]
            isOneToOne: false
            referencedRelation: "v_client_packages"
            referencedColumns: ["client_package_id"]
          },
          {
            foreignKeyName: "ledger_entries_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
        ]
      }
      package_templates: {
        Row: {
          active: boolean
          id: string
          name: string
          price_cents: number
          service_id: string
          sessions_total: number
          validity_days: number
        }
        Insert: {
          active?: boolean
          id?: string
          name: string
          price_cents: number
          service_id: string
          sessions_total: number
          validity_days: number
        }
        Update: {
          active?: boolean
          id?: string
          name?: string
          price_cents?: number
          service_id?: string
          sessions_total?: number
          validity_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "package_templates_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      professional_services: {
        Row: {
          professional_id: string
          service_id: string
        }
        Insert: {
          professional_id: string
          service_id: string
        }
        Update: {
          professional_id?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "professional_services_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "professional_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      professionals: {
        Row: {
          active: boolean
          color: string
          id: string
          name: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string | null
        }
        Insert: {
          active?: boolean
          color?: string
          id?: string
          name: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string | null
        }
        Update: {
          active?: boolean
          color?: string
          id?: string
          name?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string | null
        }
        Relationships: []
      }
      schedule_blocks: {
        Row: {
          ends_at: string
          id: string
          professional_id: string | null
          reason: string | null
          starts_at: string
        }
        Insert: {
          ends_at: string
          id?: string
          professional_id?: string | null
          reason?: string | null
          starts_at: string
        }
        Update: {
          ends_at?: string
          id?: string
          professional_id?: string | null
          reason?: string | null
          starts_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_blocks_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
        ]
      }
      service_addons: {
        Row: {
          active: boolean
          duration_delta_min: number
          id: string
          name: string
          price_delta_cents: number
          service_id: string
        }
        Insert: {
          active?: boolean
          duration_delta_min?: number
          id?: string
          name: string
          price_delta_cents: number
          service_id: string
        }
        Update: {
          active?: boolean
          duration_delta_min?: number
          id?: string
          name?: string
          price_delta_cents?: number
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_addons_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          active: boolean
          cash_price_cents: number | null
          category: Database["public"]["Enums"]["service_category"]
          duration_min: number
          id: string
          kind: Database["public"]["Enums"]["service_kind"]
          maintenance_duration_min: number | null
          maintenance_price_cents: number | null
          name: string
          price_cents: number
        }
        Insert: {
          active?: boolean
          cash_price_cents?: number | null
          category: Database["public"]["Enums"]["service_category"]
          duration_min: number
          id?: string
          kind?: Database["public"]["Enums"]["service_kind"]
          maintenance_duration_min?: number | null
          maintenance_price_cents?: number | null
          name: string
          price_cents: number
        }
        Update: {
          active?: boolean
          cash_price_cents?: number | null
          category?: Database["public"]["Enums"]["service_category"]
          duration_min?: number
          id?: string
          kind?: Database["public"]["Enums"]["service_kind"]
          maintenance_duration_min?: number | null
          maintenance_price_cents?: number | null
          name?: string
          price_cents?: number
        }
        Relationships: []
      }
      studio_settings: {
        Row: {
          key: string
          value: Json
        }
        Insert: {
          key: string
          value: Json
        }
        Update: {
          key?: string
          value?: Json
        }
        Relationships: []
      }
      working_hours: {
        Row: {
          end_time: string
          professional_id: string
          start_time: string
          weekday: number
        }
        Insert: {
          end_time: string
          professional_id: string
          start_time: string
          weekday: number
        }
        Update: {
          end_time?: string
          professional_id?: string
          start_time?: string
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "working_hours_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_client_packages: {
        Row: {
          client_id: string | null
          client_package_id: string | null
          expires_at: string | null
          remaining: number | null
          service_id: string | null
          sessions_total: number | null
          status: string | null
          template_name: string | null
          used: number | null
        }
        Relationships: [
          {
            foreignKeyName: "client_packages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_packages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_stats"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "package_templates_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      v_client_stats: {
        Row: {
          client_id: string | null
          days_since_last_visit: number | null
          last_visit_at: string | null
          needs_return: boolean | null
          next_appointment_at: string | null
          preferred_professional_id: string | null
          segment: string | null
          total_spent_cents: number | null
          visit_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "appointments_professional_id_fkey"
            columns: ["preferred_professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
        ]
      }
      v_professional_client_history: {
        Row: {
          client_id: string | null
          last_visit_at: string | null
          professional_id: string | null
          visits: number | null
        }
        Relationships: [
          {
            foreignKeyName: "appointments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_stats"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "appointments_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _actor_type: { Args: never; Returns: string }
      _audit: {
        Args: { p_action: string; p_entity: string; p_entity_id: string }
        Returns: undefined
      }
      _is_service: { Args: never; Returns: boolean }
      _is_system: { Args: never; Returns: boolean }
      _jwt_claims: { Args: never; Returns: Json }
      _lock_professional: {
        Args: { p_professional_id: string }
        Returns: undefined
      }
      _name_key: { Args: { p: string }; Returns: string }
      _name_similarity: { Args: { a: string; b: string }; Returns: number }
      _raise: {
        Args: { p_code: string; p_detail?: string }
        Returns: undefined
      }
      _require_owner: { Args: never; Returns: undefined }
      _require_staff: { Args: never; Returns: undefined }
      _service_quote: {
        Args: {
          p_action: Database["public"]["Enums"]["service_action"]
          p_addon_ids: string[]
          p_service_id: string
        }
        Returns: {
          duration_min: number
          price_cents: number
        }[]
      }
      _setting_int: { Args: { p_key: string }; Returns: number }
      _slot_error: {
        Args: {
          p_ends_at: string
          p_enforce_notice: boolean
          p_force?: boolean
          p_ignore_appointment_id: string
          p_professional_id: string
          p_starts_at: string
        }
        Returns: {
          code: string
          detail: string
        }[]
      }
      _slot_is_free: {
        Args: {
          p_ends_at: string
          p_enforce_notice: boolean
          p_force?: boolean
          p_ignore_appointment_id: string
          p_professional_id: string
          p_starts_at: string
        }
        Returns: undefined
      }
      check_invariants: {
        Args: never
        Returns: {
          code: string
          detail: string
          entity_id: string
        }[]
      }
      is_owner: { Args: never; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      normalize_phone: { Args: { p: string }; Returns: string }
      rpc_book_appointment: {
        Args: {
          p_action: Database["public"]["Enums"]["service_action"]
          p_addon_ids: string[]
          p_client_id: string
          p_client_package_id?: string
          p_force?: boolean
          p_idempotency_key: string
          p_notes: string
          p_professional_id: string
          p_service_id: string
          p_source: Database["public"]["Enums"]["appointment_source"]
          p_starts_at: string
        }
        Returns: string
      }
      rpc_cancel_appointment: {
        Args: { p_appointment_id: string; p_reason: string }
        Returns: undefined
      }
      rpc_complete_appointment: {
        Args: { p_actual_end?: string; p_appointment_id: string }
        Returns: undefined
      }
      rpc_confirm_appointment: {
        Args: { p_appointment_id: string }
        Returns: undefined
      }
      rpc_create_block: {
        Args: {
          p_allow_conflicts?: boolean
          p_ends_at: string
          p_professional_id: string
          p_reason: string
          p_starts_at: string
        }
        Returns: string
      }
      rpc_delete_block: { Args: { p_block_id: string }; Returns: undefined }
      rpc_find_client_by_phone: {
        Args: { p_phone: string }
        Returns: {
          archived: boolean
          birthday: string | null
          created_at: string
          external_code: string | null
          id: string
          name: string
          notes: string | null
          phone_e164: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "clients"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      rpc_get_availability: {
        Args: {
          p_action: Database["public"]["Enums"]["service_action"]
          p_addon_ids: string[]
          p_from: string
          p_professional_id: string
          p_service_id: string
          p_source?: Database["public"]["Enums"]["appointment_source"]
          p_to: string
        }
        Returns: {
          ends_at: string
          starts_at: string
        }[]
      }
      rpc_get_client_context: { Args: { p_client_id: string }; Returns: Json }
      rpc_mark_no_show: {
        Args: { p_appointment_id: string }
        Returns: undefined
      }
      rpc_reschedule_appointment: {
        Args: {
          p_appointment_id: string
          p_force?: boolean
          p_new_professional_id?: string
          p_new_starts_at: string
        }
        Returns: undefined
      }
      rpc_sell_package: {
        Args: { p_client_id: string; p_template_id: string }
        Returns: string
      }
      rpc_set_professional_services: {
        Args: { p_professional_id: string; p_service_ids: string[] }
        Returns: undefined
      }
      rpc_set_working_hours: {
        Args: { p_professional_id: string; p_rows: Json }
        Returns: undefined
      }
      rpc_suggest_professionals: {
        Args: { p_client_id: string; p_service_id: string }
        Returns: {
          color: string
          last_visit_at: string
          name: string
          professional_id: string
          visits: number
        }[]
      }
      rpc_upsert_addon: {
        Args: {
          p_active: boolean
          p_duration_delta_min: number
          p_id: string
          p_name: string
          p_price_delta_cents: number
          p_service_id: string
        }
        Returns: string
      }
      rpc_upsert_client: {
        Args: {
          p_birthday: string
          p_external_code: string
          p_name: string
          p_notes: string
          p_phone: string
        }
        Returns: string
      }
      rpc_upsert_package_template: {
        Args: {
          p_active: boolean
          p_id: string
          p_name: string
          p_price_cents: number
          p_service_id: string
          p_sessions_total: number
          p_validity_days: number
        }
        Returns: string
      }
      rpc_upsert_professional: {
        Args: {
          p_active: boolean
          p_color: string
          p_id: string
          p_name: string
        }
        Returns: string
      }
      rpc_upsert_service: {
        Args: {
          p_active: boolean
          p_cash_price_cents: number
          p_category: Database["public"]["Enums"]["service_category"]
          p_duration_min: number
          p_id: string
          p_kind: Database["public"]["Enums"]["service_kind"]
          p_maintenance_duration_min: number
          p_maintenance_price_cents: number
          p_name: string
          p_price_cents: number
        }
        Returns: string
      }
      rpc_void_package: {
        Args: { p_client_package_id: string }
        Returns: undefined
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      today_sp: { Args: never; Returns: string }
    }
    Enums: {
      app_role: "owner" | "professional"
      appointment_source: "staff" | "agent" | "public"
      appointment_status:
        | "scheduled"
        | "confirmed"
        | "completed"
        | "cancelled"
        | "no_show"
      service_action: "placement" | "maintenance" | "removal"
      service_category: "unhas" | "cilios" | "sobrancelhas" | "outros"
      service_kind: "standard" | "removal"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["owner", "professional"],
      appointment_source: ["staff", "agent", "public"],
      appointment_status: [
        "scheduled",
        "confirmed",
        "completed",
        "cancelled",
        "no_show",
      ],
      service_action: ["placement", "maintenance", "removal"],
      service_category: ["unhas", "cilios", "sobrancelhas", "outros"],
      service_kind: ["standard", "removal"],
    },
  },
} as const

