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
      account_settlements: {
        Row: {
          client_id: string
          created_at: string
          request_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          request_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_settlements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "_v_client_credit"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "account_settlements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_settlements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_account"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "account_settlements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_directory"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "account_settlements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_stats"
            referencedColumns: ["client_id"]
          },
        ]
      }
      agent_decisions: {
        Row: {
          action: string
          attempts: number
          conversation_id: string | null
          decided_at: string
          draft_text: string | null
          error_text: string | null
          id: string
          inbound_at: string | null
          live_since: string | null
          max_age_minutes: number | null
          message_id: string
          phone_key: string | null
          reason: string | null
        }
        Insert: {
          action: string
          attempts?: number
          conversation_id?: string | null
          decided_at?: string
          draft_text?: string | null
          error_text?: string | null
          id?: string
          inbound_at?: string | null
          live_since?: string | null
          max_age_minutes?: number | null
          message_id: string
          phone_key?: string | null
          reason?: string | null
        }
        Update: {
          action?: string
          attempts?: number
          conversation_id?: string | null
          decided_at?: string
          draft_text?: string | null
          error_text?: string | null
          id?: string
          inbound_at?: string | null
          live_since?: string | null
          max_age_minutes?: number | null
          message_id?: string
          phone_key?: string | null
          reason?: string | null
        }
        Relationships: []
      }
      agent_settings: {
        Row: {
          breaker_max_sends: number
          breaker_window_minutes: number
          id: boolean
          live_since: string | null
          max_inbound_age_minutes: number
          off_since: string | null
        }
        Insert: {
          breaker_max_sends?: number
          breaker_window_minutes?: number
          id?: boolean
          live_since?: string | null
          max_inbound_age_minutes?: number
          off_since?: string | null
        }
        Update: {
          breaker_max_sends?: number
          breaker_window_minutes?: number
          id?: boolean
          live_since?: string | null
          max_inbound_age_minutes?: number
          off_since?: string | null
        }
        Relationships: []
      }
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
      appointment_reschedules: {
        Row: {
          appointment_id: string
          created_at: string
          notified_at: string | null
          notify: boolean
          request_id: string
        }
        Insert: {
          appointment_id: string
          created_at?: string
          notified_at?: string | null
          notify?: boolean
          request_id: string
        }
        Update: {
          appointment_id?: string
          created_at?: string
          notified_at?: string | null
          notify?: boolean
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointment_reschedules_appointment_id_fkey"
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
            referencedRelation: "_v_client_credit"
            referencedColumns: ["client_id"]
          },
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
            referencedRelation: "v_client_account"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "appointments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_directory"
            referencedColumns: ["client_id"]
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
          detail: Json | null
          entity: string
          entity_id: string | null
          id: number
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type: string
          at?: string
          detail?: Json | null
          entity: string
          entity_id?: string | null
          id?: never
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: string
          at?: string
          detail?: Json | null
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
            referencedRelation: "_v_client_credit"
            referencedColumns: ["client_id"]
          },
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
            referencedRelation: "v_client_account"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_packages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_directory"
            referencedColumns: ["client_id"]
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
          phone_key: string | null
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
          phone_key?: string | null
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
          phone_key?: string | null
        }
        Relationships: []
      }
      commission_rules: {
        Row: {
          category: Database["public"]["Enums"]["service_category"] | null
          id: string
          percent: number
          professional_id: string
        }
        Insert: {
          category?: Database["public"]["Enums"]["service_category"] | null
          id?: string
          percent: number
          professional_id: string
        }
        Update: {
          category?: Database["public"]["Enums"]["service_category"] | null
          id?: string
          percent?: number
          professional_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "commission_rules_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "professionals"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_entries: {
        Row: {
          amount_cents: number
          appointment_id: string | null
          category: string | null
          client_id: string | null
          client_package_id: string | null
          commission_base_cents: number | null
          commission_cents: number | null
          commission_percent: number | null
          created_at: string
          description: string
          discount_cents: number
          due_date: string
          entry_type: string
          final_cents: number | null
          id: string
          import_key: string | null
          kind: Database["public"]["Enums"]["entry_kind"]
          note: string | null
          professional_id: string | null
          studio_cents: number | null
          voided_at: string | null
        }
        Insert: {
          amount_cents: number
          appointment_id?: string | null
          category?: string | null
          client_id?: string | null
          client_package_id?: string | null
          commission_base_cents?: number | null
          commission_cents?: number | null
          commission_percent?: number | null
          created_at?: string
          description: string
          discount_cents?: number
          due_date: string
          entry_type?: string
          final_cents?: number | null
          id?: string
          import_key?: string | null
          kind?: Database["public"]["Enums"]["entry_kind"]
          note?: string | null
          professional_id?: string | null
          studio_cents?: number | null
          voided_at?: string | null
        }
        Update: {
          amount_cents?: number
          appointment_id?: string | null
          category?: string | null
          client_id?: string | null
          client_package_id?: string | null
          commission_base_cents?: number | null
          commission_cents?: number | null
          commission_percent?: number | null
          created_at?: string
          description?: string
          discount_cents?: number
          due_date?: string
          entry_type?: string
          final_cents?: number | null
          id?: string
          import_key?: string | null
          kind?: Database["public"]["Enums"]["entry_kind"]
          note?: string | null
          professional_id?: string | null
          studio_cents?: number | null
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
            referencedRelation: "_v_client_credit"
            referencedColumns: ["client_id"]
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
            referencedRelation: "v_client_account"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "ledger_entries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_directory"
            referencedColumns: ["client_id"]
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
      ledger_payments: {
        Row: {
          amount_cents: number
          created_at: string
          entry_id: string
          id: string
          method: Database["public"]["Enums"]["pay_method"]
          note: string | null
          paid_at: string
          request_id: string | null
          reversed_at: string | null
          settlement_id: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string
          entry_id: string
          id?: string
          method: Database["public"]["Enums"]["pay_method"]
          note?: string | null
          paid_at?: string
          request_id?: string | null
          reversed_at?: string | null
          settlement_id?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string
          entry_id?: string
          id?: string
          method?: Database["public"]["Enums"]["pay_method"]
          note?: string | null
          paid_at?: string
          request_id?: string | null
          reversed_at?: string | null
          settlement_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ledger_payments_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "ledger_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_payments_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "v_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_payments_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "account_settlements"
            referencedColumns: ["request_id"]
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
          forced: boolean
          id: string
          professional_id: string | null
          reason: string | null
          starts_at: string
        }
        Insert: {
          ends_at: string
          forced?: boolean
          id?: string
          professional_id?: string | null
          reason?: string | null
          starts_at: string
        }
        Update: {
          ends_at?: string
          forced?: boolean
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
      wa_confirmations: {
        Row: {
          appointment_id: string
          message_id: string | null
          sent_at: string
        }
        Insert: {
          appointment_id: string
          message_id?: string | null
          sent_at?: string
        }
        Update: {
          appointment_id?: string
          message_id?: string | null
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wa_confirmations_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: true
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
        ]
      }
      wa_conversations: {
        Row: {
          attention_at: string | null
          attention_reason: string | null
          audio_failures: number
          away_sent_at: string | null
          client_id: string | null
          created_at: string
          failed_runs: number
          human_until: string | null
          id: string
          known_client_ids: string[]
          last_inbound_at: string | null
          last_outbound_at: string | null
          lease_until: string | null
          mode: string
          needs_attention: boolean
          pending_action: Json | null
          pending_since: string | null
          phone_e164: string
          phone_key: string | null
        }
        Insert: {
          attention_at?: string | null
          attention_reason?: string | null
          audio_failures?: number
          away_sent_at?: string | null
          client_id?: string | null
          created_at?: string
          failed_runs?: number
          human_until?: string | null
          id?: string
          known_client_ids?: string[]
          last_inbound_at?: string | null
          last_outbound_at?: string | null
          lease_until?: string | null
          mode?: string
          needs_attention?: boolean
          pending_action?: Json | null
          pending_since?: string | null
          phone_e164: string
          phone_key?: string | null
        }
        Update: {
          attention_at?: string | null
          attention_reason?: string | null
          audio_failures?: number
          away_sent_at?: string | null
          client_id?: string | null
          created_at?: string
          failed_runs?: number
          human_until?: string | null
          id?: string
          known_client_ids?: string[]
          last_inbound_at?: string | null
          last_outbound_at?: string | null
          lease_until?: string | null
          mode?: string
          needs_attention?: boolean
          pending_action?: Json | null
          pending_since?: string | null
          phone_e164?: string
          phone_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wa_conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "_v_client_credit"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "wa_conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_account"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "wa_conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_directory"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "wa_conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_stats"
            referencedColumns: ["client_id"]
          },
        ]
      }
      wa_messages: {
        Row: {
          body: string | null
          conversation_id: string
          created_at: string
          decision_id: string | null
          direction: string
          external_id: string | null
          from_human: boolean
          id: string
          kind: string
          purpose: string | null
          sender: string
          sent_at: string
        }
        Insert: {
          body?: string | null
          conversation_id: string
          created_at?: string
          decision_id?: string | null
          direction: string
          external_id?: string | null
          from_human?: boolean
          id?: string
          kind: string
          purpose?: string | null
          sender: string
          sent_at?: string
        }
        Update: {
          body?: string | null
          conversation_id?: string
          created_at?: string
          decision_id?: string | null
          direction?: string
          external_id?: string | null
          from_human?: boolean
          id?: string
          kind?: string
          purpose?: string | null
          sender?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wa_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "wa_conversations"
            referencedColumns: ["id"]
          },
        ]
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
      _v_client_credit: {
        Row: {
          client_id: string | null
          credit_balance_cents: number | null
          credit_deposited_cents: number | null
          credit_used_cents: number | null
        }
        Relationships: []
      }
      v_agent_inbound: {
        Row: {
          body: string | null
          conversation_id: string | null
          decision_action: string | null
          decision_reason: string | null
          inbound_at: string | null
          message_id: string | null
          message_row_id: string | null
          state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wa_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "wa_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      v_client_account: {
        Row: {
          client_id: string | null
          credit_balance_cents: number | null
          credit_deposited_cents: number | null
          credit_used_cents: number | null
          oldest_open_due: string | null
          open_debt_cents: number | null
          open_entries_count: number | null
        }
        Relationships: []
      }
      v_client_directory: {
        Row: {
          archived: boolean | null
          birthday: string | null
          client_id: string | null
          days_since_last_visit: number | null
          last_visit_at: string | null
          name: string | null
          needs_return: boolean | null
          next_appointment_at: string | null
          phone_e164: string | null
          preferred_professional_id: string | null
          segment: string | null
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
            referencedRelation: "_v_client_credit"
            referencedColumns: ["client_id"]
          },
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
            referencedRelation: "v_client_account"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_packages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_directory"
            referencedColumns: ["client_id"]
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
      v_ledger: {
        Row: {
          amount_cents: number | null
          appointment_id: string | null
          barter_paid_cents: number | null
          cash_paid_cents: number | null
          category: string | null
          client_id: string | null
          client_package_id: string | null
          commission_base_cents: number | null
          commission_cents: number | null
          commission_percent: number | null
          created_at: string | null
          description: string | null
          discount_cents: number | null
          due_date: string | null
          entry_type: string | null
          final_cents: number | null
          id: string | null
          import_key: string | null
          kind: Database["public"]["Enums"]["entry_kind"] | null
          noncash_paid_cents: number | null
          note: string | null
          open_cents: number | null
          paid_cents: number | null
          professional_id: string | null
          status: string | null
          studio_cents: number | null
          voided_at: string | null
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
            referencedRelation: "_v_client_credit"
            referencedColumns: ["client_id"]
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
            referencedRelation: "v_client_account"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "ledger_entries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_directory"
            referencedColumns: ["client_id"]
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
            referencedRelation: "_v_client_credit"
            referencedColumns: ["client_id"]
          },
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
            referencedRelation: "v_client_account"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "appointments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_directory"
            referencedColumns: ["client_id"]
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
      _cat_key: {
        Args: { c: Database["public"]["Enums"]["service_category"] }
        Returns: string
      }
      _client_credit_balance: { Args: { p_client_id: string }; Returns: number }
      _cron_call: { Args: { p_function: string }; Returns: undefined }
      _cron_send_confirmations: { Args: never; Returns: undefined }
      _cron_wa_sweep: { Args: never; Returns: undefined }
      _finance_result: {
        Args: { p_entry_id: string; p_lines?: number; p_request_id?: string }
        Returns: Json
      }
      _is_service: { Args: never; Returns: boolean }
      _is_system: { Args: never; Returns: boolean }
      _jwt_claims: { Args: never; Returns: Json }
      _lock_professional: {
        Args: { p_professional_id: string }
        Returns: undefined
      }
      _name_fold: { Args: { p: string }; Returns: string }
      _name_key: { Args: { p: string }; Returns: string }
      _name_similarity: { Args: { a: string; b: string }; Returns: number }
      _payment_lines: {
        Args: { p_payments: Json }
        Returns: {
          amount_cents: number
          method: Database["public"]["Enums"]["pay_method"]
          n: number
        }[]
      }
      _payment_request_id: {
        Args: { p_n: number; p_request_id: string }
        Returns: string
      }
      _raise: {
        Args: { p_code: string; p_detail?: string }
        Returns: undefined
      }
      _recompute_commission: {
        Args: { p_entry_id: string }
        Returns: undefined
      }
      _require_agent: { Args: never; Returns: undefined }
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
      _time_ok: { Args: { p: string }; Returns: boolean }
      _vault_secret: { Args: { p_name: string }; Returns: string }
      agent_claim: {
        Args: { p_conversation_id: string; p_lease_seconds: number }
        Returns: boolean
      }
      agent_flag: {
        Args: {
          p_conversation_id: string
          p_handoff: boolean
          p_handoff_hours?: number
          p_reason: string
        }
        Returns: undefined
      }
      agent_gate_state: {
        Args: {
          p_conversation_id: string
          p_exclude_decision?: string
          p_message_id: string
        }
        Returns: Json
      }
      agent_ingest_inbound: {
        Args: {
          p_body: string
          p_external_id: string
          p_kind: string
          p_phone: string
          p_sent_at?: string
        }
        Returns: {
          conversation_id: string
          inserted: boolean
        }[]
      }
      agent_mark_human: {
        Args: {
          p_body: string
          p_external_id: string
          p_hours: number
          p_kind: string
          p_phone: string
          p_sent_at?: string
        }
        Returns: string
      }
      agent_mark_reschedule_notified: {
        Args: { p_request_id: string }
        Returns: boolean
      }
      agent_pending_reschedule_notice: {
        Args: { p_request_id: string }
        Returns: {
          appointment_id: string
          client_id: string
          client_name: string
          phone: string
          starts_at: string
        }[]
      }
      agent_purge_old: { Args: never; Returns: Json }
      agent_record_decision: {
        Args: {
          p_action: string
          p_conversation_id: string
          p_draft_text?: string
          p_error_text?: string
          p_id?: string
          p_inbound_at: string
          p_live_since?: string
          p_max_age?: number
          p_message_id: string
          p_reason: string
        }
        Returns: string
      }
      agent_release: { Args: { p_conversation_id: string }; Returns: undefined }
      agent_store_outbound: {
        Args: {
          p_body: string
          p_conversation_id: string
          p_decision_id?: string
          p_external_id: string
          p_purpose: string
        }
        Returns: string
      }
      agent_touch_conversation: {
        Args: { p_client_ids: string[]; p_phone: string }
        Returns: string
      }
      check_invariants: {
        Args: never
        Returns: {
          code: string
          detail: string
          entity_id: string
        }[]
      }
      finance_professional_totals: {
        Args: { p_from: string; p_professional_id: string; p_to: string }
        Returns: {
          gross_cents: number
          studio_share_cents: number
        }[]
      }
      is_owner: { Args: never; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      normalize_phone: { Args: { p: string }; Returns: string }
      phone_key: { Args: { p: string }; Returns: string }
      rpc_add_client_credit: {
        Args: {
          p_amount_cents: number
          p_client_id: string
          p_method?: Database["public"]["Enums"]["pay_method"]
          p_note?: string
          p_opening?: boolean
          p_paid_at?: string
          p_request_id?: string
        }
        Returns: string
      }
      rpc_adjust_appointment_time: {
        Args: {
          p_appointment_id: string
          p_new_start: string
          p_notify?: boolean
          p_request_id: string
        }
        Returns: string
      }
      rpc_agent_dismiss_attention: {
        Args: { p_conversation_id: string }
        Returns: undefined
      }
      rpc_agent_overview: { Args: never; Returns: Json }
      rpc_agent_pause_conversation: {
        Args: { p_conversation_id: string }
        Returns: undefined
      }
      rpc_agent_recent_messages: {
        Args: { p_conversation_id: string; p_limit?: number }
        Returns: {
          body: string
          created_at: string
          decision_action: string
          decision_reason: string
          direction: string
          kind: string
          sender: string
        }[]
      }
      rpc_agent_return_conversation: {
        Args: { p_conversation_id: string }
        Returns: undefined
      }
      rpc_agent_set_mode: { Args: { p_mode: string }; Returns: Json }
      rpc_agent_set_settings: { Args: { p_patch: Json }; Returns: undefined }
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
      rpc_client_account_summary: {
        Args: { p_client_ids: string[] }
        Returns: {
          client_id: string
          credit_balance_cents: number
          open_debt_cents: number
        }[]
      }
      rpc_client_spend: {
        Args: { p_client_ids?: string[] }
        Returns: {
          client_id: string
          total_spent_cents: number
        }[]
      }
      rpc_complete_and_pay: {
        Args: {
          p_actual_end?: string
          p_appointment_id: string
          p_discount_cents?: number
          p_payments?: Json
          p_request_id?: string
        }
        Returns: Json
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
      rpc_create_manual_entry: {
        Args: {
          p_amount_cents: number
          p_category: string
          p_client_id?: string
          p_description: string
          p_due_date: string
          p_import_key?: string
          p_kind: Database["public"]["Enums"]["entry_kind"]
          p_method?: Database["public"]["Enums"]["pay_method"]
          p_pay_now?: boolean
          p_professional_id?: string
        }
        Returns: string
      }
      rpc_delete_block: { Args: { p_block_id: string }; Returns: undefined }
      rpc_edit_entry: {
        Args: {
          p_amount_cents: number
          p_category: string
          p_description: string
          p_due_date: string
          p_entry_id: string
        }
        Returns: undefined
      }
      rpc_finance_entry: {
        Args: { p_appointment_id?: string; p_client_package_id?: string }
        Returns: Json
      }
      rpc_finance_import_keys: { Args: { p_keys: string[] }; Returns: string[] }
      rpc_finance_list: {
        Args: {
          p_client_id?: string
          p_from: string
          p_include_reversed?: boolean
          p_limit?: number
          p_mode: string
          p_offset?: number
          p_professional_id?: string
          p_query?: string
          p_status?: string
          p_to: string
        }
        Returns: {
          amount_cents: number
          appointment_id: string
          appointment_starts_at: string
          appointment_status: Database["public"]["Enums"]["appointment_status"]
          category: string
          client_id: string
          client_name: string
          client_package_id: string
          commission_base_cents: number
          commission_cents: number
          commission_percent: number
          description: string
          discount_cents: number
          due_date: string
          entry_id: string
          entry_type: string
          final_cents: number
          kind: Database["public"]["Enums"]["entry_kind"]
          method: Database["public"]["Enums"]["pay_method"]
          open_cents: number
          paid_at: string
          paid_cents: number
          payment_cents: number
          payment_id: string
          professional_id: string
          professional_name: string
          reversed_at: string
          row_kind: string
          service_name: string
          status: string
          studio_cents: number
          sum_cents: number
          total_count: number
        }[]
      }
      rpc_finance_summary: {
        Args: { p_from: string; p_professional_id?: string; p_to: string }
        Returns: Json
      }
      rpc_find_client_by_name: {
        Args: { p_name: string; p_phone: string }
        Returns: Json
      }
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
          phone_key: string | null
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
      rpc_get_client_account: { Args: { p_client_id: string }; Returns: Json }
      rpc_get_client_context: { Args: { p_client_id: string }; Returns: Json }
      rpc_get_free_gap: {
        Args: { p_from: string; p_professional_id: string }
        Returns: {
          candidates: Json
          gap_end: string
          gap_start: string
        }[]
      }
      rpc_mark_no_show: {
        Args: { p_appointment_id: string }
        Returns: undefined
      }
      rpc_my_finance_summary: {
        Args: { p_from: string; p_to: string }
        Returns: {
          gross_cents: number
          studio_share_cents: number
        }[]
      }
      rpc_register_payments: {
        Args: {
          p_discount_cents?: number
          p_entry_id: string
          p_paid_at?: string
          p_payments?: Json
          p_request_id?: string
        }
        Returns: Json
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
      rpc_reverse_payment: {
        Args: { p_payment_id: string }
        Returns: undefined
      }
      rpc_search_clients: {
        Args: {
          p_filter?: string
          p_limit?: number
          p_offset?: number
          p_query?: string
        }
        Returns: {
          archived: boolean
          birthday: string
          client_id: string
          days_since_last_visit: number
          last_visit_at: string
          name: string
          needs_return: boolean
          next_appointment_at: string
          phone_e164: string
          preferred_professional_id: string
          segment: string
          total_count: number
          visit_count: number
        }[]
      }
      rpc_sell_package: {
        Args: { p_client_id: string; p_template_id: string }
        Returns: string
      }
      rpc_set_commission_rule: {
        Args: {
          p_category: Database["public"]["Enums"]["service_category"]
          p_percent: number
          p_professional_id: string
        }
        Returns: undefined
      }
      rpc_set_professional_services: {
        Args: { p_professional_id: string; p_service_ids: string[] }
        Returns: undefined
      }
      rpc_set_working_hours: {
        Args: { p_professional_id: string; p_rows: Json }
        Returns: undefined
      }
      rpc_settle_client_account: {
        Args: {
          p_client_id: string
          p_note?: string
          p_paid_at?: string
          p_payments: Json
          p_request_id: string
        }
        Returns: Json
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
      rpc_update_client: {
        Args: {
          p_archived: boolean
          p_birthday: string
          p_client_id: string
          p_name: string
          p_notes: string
          p_phone: string
        }
        Returns: string
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
      rpc_void_entry: { Args: { p_entry_id: string }; Returns: undefined }
      rpc_void_package: {
        Args: { p_client_package_id: string }
        Returns: undefined
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      today_sp: { Args: never; Returns: string }
      unaccent: { Args: { "": string }; Returns: string }
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
      entry_kind: "income" | "expense"
      pay_method:
        | "pix"
        | "cash"
        | "debit"
        | "credit"
        | "barter"
        | "credit_balance"
        | "adjustment"
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
      entry_kind: ["income", "expense"],
      pay_method: [
        "pix",
        "cash",
        "debit",
        "credit",
        "barter",
        "credit_balance",
        "adjustment",
      ],
      service_action: ["placement", "maintenance", "removal"],
      service_category: ["unhas", "cilios", "sobrancelhas", "outros"],
      service_kind: ["standard", "removal"],
    },
  },
} as const

