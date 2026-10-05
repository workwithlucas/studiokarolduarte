// Z-API: received-message webhook parser and send-text client.
// Field names come from developer.z-api.io (webhooks/on-message-received-examples, message/send-text).
import { normalizePhone } from './phone.ts'
import { isoOf } from './time.ts'
import type { Config, FetchFn } from './types.ts'

export type InboundKind = 'text' | 'audio' | 'image' | 'sticker' | 'other'

export type ParsedEvent =
  | { type: 'ignore'; reason: string }
  | { type: 'from_me'; phone: string; externalId: string; fromApi: boolean; kind: InboundKind; body: string | null; sentAt: string | null }
  | {
      type: 'inbound'
      phone: string
      externalId: string
      kind: InboundKind
      text: string | null
      mediaUrl: string | null
      mimeType: string | null
      caption: string | null
      /** Provider timestamp (ISO) when valid, else null: the database then uses its own clock. */
      sentAt: string | null
    }

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** Z-API 'momment' (epoch ms). Anything not a plausible epoch-ms becomes null; the database also caps it at now(). */
export function providerTime(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1.42e12 || v > 4e12) return null
  return isoOf(Math.trunc(v))
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

export function parseRawPayload(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Interprets a Z-API "ReceivedCallback". Anything that is not a 1:1 chat message is ignored. */
export function parseWebhook(payload: unknown): ParsedEvent {
  if (!isObj(payload)) return { type: 'ignore', reason: 'invalid_payload' }
  if (payload.type !== 'ReceivedCallback') return { type: 'ignore', reason: 'not_message' }
  const rawPhone = str(payload.phone)
  if (
    payload.isGroup === true ||
    payload.isNewsletter === true ||
    payload.broadcast === true ||
    !rawPhone ||
    /-group$|-broadcast$|@g\.us|@broadcast|status@/i.test(rawPhone)
  ) {
    return { type: 'ignore', reason: 'group_or_broadcast' }
  }
  if (payload.waitingMessage === true || payload.isEdit === true) return { type: 'ignore', reason: 'not_final' }
  const phone = normalizePhone(rawPhone)
  const externalId = str(payload.messageId)
  if (!phone || !externalId) return { type: 'ignore', reason: 'no_phone_or_id' }

  let kind: InboundKind
  let text: string | null = null
  let mediaUrl: string | null = null
  let mimeType: string | null = null
  let caption: string | null = null
  if (isObj(payload.text) && str(payload.text.message)) {
    kind = 'text'
    text = payload.text.message
  } else if (isObj(payload.buttonsResponseMessage) && str(payload.buttonsResponseMessage.message)) {
    kind = 'text'
    text = payload.buttonsResponseMessage.message
  } else if (isObj(payload.listResponseMessage) && str(payload.listResponseMessage.message)) {
    kind = 'text'
    text = payload.listResponseMessage.message
  } else if (isObj(payload.audio)) {
    kind = 'audio'
    mediaUrl = str(payload.audio.audioUrl)
    mimeType = str(payload.audio.mimeType)
  } else if (isObj(payload.image)) {
    kind = 'image'
    mediaUrl = str(payload.image.imageUrl)
    mimeType = str(payload.image.mimeType)
    caption = str(payload.image.caption)
  } else if (isObj(payload.sticker)) {
    kind = 'sticker'
  } else if (isObj(payload.video) || isObj(payload.document) || isObj(payload.location) || isObj(payload.contact)) {
    kind = 'other'
  } else {
    return { type: 'ignore', reason: 'unsupported_content' } // reactions, polls, events...
  }

  if (payload.fromMe === true) {
    const body =
      kind === 'text' ? text : kind === 'audio' ? '[áudio]' : kind === 'image' ? '[imagem]' : kind === 'sticker' ? '[figurinha]' : '[arquivo]'
    return { type: 'from_me', phone, externalId, fromApi: payload.fromApi === true, kind, body, sentAt: providerTime(payload.momment) }
  }
  return { type: 'inbound', phone, externalId, kind, text, mediaUrl, mimeType, caption, sentAt: providerTime(payload.momment) }
}

export interface SendResult {
  messageId: string | null
}

/** POST https://api.z-api.io/instances/{instanceId}/token/{token}/send-text, header Client-Token. */
export async function sendText(fetchFn: FetchFn, cfg: Config['zapi'], phone: string, message: string): Promise<SendResult> {
  const url = `https://api.z-api.io/instances/${encodeURIComponent(cfg.instanceId)}/token/${encodeURIComponent(cfg.token)}/send-text`
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': cfg.clientToken },
    body: JSON.stringify({ phone, message }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`zapi send failed: HTTP ${res.status}`)
  const json = (await res.json().catch(() => null)) as { messageId?: unknown; id?: unknown } | null
  const id = str(json?.messageId) ?? str(json?.id)
  return { messageId: id }
}
