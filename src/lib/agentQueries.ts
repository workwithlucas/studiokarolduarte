// Agent control reads. Everything comes from rpc_agent_overview (owner only). No Realtime: poll every 30s,
// and react-query pauses interval polling while the tab is hidden.
import { useQuery } from '@tanstack/react-query'
import { rpc } from './rpc'

export type AgentMode = 'off' | 'test' | 'live'

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

export interface AgentOverview {
  settings: AgentSettings
  attention: AttentionItem[]
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

export const MODE_LABEL: Record<AgentMode, string> = { off: 'Desligado', test: 'Teste', live: 'No ar' }

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
