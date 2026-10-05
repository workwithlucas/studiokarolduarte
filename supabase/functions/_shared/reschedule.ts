// notify-reschedule: fixed system text after a time adjustment. No AI call; the text is built from stored data.
import { callRpc, loadSettings, modeAllows, storeOutbound, updateConversation } from './db.ts'
import { firstName, normalizePhone } from './phone.ts'
import { ddmm, hhmm, isoOf, parseInstant, spParts } from './time.ts'
import type { Deps } from './types.ts'
import { sendText } from './zapi.ts'

export interface RescheduleNotice {
  appointment_id: string
  client_id: string
  client_name: string
  phone: string | null
  starts_at: string
}

/** "Olá, Ana! Seu horário no Studio Karol Duarte foi alterado para 06/10 às 15:00." Null when the start is invalid. */
export function rescheduleText(clientName: string | null | undefined, startsAt: unknown): string | null {
  const ms = parseInstant(startsAt)
  if (ms === null) return null
  const name = firstName(clientName)
  const greeting = name ? `Olá, ${name}!` : 'Olá!'
  return `${greeting} Seu horário no Studio Karol Duarte foi alterado para ${ddmm(spParts(ms).ymd)} às ${hhmm(ms)}.`
}

export type NoticeOutcome = 'sent' | 'no_phone' | 'not_pending' | 'mode_off' | 'invalid'

export async function sendRescheduleNotice(deps: Deps, requestId: string): Promise<NoticeOutcome> {
  const { db } = deps
  const rows = await callRpc<RescheduleNotice[]>(db, 'agent_pending_reschedule_notice', { p_request_id: requestId })
  const n = rows?.[0]
  if (!n) return 'not_pending'
  const phone = normalizePhone(n.phone)
  if (!phone) return 'no_phone'
  const text = rescheduleText(n.client_name, n.starts_at)
  if (!text) return 'invalid'
  if (!modeAllows(await loadSettings(db), phone)) return 'mode_off'
  // claim first: a double click or a retry never sends twice
  if (!(await callRpc<boolean>(db, 'agent_mark_reschedule_notified', { p_request_id: requestId }))) return 'not_pending'
  const convId = await callRpc<string>(db, 'agent_touch_conversation', { p_phone: phone, p_client_ids: [n.client_id] })
  const r = await sendText(deps.fetch, deps.cfg.zapi, phone, text)
  await storeOutbound(db, convId, r.messageId, text, 'reply')
  await updateConversation(db, convId, { last_outbound_at: isoOf(deps.now()) })
  return 'sent'
}
