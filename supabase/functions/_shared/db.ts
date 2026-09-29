import { normalizePhone } from './phone.ts'
import { DEFAULT_SETTINGS, type Conversation, type Db, type DbResult, type Settings } from './types.ts'

export class RpcFailure extends Error {
  readonly code: string
  readonly detail: string | null
  constructor(code: string, detail: string | null) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

/** Unwraps a db result. Rule violations (error.message = code) become RpcFailure; anything else is Error. */
export function unwrap<T = any>(res: DbResult<T>): T {
  if (res.error) {
    if (/^[A-Z][A-Z_]+$/.test(res.error.message)) throw new RpcFailure(res.error.message, res.error.details ?? null)
    throw new Error(res.error.message)
  }
  return res.data as T
}

export async function callRpc<T = any>(db: Db, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  return unwrap<T>(await db.rpc(fn, args))
}

const isTime = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

/** Pure: builds a Settings object from studio_settings rows, falling back to defaults on anything invalid. */
export function parseSettings(rows: Array<{ key: string; value: unknown }>): Settings {
  const m = new Map(rows.map((r) => [r.key, r.value]))
  const d = DEFAULT_SETTINGS
  const mode = m.get('agent_mode')
  const nums = m.get('agent_test_numbers')
  const away = m.get('agent_away_message')
  const num = (k: string, def: number, lo: number, hi: number) => (isInt(m.get(k), lo, hi) ? (m.get(k) as number) : def)
  return {
    agent_mode: mode === 'test' || mode === 'live' ? mode : 'off', // anything unknown fails closed
    agent_window_start: isTime(m.get('agent_window_start')) ? (m.get('agent_window_start') as string) : d.agent_window_start,
    agent_window_end: isTime(m.get('agent_window_end')) ? (m.get('agent_window_end') as string) : d.agent_window_end,
    agent_test_numbers: Array.isArray(nums)
      ? nums.map((n) => normalizePhone(n)).filter((n): n is string => n !== null)
      : [],
    agent_away_message: typeof away === 'string' && away.trim() ? away : d.agent_away_message,
    confirmation_enabled: m.get('confirmation_enabled') === true,
    confirmation_hour: isTime(m.get('confirmation_hour')) ? (m.get('confirmation_hour') as string) : d.confirmation_hour,
    human_takeover_hours: num('human_takeover_hours', d.human_takeover_hours, 1, 48),
    history_messages: num('history_messages', d.history_messages, 4, 30),
    retention_days: num('retention_days', d.retention_days, 1, 90),
    debounce_seconds: num('debounce_seconds', d.debounce_seconds, 3, 30),
  }
}

export async function loadSettings(db: Db): Promise<Settings> {
  const rows = unwrap<Array<{ key: string; value: unknown }>>(await db.from('studio_settings').select('key,value'))
  return parseSettings(rows ?? [])
}

/** Mode gate shared by every entry point: off blocks everything, test only passes whitelisted phones. */
export function modeAllows(settings: Settings, phone: string): boolean {
  if (settings.agent_mode === 'live') return true
  if (settings.agent_mode === 'test') return settings.agent_test_numbers.includes(phone)
  return false
}

const CONV_COLS =
  'id,phone_e164,client_id,known_client_ids,mode,human_until,pending_since,last_inbound_at,last_outbound_at,lease_until,away_sent_at,pending_action,needs_attention,attention_reason,failed_runs,audio_failures'

export async function getConversation(db: Db, id: string): Promise<Conversation | null> {
  const r = unwrap<Conversation | null>(await db.from('wa_conversations').select(CONV_COLS).eq('id', id).maybeSingle())
  return r
}

export async function updateConversation(db: Db, id: string, patch: Record<string, unknown>): Promise<void> {
  unwrap(await db.from('wa_conversations').update(patch).eq('id', id))
}

export interface StoredMessage {
  id: string
  direction: 'in' | 'out'
  external_id: string | null
  kind: string
  body: string | null
  purpose: string | null
  from_human: boolean
  created_at: string
}

export async function recentMessages(db: Db, conversationId: string, limit: number): Promise<StoredMessage[]> {
  const rows = unwrap<StoredMessage[]>(
    await db
      .from('wa_messages')
      .select('id,direction,external_id,kind,body,purpose,from_human,created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit),
  )
  return (rows ?? []).slice().reverse()
}

export async function latestInbound(
  db: Db,
  conversationId: string,
): Promise<{ external_id: string | null; created_at: string } | null> {
  const rows = unwrap<Array<{ external_id: string | null; created_at: string }>>(
    await db
      .from('wa_messages')
      .select('external_id,created_at')
      .eq('conversation_id', conversationId)
      .eq('direction', 'in')
      .order('created_at', { ascending: false })
      .limit(1),
  )
  return rows?.[0] ?? null
}

export async function storeOutbound(
  db: Db,
  conversationId: string,
  externalId: string | null,
  body: string,
  purpose: 'reply' | 'away' | 'confirmation' | 'handoff',
): Promise<string | null> {
  const rows = unwrap<Array<{ id: string }>>(
    await db
      .from('wa_messages')
      .insert({ conversation_id: conversationId, direction: 'out', external_id: externalId, kind: 'text', body, purpose })
      .select('id'),
  )
  return rows?.[0]?.id ?? null
}
