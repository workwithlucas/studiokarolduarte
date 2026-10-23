// Reply guards ("the model proposes, code disposes"): what the client reads is built or checked in code.
//  - After a successful confirm_pending / confirm_attendance the reply is a code template and the model text is dropped.
//  - Otherwise the model text must pass the guards: no literal times or dates, no day words after availability tools,
//    no claim of a done action without a matching write, no promise. Options are written only as tokens ({o1}…).


export type WriteKind = 'book' | 'reschedule' | 'cancel' | 'confirm'

export interface OptionRef {
  token: string
  professional_id: string
  service_id: string
  action: string
  starts_at: string
  label: string
}

export type ConfirmedWrite =
  | { kind: 'book'; clientName: string | null; service: string; professional: string; label: string; packageRemaining: number | null }
  | { kind: 'reschedule'; service: string; label: string }
  | { kind: 'cancel'; service: string; label: string; package: boolean }
  | { kind: 'confirm'; label: string }

export interface Violation {
  rule: 'time' | 'date' | 'day_word' | 'claim' | 'promise' | 'token'
  match: string
}

export const FALLBACK_TEXT = 'Só um instante, vou confirmar isso com a Karol e já te retorno.'

const L = '(?<![A-Za-zÀ-ÿ])' // \b is ASCII-only
const R = '(?![A-Za-zÀ-ÿ])'
const TOKEN_RE = /\{([a-z][a-z0-9_]*)\}/g

const TIME_RE = /(?<![\d:])(?:[01]?\d|2[0-3])(?::[0-5]\d|\s?h(?:[0-5]\d)?(?![A-Za-zÀ-ÿ]))/i
const DATE_RE = /(?<![\d/])(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/(?:\d{4}|\d{2}))?(?![\d/])/
const DAY_WORD_RE = new RegExp(`${L}(?:hoje|amanh[ãa]|depois\\s+de\\s+amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?${R}`, 'i')

/** [pattern, write kinds that make the claim true]. */
const CLAIMS: Array<[RegExp, WriteKind[]]> = [
  [new RegExp(`${L}(?:marquei|agendei|reservei|agendad[oa]s?|marcad[oa]s?|reservad[oa]s?)${R}`, 'i'), ['book', 'reschedule']],
  [new RegExp(`${L}(?:remarquei|remarcad[oa]s?)${R}`, 'i'), ['reschedule']],
  [new RegExp(`${L}(?:desmarquei|desmarcad[oa]s?|cancelei|cancelad[oa]s?)${R}`, 'i'), ['cancel']],
  [new RegExp(`${L}(?:confirmei|confirmad[oa]s?)${R}`, 'i'), ['confirm']],
]

// "vou marcar", "vou te agendar", "vamos remarcar"… Telling the client the Karol will confirm something is allowed.
const PROMISE_RE = new RegExp(
  `${L}(?:vou|vamos|irei|farei)\\s+(?:(?:j[áa]|logo|agora|te|lhe|ent[ãa]o|tamb[ée]m|s[óo])\\s+)*` +
    `(?:marcar|agendar|reservar|remarcar|desmarcar|cancelar|confirmar|ajustar)${R}` +
    `(?!\\s+(?:isso\\s+|essa\\s+informa[çc][ãa]o\\s+|tudo\\s+)?(?:com|c/)\\s+(?:a\\s+)?(?:karol|equipe|studio))`,
  'i',
)

export interface GuardInput {
  /** This run used get_availability, propose_* or list_my_appointments: day words are then forbidden. */
  usedDayTools: boolean
  writes: ReadonlySet<WriteKind>
  /** Tokens the model may write: {o1}…{o12} (options), {resumo}, {pN_vence}. */
  tokens: Readonly<Record<string, string>>
}

