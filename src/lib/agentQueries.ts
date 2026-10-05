// Agent control reads. Everything comes from rpc_agent_overview (owner only). No Realtime: poll every 30s,
// and react-query pauses interval polling while the tab is hidden.
import { useQuery } from '@tanstack/react-query'
import { rpc } from './rpc'

export type AgentMode = 'off' | 'shadow' | 'test' | 'live'

export interface AgentSettings {
  agent_mode: AgentMode
  agent_window_start: string
  agent_window_end: string
  agent_test_numbers: string[]
  agent_away_message: string
  confirmation_enabled: boolean
  confirmation_hour: string
}

export interface AttentionItem {
  id: string
  phone: string
  client_name: string | null
  reason: string | null
  at: string | null
  last_inbound: string | null
}

export interface AgentAction {
  id: number
  at: string
  action: string
  entity: string
  entity_id: string | null
  client_name: string | null
  starts_at: string | null
}

export interface AgentHardening {
  live_since: string | null
  off_since: string | null
  max_inbound_age_minutes: number
  breaker_max_sends: number
  breaker_window_minutes: number
  would_quarantine_threads: number
  /** Agent sends after off_since (from the log); only meaningful while the agent is off. */
  sends_after_off: number
  /** Set when the last switch to off was made by the circuit breaker. */
  breaker_at: string | null
}

export interface AgentDraft {
  id: string
  at: string
  client_name: string | null
  phone: string | null
  inbound: string | null
  draft_text: string | null
}

export type UnansweredReason = 'antiga' | 'equipe respondeu' | 'antes de ativar'

export interface UnansweredItem {
  id: string
  phone: string
  client_name: string | null
  inbound: string | null
  inbound_at: string
  reason: UnansweredReason
  paused: boolean
}

export interface AgentModeResult {
  mode: AgentMode
  previous: AgentMode | null
  changed: boolean
  quarantined_messages: number
  quarantined_threads: number
  cancelled: number
}

export interface AgentOverview {
  settings: AgentSettings
  hardening: AgentHardening
  attention: AttentionItem[]
  drafts: AgentDraft[]
  unanswered: UnansweredItem[]
  actions: AgentAction[]
}

export const agentKey = ['agent', 'overview'] as const

export function useAgentOverview() {
  return useQuery({
    queryKey: agentKey,
    queryFn: async () => (await rpc.agentOverview()) as unknown as AgentOverview,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
}

export const MODE_LABEL: Record<AgentMode, string> = { off: 'Desligada', shadow: 'Sombra', test: 'Teste', live: 'No ar' }

const DECISION_LABEL: Record<string, string> = {
  replied: 'respondeu',
  shadow_drafted: 'rascunho (não enviado)',
  no_reply: 'não respondeu',
  handoff: 'passou para a equipe',
  skipped_mode: 'desligada ou fora do teste',
  skipped_stale: 'mensagem antiga demais',
  skipped_human: 'equipe em atendimento',
  skipped_before_live: 'anterior a ativar',
  skipped_answered: 'já respondida',
  skipped_duplicate: 'duplicada',
  cancelled_off: 'cancelada ao desligar',
  circuit_breaker: 'disjuntor: envios demais',
  error: 'erro',
}

export const decisionText = (action: string | null | undefined, reason?: string | null): string =>
  action ? `${DECISION_LABEL[action] ?? action}${reason && reason !== 'reply' ? ` · ${reason}` : ''}` : ''

const ACTION_LABEL: Record<string, string> = {
  book_appointment: 'Agendou',
  reschedule_appointment: 'Remarcou',
  cancel_appointment: 'Cancelou',
  confirm_appointment: 'Confirmou presença',
  create_client: 'Cadastrou cliente',
  update_client: 'Atualizou cliente',
  agent_handoff: 'Passou para a equipe',
  agent_note: 'Deixou recado',
}

export const actionText = (a: string): string => ACTION_LABEL[a] ?? a
