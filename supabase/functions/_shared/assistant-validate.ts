// Pure validation for the finance assistant: date refs, money, categories, methods, text guard, picks.
// Dates never go through `new Date(x)` on unvalidated input (time.ts helpers only).
import type { ChoiceCard, ChoiceOption } from './assistant-types.ts'
import { addDays, spParts, validYmd } from './time.ts'

export const MAX_AMOUNT_CENTS = 5_000_000
export const HIGH_VALUE_CENTS = 1_000_000

export const METHODS = ['pix', 'cash', 'debit', 'credit', 'barter', 'credit_balance'] as const
export type Method = (typeof METHODS)[number]

export const CATEGORIES = ['Aluguel', 'Materiais', 'Produtos', 'Contas', 'Marketing', 'Impostos', 'Outros'] as const

export type Failure = { ok: false; code: string; message: string }
export type Checked<T> = { ok: true; value: T } | Failure
const bad = (code: string, message: string): Failure => ({ ok: false, code, message })

// ---------------------------------------------------------------- date_ref
const REF_KINDS = ['today', 'yesterday', 'tomorrow', 'date', 'day_of_month']

/** Resolves a date_ref in America/Sao_Paulo. Invalid input is a structured error, never a guess. */
export function resolveDateRef(ref: unknown, nowMs: number): Checked<string> {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return bad('DATE_INVALID', 'Data inválida.')
  const { kind, value } = ref as { kind?: unknown; value?: unknown }
  if (typeof kind !== 'string' || !REF_KINDS.includes(kind)) return bad('DATE_INVALID', 'Tipo de data inválido.')
  const today = spParts(nowMs).ymd
  if (kind === 'today') return { ok: true, value: today }
  if (kind === 'yesterday') return { ok: true, value: addDays(today, -1) }
  if (kind === 'tomorrow') return { ok: true, value: addDays(today, 1) }
  if (kind === 'date') {
    const ymd = validYmd(value)
    return ymd ? { ok: true, value: ymd } : bad('DATE_INVALID', 'Data inválida. Use o formato AAAA-MM-DD.')
  }
  const n = typeof value === 'string' && /^\d{1,2}$/.test(value.trim()) ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 31) return bad('DATE_INVALID', 'Dia do mês inválido.')
  const ymd = validYmd(`${today.slice(0, 8)}${String(n).padStart(2, '0')}`) // day of the current month
  return ymd ? { ok: true, value: ymd } : bad('DATE_INVALID', 'Esse dia não existe neste mês.')
}

// ---------------------------------------------------------------- money and categories
export function validateAmount(v: unknown): Checked<number> {
  if (typeof v !== 'number' || !Number.isInteger(v)) return bad('BAD_AMOUNT', 'O valor deve ser um número inteiro de centavos.')
  if (v <= 0) return bad('BAD_AMOUNT', 'O valor deve ser maior que zero.')
  if (v > MAX_AMOUNT_CENTS) return bad('BAD_AMOUNT', 'O valor passa do limite do assistente.')
  return { ok: true, value: v }
}

export const isHighValue = (cents: number): boolean => cents > HIGH_VALUE_CENTS

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

export function normalizeCategory(v: unknown): (typeof CATEGORIES)[number] {
  if (typeof v !== 'string') return 'Outros'
  const f = fold(v)
  return CATEGORIES.find((c) => fold(c) === f) ?? 'Outros'
}

export function validateMethod(v: unknown, allowed: readonly Method[]): Checked<Method> {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? { ok: true, value: v as Method }
    : bad('METHOD_NOT_ALLOWED', 'Forma de pagamento inválida.')
}

export function cleanText(v: unknown, min: number, max: number, name: string): Checked<string> {
  if (typeof v !== 'string') return bad('BAD_TEXT', `${name} inválido.`)
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length >= min && s.length <= max ? { ok: true, value: s } : bad('BAD_TEXT', `${name} deve ter entre ${min} e ${max} caracteres.`)
}

/** Case and accent-insensitive "contains". */
export const foldedIncludes = (haystack: string, needle: string): boolean => fold(haystack).includes(fold(needle))

// ---------------------------------------------------------------- text guard
/** Model text may carry no digits and no "R$": every number reaches the owner through a card built by code. */
export const violatesTextGuard = (text: string): boolean => /\p{Nd}|R\$/u.test(text)

export const GUARD_FALLBACK = 'Não consegui responder com segurança. Pode reformular?'
export const GUARD_NOTE =
  'CORREÇÃO OBRIGATÓRIA: sua resposta anterior continha dígitos ou "R$". Reescreva sem nenhum dígito e sem "R$". Valores, datas e detalhes aparecem no cartão montado pelo sistema; diga apenas, em palavras, o que foi preparado.'

// ---------------------------------------------------------------- formatting (cards)
export function fmtMoney(cents: number): string {
  const neg = cents < 0
  const abs = Math.abs(Math.trunc(cents))
  const reais = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${neg ? '-' : ''}R$ ${reais},${String(abs % 100).padStart(2, '0')}`
}

export function fmtDate(ymd: unknown): string {
  const v = validYmd(ymd)
  return v ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : '—'
}

export const METHOD_LABEL: Record<string, string> = {
  pix: 'Pix',
  cash: 'Dinheiro',
  debit: 'Débito',
  credit: 'Crédito',
  barter: 'Permuta',
  credit_balance: 'Saldo de crédito',
  adjustment: 'Saldo anterior',
}

// ---------------------------------------------------------------- picks
/** A pick is valid only when it names an unresolved choice card and one of ITS stored candidates. */
export function validatePick(card: ChoiceCard | null | undefined, resolved: boolean, choiceId: unknown, value: unknown): Checked<ChoiceOption> {
  if (!card || card.kind !== 'choice' || resolved) return bad('PICK_INVALID', 'Essa escolha não está mais disponível.')
  if (typeof choiceId !== 'string' || choiceId !== card.choice_id) return bad('PICK_INVALID', 'Essa escolha não está mais disponível.')
  const opt = typeof value === 'string' ? card.options.find((o) => o.value === value) : undefined
  return opt ? { ok: true, value: opt } : bad('PICK_INVALID', 'Opção inválida.')
}

// ---------------------------------------------------------------- idempotency keys
/** Deterministic uuid from the pending id and the action index (retries reuse the same p_request_id). */
export async function derivedUuid(pendingId: string, index: number, salt = ''): Promise<string> {
  const data = new TextEncoder().encode(`assist:${pendingId}:${index}:${salt}`)
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0, 16)
  h[6] = (h[6]! & 0x0f) | 0x50
  h[8] = (h[8]! & 0x3f) | 0x80
  const x = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

export const importKey = (pendingId: string, index: number): string => `assist-${pendingId}-${index}`
