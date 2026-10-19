// Code gates ("the model proposes, code disposes"). Pure functions, unit tested.
import { parseInstant, tsKey } from './time.ts'
import type { OptionRef } from './reply.ts'
import type { Conversation, PendingAction } from './types.ts'

export const PENDING_TTL_MS = 30 * 60_000
export const OPTIONS_TTL_MS = 30 * 60_000

export type OptionResult = { ok: true; option: OptionRef } | { ok: false; code: 'OPTION_EXPIRED' | 'INVALID_ARGUMENT'; message: string }

/**
 * propose_* takes an option TOKEN, never a timestamp: the professional, service, action and start come from what
 * get_availability stored for this conversation, and only if that was no more than 30 minutes ago.
 */
export function resolveOption(conv: Pick<Conversation, 'last_options' | 'options_at'>, token: unknown, nowMs: number): OptionResult {
  const at = parseInstant(conv.options_at)
  if (!conv.last_options?.length || at === null || nowMs - at > OPTIONS_TTL_MS || nowMs < at) {
    return { ok: false, code: 'OPTION_EXPIRED', message: 'As opções expiraram. Chame get_availability de novo.' }
  }
  const o = typeof token === 'string' ? conv.last_options.find((x) => x.token === token.trim().replace(/^\{|\}$/g, '')) : undefined
  return o ? { ok: true, option: o } : { ok: false, code: 'INVALID_ARGUMENT', message: 'option inválida: use um token devolvido por get_availability.' }
}

export type GateResult = { ok: true } | { ok: false; error: 'NO_PENDING' | 'EXPIRED' | 'NOT_PRESENTED' | 'NO_CLIENT_REPLY'; message: string }

/**
 * confirm_pending is allowed only when:
 *  - a pending_action exists and has not expired;
 *  - its summary was actually sent to the client (presented_baseline);
 *  - an inbound message arrived AFTER that (database clock: latestInboundAt > presented_baseline).
 * `latestInboundAt` is the newest inbound in the snapshot the current run started from, so a proposal made
 * inside the current run can never be confirmed by the same run.
 */
export function checkPendingGate(pending: PendingAction | null | undefined, nowMs: number, latestInboundAt: string | null): GateResult {
  if (!pending) return { ok: false, error: 'NO_PENDING', message: 'Não há nada aguardando confirmação.' }
  const exp = parseInstant(pending.expires_at)
  if (exp === null || nowMs > exp) return { ok: false, error: 'EXPIRED', message: 'A proposta expirou. Faça uma nova proposta.' }
  const base = tsKey(pending.presented_baseline ?? null)
  if (base === null) {
    return { ok: false, error: 'NOT_PRESENTED', message: 'O resumo ainda não foi enviado à cliente. Apresente o resumo e aguarde a resposta.' }
  }
  const last = tsKey(latestInboundAt)
  if (last === null || last <= base) {
    return { ok: false, error: 'NO_CLIENT_REPLY', message: 'A cliente ainda não respondeu ao resumo. Aguarde a resposta dela.' }
  }
  return { ok: true }
}

/** Ownership guard: an id is accepted only when it belongs to this conversation's known client set. */
export function isKnownClient(conv: Pick<Conversation, 'known_client_ids'>, clientId: unknown): clientId is string {
  return typeof clientId === 'string' && conv.known_client_ids.includes(clientId)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

export type ArgResult<T> = { ok: true; value: T } | { ok: false; message: string }

export const argUuid = (v: unknown, name: string): ArgResult<string> =>
  isUuid(v) ? { ok: true, value: v.toLowerCase() } : { ok: false, message: `${name} inválido` }

export const argUuidList = (v: unknown, name: string, max = 5): ArgResult<string[]> => {
  if (v === undefined || v === null) return { ok: true, value: [] }
  if (!Array.isArray(v) || v.length > max || !v.every(isUuid)) return { ok: false, message: `${name} inválido` }
  return { ok: true, value: [...new Set(v.map((x) => x.toLowerCase()))] }
}

export const argEnum = <T extends string>(v: unknown, allowed: readonly T[], name: string): ArgResult<T> =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? { ok: true, value: v as T } : { ok: false, message: `${name} inválido` }

export const argText = (v: unknown, name: string, min: number, max: number): ArgResult<string> => {
  if (typeof v !== 'string') return { ok: false, message: `${name} inválido` }
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length >= min && s.length <= max ? { ok: true, value: s } : { ok: false, message: `${name} deve ter entre ${min} e ${max} caracteres` }
}

/** Whether the away message is due: never sent, or sent more than 12h ago. */
export function awayDue(awaySentAt: string | null, nowMs: number): boolean {
  if (!awaySentAt) return true
  const t = parseInstant(awaySentAt)
  return t === null || nowMs - t >= 12 * 3_600_000
}

/** Debounce: continue only when this message is still the newest inbound of the conversation. */
export function isLatestInbound(latestExternalId: string | null | undefined, myExternalId: string): boolean {
  return latestExternalId === myExternalId
}