export function findViolations(text: string, g: GuardInput): Violation[] {
  const out: Violation[] = []
  const unknown: string[] = []
  const bare = text.replace(TOKEN_RE, (m, name: string) => {
    if (!(name in g.tokens)) unknown.push(m)
    return ' '
  })
  for (const u of unknown) out.push({ rule: 'token', match: u })
  const t = TIME_RE.exec(bare)
  if (t) out.push({ rule: 'time', match: t[0] })
  const d = DATE_RE.exec(bare)
  if (d) out.push({ rule: 'date', match: d[0] })
  if (g.usedDayTools) {
    const w = DAY_WORD_RE.exec(bare)
    if (w) out.push({ rule: 'day_word', match: w[0] })
  }
  for (const [re, kinds] of CLAIMS) {
    const m = re.exec(bare)
    if (m && !kinds.some((k) => g.writes.has(k))) out.push({ rule: 'claim', match: m[0] })
  }
  const p = PROMISE_RE.exec(bare)
  if (p) out.push({ rule: 'promise', match: p[0] })
  return out
}

const RULE_TEXT: Record<Violation['rule'], string> = {
  time: 'nunca escreva horários (como 17:00, 17h ou 17h30); escreva só o token da opção, por exemplo {o1}',
  date: 'nunca escreva datas (como 21/10); escreva só o token da opção, por exemplo {o1}',
  day_word: 'nunca escreva dias (hoje, amanhã, depois de amanhã ou dia da semana); escreva só o token da opção, por exemplo {o1}',
  claim: 'nunca diga que uma ação foi feita (marquei, agendei, remarquei, cancelei, confirmei…); o sistema confirma sozinho depois que você chama confirm_pending',
  promise: 'nunca prometa uma ação (vou marcar, vou cancelar…); chame a ferramenta agora ou peça a informação que falta',
  token: 'use apenas tokens de opção que get_availability devolveu nesta conversa',
}

/** Corrective system note for the regeneration call: names every rule that was broken. */
export function correctionNote(violations: Violation[]): string {
  const rules = [...new Set(violations.map((v) => v.rule))]
  const lines = rules.map((r) => `- ${RULE_TEXT[r]}.`)
  return `CORREÇÃO OBRIGATÓRIA: sua resposta anterior quebrou regras de segurança (${violations.map((v) => `"${v.match}"`).join(', ')}). Reescreva a resposta respeitando:\n${lines.join('\n')}`
}

/** {o1} -> label. Unknown tokens are left out (findViolations flags them first). */
export function expandTokens(text: string, tokens: Readonly<Record<string, string>>): string {
  return text.replace(TOKEN_RE, (_m, name: string) => (name in tokens ? tokens[name]! : ''))
}

export function optionTokens(options: ReadonlyArray<Pick<OptionRef, 'token' | 'label'>>): Record<string, string> {
  return Object.fromEntries(options.map((o) => [o.token, o.label]))
}

/** The address line of the knowledge base, or null when it is missing or still a TODO. */
export function addressLineOf(kb: string): string | null {
  const m = /Endere[çc]o e como chegar:\s*(.+)/.exec(kb)
  const v = m?.[1]?.trim()
  return v && !/^TODO/i.test(v) ? v : null
}

/**
 * The reply for a run in which a confirm succeeded: built by code from the results, the model text is dropped.
 * Returns at most 2 messages (the sentence(s), then the address line).
 */
export function confirmedReply(writes: ConfirmedWrite[], address: string | null): string[] {
  const sentences: string[] = []
  const attendance = writes.filter((w): w is Extract<ConfirmedWrite, { kind: 'confirm' }> => w.kind === 'confirm')
  let wantsAddress = false
  for (const w of writes) {
    if (w.kind === 'book') {
      const who = w.clientName ? `Pronto, ${w.clientName}!` : 'Pronto!'
      sentences.push(`${who} Agendei ${w.service} com ${w.professional} ${w.label}.`)
      if (w.packageRemaining !== null) sentences.push(`Vai usar uma sessão do seu pacote (restam ${w.packageRemaining}).`)
      wantsAddress = true
    } else if (w.kind === 'reschedule') {
      sentences.push(`Remarquei seu ${w.service} para ${w.label}.`)
      wantsAddress = true
    } else if (w.kind === 'cancel') {
      sentences.push(`Cancelei seu ${w.service} de ${w.label}.${w.package ? ' A sessão do pacote volta para você.' : ''} Se quiser remarcar é só me falar.`)
    }
  }
  if (attendance.length) sentences.push(`Confirmado! Te esperamos ${attendance.map((a) => a.label).join(' e ')}.`)
  const parts = [sentences.join(' ')]
  if (wantsAddress && address) parts.push(`Endereço: ${address}`)
  return parts
}
