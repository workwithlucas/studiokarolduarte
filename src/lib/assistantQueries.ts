// Finance assistant client: talks to the assistant-chat function (the only way it writes) and reads the thread
// from its owner-only tables. Money and dates in the cards are built by the function; nothing is computed here.
import type { QueryClient } from '@tanstack/react-query'
import type {
  ActionLogItem, ActionsResponse, AssistantBody, AssistantResponse, Card, MessageView, PendingView, ThreadSummary, ThreadsResponse, UndoItem,
  UndoLoggedResponse,
} from '../../supabase/functions/_shared/assistant-types'
import { pendingViewOf } from '../../supabase/functions/_shared/assistant-state'
import { supabase } from './supabase'

export type { ActionLogItem, ActionsResponse, AssistantBody, AssistantResponse, Card, MessageView, PendingView, ThreadSummary, ThreadsResponse, UndoLoggedResponse }

/** Everything an executed action or an undo can change on screen: finance, agenda, packages and client pages. */
export const ASSISTANT_INVALIDATE_KEYS = [
  'finance-summary',
  'finance-list',
  'finance-entry',
  'appointments',
  'packages',
  'package-appointments',
  'package-sessions',
  'eligible-packages',
  'client-account',
  'client-account-summary',
  'client-context',
  'client-appts',
  'client-spend',
  'client-row',
] as const

export function invalidateAfterWrite(qc: Pick<QueryClient, 'invalidateQueries'>): void {
  for (const k of ASSISTANT_INVALIDATE_KEYS) void qc.invalidateQueries({ queryKey: [k] })
}

const CONNECTION = 'Não consegui falar com o assistente. Confira a conexão e tente de novo.'

async function callFunction(body: AssistantBody): Promise<unknown> {
  const { data, error } = await supabase.functions.invoke('assistant-chat', { body })
  if (error) {
    let message = CONNECTION
    const ctx = (error as { context?: unknown }).context
    if (typeof Response !== 'undefined' && ctx instanceof Response) {
      try {
        const j = (await ctx.json()) as { error?: unknown }
        if (typeof j.error === 'string' && j.error) message = j.error
      } catch {
        /* keep the generic message */
      }
    }
    throw new Error(message)
  }
  return data
}

export async function invokeAssistant(body: AssistantBody): Promise<AssistantResponse> {
  const res = (await callFunction(body)) as Partial<AssistantResponse> | null
  if (!res || !Array.isArray(res.messages)) throw new Error(CONNECTION)
  return { messages: res.messages, pendings: res.pendings ?? [] }
}

export async function listThreads(): Promise<ThreadSummary[]> {
  const res = (await callFunction({ action: 'list_threads' })) as Partial<ThreadsResponse> | null
  if (!res || !Array.isArray(res.threads)) throw new Error(CONNECTION)
  return res.threads
}

/** Read-only messages of an archived thread. */
export async function getThread(threadId: string): Promise<AssistantResponse> {
  const res = (await callFunction({ action: 'get_thread', thread_id: threadId })) as Partial<AssistantResponse> | null
  if (!res || !Array.isArray(res.messages)) throw new Error(CONNECTION)
  return { messages: res.messages, pendings: res.pendings ?? [] }
}

export const ACTIONS_PAGE = 50

export async function listActions(offset: number): Promise<ActionsResponse> {
  const res = (await callFunction({ action: 'list_actions', limit: ACTIONS_PAGE, offset })) as Partial<ActionsResponse> | null
  if (!res || !Array.isArray(res.actions)) throw new Error(CONNECTION)
  return { actions: res.actions, has_more: res.has_more === true }
}

export async function undoLogged(pendingId: string, actionIndex: number): Promise<UndoLoggedResponse> {
  const res = (await callFunction({ action: 'undo_logged', pending_id: pendingId, action_index: actionIndex })) as Partial<UndoLoggedResponse> | null
  if (!res || typeof res.ok !== 'boolean' || typeof res.message !== 'string') throw new Error(CONNECTION)
  return { ok: res.ok, message: res.message }
}

/** Last messages of the owner's thread (RLS: owner only) plus the state of the proposals they mention. */
export async function loadThread(): Promise<AssistantResponse> {
  const { data, error } = await supabase
    .from('assistant_messages')
    .select('id,role,body,card,meta,created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(60)
  if (error) throw new Error('Não consegui carregar a conversa.')
  const rows = (data ?? []).slice().reverse()
  const messages: MessageView[] = rows
    .filter((r) => !(r.meta as { hidden?: boolean } | null)?.hidden)
    .map((r) => ({ id: r.id, role: r.role as MessageView['role'], body: r.body, card: r.card as unknown as Card | null, created_at: r.created_at }))
  const ids = [...new Set(messages.flatMap((m) => (m.card && 'pending_id' in m.card ? [m.card.pending_id] : [])))]
  let pendings: PendingView[] = []
  if (ids.length) {
    const p = await supabase.from('assistant_pending').select('id,status,expires_at,undo').in('id', ids)
    if (p.error) throw new Error('Não consegui carregar a conversa.')
    pendings = (p.data ?? []).map((r) => pendingViewOf({ id: r.id, status: r.status as PendingView['status'], expires_at: r.expires_at, undo: r.undo as unknown as UndoItem[] | null }))
  }
  return { messages, pendings }
}

export function mergeMessages(prev: MessageView[], incoming: MessageView[]): MessageView[] {
  const byId = new Map(prev.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
}

export function mergePendings(prev: Record<string, PendingView>, incoming: PendingView[]): Record<string, PendingView> {
  const next = { ...prev }
  for (const p of incoming) next[p.id] = p
  return next
}
