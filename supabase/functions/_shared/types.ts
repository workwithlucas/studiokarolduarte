// Shared contracts. Everything with side effects (db, fetch, clock, sleep, randomness) is injected.

export interface DbError {
  message: string
  details?: string | null
  code?: string
}
export interface DbResult<T = any> {
  data: T | null
  error: DbError | null
}
/** Structural subset of the supabase-js client (service_role). */
export interface Db {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<DbResult>
  from(table: string): any
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface Config {
  anthropicKey?: string
  groqKey?: string
  model: string
  zapi: { instanceId: string; token: string; clientToken: string }
  legacyUrl?: string
}

export interface Deps {
  db: Db
  fetch: FetchFn
  now: () => number
  sleep: (ms: number) => Promise<void>
  random: () => number
  cfg: Config
  log: (event: string, data?: Record<string, unknown>) => void
}

export type AgentMode = 'off' | 'test' | 'live'

export interface Settings {
  agent_mode: AgentMode
  agent_window_start: string
  agent_window_end: string
  agent_test_numbers: string[]
  agent_away_message: string
  confirmation_enabled: boolean
  confirmation_hour: string
  human_takeover_hours: number
  history_messages: number
  retention_days: number
  debounce_seconds: number
}

export interface PendingAction {
  type: 'book' | 'reschedule' | 'cancel'
  params: Record<string, unknown>
  summary: Record<string, unknown>
  proposed_at: string
  expires_at: string
  /** Latest inbound created_at (database clock) at the moment the summary reached the client. */
  presented_baseline?: string | null
}

export interface Conversation {
  id: string
  phone_e164: string
  client_id: string | null
  known_client_ids: string[]
  mode: 'agent' | 'human'
  human_until: string | null
  pending_since: string | null
  last_inbound_at: string | null
  last_outbound_at: string | null
  lease_until: string | null
  away_sent_at: string | null
  pending_action: PendingAction | null
  needs_attention: boolean
  attention_reason: string | null
  failed_runs: number
  audio_failures: number
}

export const DEFAULT_SETTINGS: Settings = {
  agent_mode: 'off',
  agent_window_start: '07:00',
  agent_window_end: '22:00',
  agent_test_numbers: [],
  agent_away_message: 'Oi! Recebi sua mensagem. Assim que possível eu te respondo por aqui.',
  confirmation_enabled: false,
  confirmation_hour: '16:00',
  human_takeover_hours: 3,
  history_messages: 12,
  retention_days: 14,
  debounce_seconds: 8,
}
