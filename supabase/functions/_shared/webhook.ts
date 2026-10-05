// wa-webhook logic: parse, dedupe, media, mode gates, debounce. The handler only wires I/O.
import { callRpc, getConversation, latestInbound, loadSettings, modeRuns, unwrap, updateConversation } from './db.ts'
import { isLatestInbound } from './gates.ts'
import { describeImage, transcribeAudio } from './media.ts'
import { recordDecision } from './outbound.ts'
import type { Deps } from './types.ts'
import { parseRawPayload, parseWebhook } from './zapi.ts'

export interface WebhookResult {
  action: 'ignored' | 'human' | 'duplicate' | 'stopped' | 'forwarded' | 'superseded' | 'run'
  reason?: string
  conversationId?: string
}

async function knownExternalId(deps: Deps, externalId: string): Promise<boolean> {
  const row = unwrap<{ id: string } | null>(await deps.db.from('wa_messages').select('id').eq('external_id', externalId).maybeSingle())
  return row !== null
}

/** Best-effort forward of the untouched raw body to the legacy system (fire-and-forget, 5s timeout). */
export async function forwardLegacy(deps: Deps, rawBody: string): Promise<void> {
  if (!deps.cfg.legacyUrl) return
  try {
    await deps.fetch(deps.cfg.legacyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
      signal: AbortSignal.timeout(5_000),
    })
  } catch (e) {
    deps.log('legacy_forward_failed', { error: String(e instanceof Error ? e.message : e) })
  }
}

export async function handleReceived(deps: Deps, rawBody: string, invokeRun: (conversationId: string) => Promise<void>): Promise<WebhookResult> {
  const ev = parseWebhook(parseRawPayload(rawBody))
  if (ev.type === 'ignore') return { action: 'ignored', reason: ev.reason }
  const settings = await loadSettings(deps.db)

  if (ev.type === 'from_me') {
    // Every outbound/fromMe message is stored, whatever the mode. It is staff unless it carries this system's send
    // id (an id we stored ourselves). An unknown id sent through the API (another sender) is treated as staff too.
    // our own send: same provider id, or same thread + same text within 60 s of a registered agent send
    const ours = () => callRpc<boolean>(deps.db, 'agent_match_agent_send', { p_phone: ev.phone, p_external_id: ev.externalId, p_body: ev.body, p_kind: ev.kind, p_sent_at: ev.sentAt })
    if (await knownExternalId(deps, ev.externalId)) return { action: 'ignored', reason: 'sent_by_us' }
    if (await ours()) return { action: 'ignored', reason: 'sent_by_us' }
    await deps.sleep(2_000) // our own send may not have been registered/attached yet
    if (await knownExternalId(deps, ev.externalId)) return { action: 'ignored', reason: 'sent_by_us' }
    if (await ours()) return { action: 'ignored', reason: 'sent_by_us' }
    const conversationId = await callRpc<string>(deps.db, 'agent_mark_human', {
      p_phone: ev.phone, p_external_id: ev.externalId, p_kind: ev.kind, p_body: ev.body, p_hours: settings.human_takeover_hours, p_sent_at: ev.sentAt,
    })
    return { action: 'human', conversationId }
  }

  const initialBody = ev.kind === 'text' ? ev.text : ev.kind === 'sticker' ? '[figurinha]' : ev.kind === 'other' ? '[arquivo]' : null
  const rows = await callRpc<Array<{ conversation_id: string; inserted: boolean }>>(deps.db, 'agent_ingest_inbound', {
    p_phone: ev.phone, p_external_id: ev.externalId, p_kind: ev.kind, p_body: initialBody, p_sent_at: ev.sentAt,
  })
  const ing = Array.isArray(rows) ? rows[0] : (rows as unknown as { conversation_id: string; inserted: boolean })
  if (!ing) throw new Error('agent_ingest_inbound returned nothing')
  if (!ing.inserted) return { action: 'duplicate', conversationId: ing.conversation_id }
  const conversationId = ing.conversation_id

  // off: stored and left undecided; going live later quarantines or gates it. Nothing runs.
  if (settings.agent_mode === 'off') return { action: 'stopped', reason: 'off', conversationId }
  if (!modeRuns(settings, ev.phone)) {
    await forwardLegacy(deps, rawBody)
    await recordDecision(deps.db, { messageId: ev.externalId, conversationId, inboundAt: ev.sentAt, action: 'skipped_mode', reason: 'not_in_test_numbers' })
    return { action: 'forwarded', conversationId }
  }

  // Media becomes text at ingest.
  let body = initialBody
  let failedAudio = false
  if (ev.kind === 'audio') {
    body = await transcribeAudio(deps, ev.mediaUrl)
    failedAudio = body === null
  } else if (ev.kind === 'image') {
    body = await describeImage(deps, ev.mediaUrl, ev.mimeType, ev.caption)
  }
  if (body !== initialBody) {
    unwrap(await deps.db.from('wa_messages').update({ body }).eq('external_id', ev.externalId))
  }
  const conv = await getConversation(deps.db, conversationId)
  if (conv) {
    if (failedAudio) await updateConversation(deps.db, conversationId, { audio_failures: conv.audio_failures + 1 })
    else if (conv.audio_failures > 0) await updateConversation(deps.db, conversationId, { audio_failures: 0 })
  }

  // Debounce: only the newest message of a burst triggers the run.
  await deps.sleep(settings.debounce_seconds * 1000)
  const newest = await latestInbound(deps.db, conversationId)
  if (!isLatestInbound(newest?.external_id, ev.externalId)) {
    await recordDecision(deps.db, { messageId: ev.externalId, conversationId, inboundAt: ev.sentAt, action: 'no_reply', reason: 'superseded' })
    return { action: 'superseded', conversationId }
  }
  await invokeRun(conversationId)
  return { action: 'run', conversationId }
}
