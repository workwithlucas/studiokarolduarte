// send-confirmations: tomorrow's appointments, one WhatsApp per phone, idempotent through wa_confirmations.
import { callRpc, loadSettings, unwrap, updateConversation } from './db.ts'
import { sendScheduled } from './outbound.ts'
import { firstName, normalizePhone } from './phone.ts'
import { addDays, hhmm, hhmmToMinutes, isoOf, parseInstant, spParts } from './time.ts'
import type { Deps, Settings } from './types.ts'

export const MAX_RECIPIENTS = 40
export const MIN_AGE_MS = 3 * 3_600_000
export const CUTOFF_MINUTES = 20 * 60

export interface CandidateAppt {
  id: string
  client_id: string
  client_name: string
  client_phone: string | null
  status: string
  starts_at: string
  created_at: string
  service_name: string
  action: string
  professional_name: string
}

export interface Batch {
  phone: string
  clientIds: string[]
  items: CandidateAppt[]
}

/** Runs only when enabled, the agent is not off, and it is between confirmation_hour and 20:00 (São Paulo). */
export function confirmationsOpen(settings: Settings, nowMs: number): boolean {
  if (!settings.confirmation_enabled || settings.agent_mode === 'off' || settings.agent_mode === 'shadow') return false
  const m = spParts(nowMs).minutes
  return m >= hhmmToMinutes(settings.confirmation_hour, 16 * 60) && m < CUTOFF_MINUTES
}

/** Pure selection: tomorrow (São Paulo), status scheduled, valid phone, not yet confirmed, created 3h+ ago. */
export function selectConfirmations(input: { appointments: CandidateAppt[]; alreadySent: Set<string>; nowMs: number; settings: Settings }): Batch[] {
  const { appointments, alreadySent, nowMs, settings } = input
  const tomorrow = addDays(spParts(nowMs).ymd, 1)
  const byPhone = new Map<string, Batch>()
  const sorted = [...appointments].sort((a, b) => (parseInstant(a.starts_at) ?? 0) - (parseInstant(b.starts_at) ?? 0))
  for (const a of sorted) {
    if (a.status !== 'scheduled' || alreadySent.has(a.id)) continue
    const start = parseInstant(a.starts_at)
    const created = parseInstant(a.created_at)
    if (start === null || created === null) continue
    if (spParts(start).ymd !== tomorrow) continue
    if (nowMs - created < MIN_AGE_MS) continue
    const phone = normalizePhone(a.client_phone)
    if (!phone) continue
    if (settings.agent_mode === 'test' && !settings.agent_test_numbers.includes(phone)) continue
    const b = byPhone.get(phone) ?? { phone, clientIds: [], items: [] }
    if (!b.clientIds.includes(a.client_id)) b.clientIds.push(a.client_id)
    b.items.push(a)
    byPhone.set(phone, b)
  }
  return [...byPhone.values()].slice(0, MAX_RECIPIENTS)
}

export function confirmationText(batch: Batch): string {
  const names = [...new Set(batch.items.map((i) => firstName(i.client_name)))]
  const greeting = names.length === 1 && names[0] ? `Oi, ${names[0]}!` : 'Oi!'
  const lines = batch.items.map((i) => {
    const who = names.length > 1 ? `${firstName(i.client_name)}: ` : ''
    const svc = i.action === 'maintenance' ? `${i.service_name} (manutenção)` : i.service_name
    return `• ${who}${hhmm(parseInstant(i.starts_at) ?? 0)} — ${svc}, com ${firstName(i.professional_name)}`
  })
  return `${greeting} Amanhã você tem horário no Studio Karol Duarte:\n${lines.join('\n')}\nPosso confirmar?`
}

export interface ConfirmationsResult {
  sent: number
  skipped: number
  reason?: string
}

export async function runConfirmations(deps: Deps, budgetMs = 110_000): Promise<ConfirmationsResult> {
  const { db } = deps
  const started = deps.now()
  const settings = await loadSettings(db)
  if (!confirmationsOpen(settings, started)) return { sent: 0, skipped: 0, reason: 'closed' }

  const rows = unwrap<Array<Record<string, any>>>(
    await db.from('appointments')
      .select('id,client_id,status,starts_at,created_at,action,service:services(name),professional:professionals(name),client:clients(name,phone_e164,archived)')
      .eq('status', 'scheduled').gte('starts_at', isoOf(started)).lt('starts_at', isoOf(started + 3 * 86_400_000)),
  )
  const appointments: CandidateAppt[] = (rows ?? [])
    .filter((r) => r.client && !r.client.archived)
    .map((r) => ({
      id: r.id, client_id: r.client_id, client_name: r.client.name, client_phone: r.client.phone_e164, status: r.status,
      starts_at: r.starts_at, created_at: r.created_at, service_name: r.service?.name ?? 'Atendimento', action: r.action,
      professional_name: r.professional?.name ?? '',
    }))
  const already = async (ids: string[]) =>
    new Set((unwrap<Array<{ appointment_id: string }>>(await db.from('wa_confirmations').select('appointment_id').in('appointment_id', ids)) ?? []).map((r) => r.appointment_id))
  const batches = selectConfirmations({
    appointments, alreadySent: appointments.length ? await already(appointments.map((a) => a.id)) : new Set(), nowMs: started, settings,
  })

  let sent = 0
  let skipped = 0
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!
    if (i > 0) {
      const delay = 20_000 + Math.floor(deps.random() * 40_000)
      if (deps.now() + delay - started > budgetMs) break // the next 15-minute run continues where this one stopped
      await deps.sleep(delay)
    }
    const convId = await callRpc<string>(db, 'agent_touch_conversation', { p_phone: batch.phone, p_client_ids: batch.clientIds })
    const claimed = await callRpc<boolean>(db, 'agent_claim', { p_conversation_id: convId, p_lease_seconds: 120 })
    if (!claimed) {
      skipped++
      continue
    }
    try {
      if ((await already(batch.items.map((x) => x.id))).size > 0) {
        skipped++
        continue
      }
      const text = confirmationText(batch)
      const r = await sendScheduled(deps, { conversationId: convId, phone: batch.phone, text, purpose: 'confirmation' })
      if (!r.sent) {
        skipped++ // the mode changed since the batch started: nothing goes out
        continue
      }
      const messageId = r.messageRowId ?? null
      unwrap(
        await db.from('wa_confirmations').upsert(
          batch.items.map((x) => ({ appointment_id: x.id, message_id: messageId, sent_at: isoOf(deps.now()) })),
          { onConflict: 'appointment_id', ignoreDuplicates: true },
        ),
      )
      await updateConversation(db, convId, { last_outbound_at: isoOf(deps.now()) })
      sent++
    } catch (e) {
      skipped++
      deps.log('confirmation_failed', { error: String(e instanceof Error ? e.message : e) })
    } finally {
      await callRpc(db, 'agent_release', { p_conversation_id: convId })
    }
  }
  return { sent, skipped }
}
