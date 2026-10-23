// Tools of the finance assistant. The model only READS and PROPOSES: every proposal is validated here, re-read from
// the database through rpc_*, and turned into a code-built summary. Nothing in this file writes to the ledger.
import type { Card, ChoiceCard, ChoiceOption, ChoiceSlot, FactsCard, PendingActionItem } from './assistant-types.ts'
import {
  CATEGORIES, METHOD_LABEL, cleanText, fmtDate, fmtMoney, foldedIncludes, isHighValue, normalizeCategory, resolveDateRef,
  validateAmount, validateMethod, violatesTextGuard, type Checked, type Method,
} from './assistant-validate.ts'
import { RpcFailure, callRpc } from './db.ts'
import { messageOfCode } from './errors-pt.ts'
import { isUuid } from './gates.ts'
import { addDays, parseInstant, spParts, validYmd, weekdayOfYmd } from './time.ts'
import type { Db } from './types.ts'

export const MAX_ROWS = 10
export const MAX_ACTIONS = 10
const WIDE_FROM = '2000-01-01'
const WIDE_TO = '2100-12-31'

export interface FindRow {
  entry_id: string
  payment_id: string | null
  client: string | null
  description: string
  service: string | null
  due_date: string
  status: string
  kind: string
  amount_cents: number
  open_cents: number
  paid_at: string | null
  method: string | null
  appointment_status: string | null
}

export interface ToolRun {
  /** Ids returned by reads in this thread (entries, payments, clients). Proposals accept only these. */
  known: Set<string>
  lastFind: { rows: FindRow[]; count: number } | null
  proposals: PendingActionItem[]
  readCards: Card[]
  choice: ChoiceCard | null
  question: Card | null
  toolLog: Array<{ name: string; ok: boolean; code?: string }>
  picks: Partial<Record<ChoiceSlot, string>>
  /** Set when a picked intent could not be rebuilt. */
  firstError?: string
}

export const newRun = (known: Iterable<string> = []): ToolRun => ({
  known: new Set(known), lastFind: null, proposals: [], readCards: [], choice: null, question: null, toolLog: [], picks: {},
})

export interface ToolCtx {
  userDb: Db
  now: () => number
  uuid: () => string
  run: ToolRun
}

type Fail = { ok: false; code: string; message: string; [k: string]: unknown }
export type ToolOut = { ok: true; [k: string]: unknown } | Fail
const fail = (code: string, message: string, extra: Record<string, unknown> = {}): Fail => ({ ok: false, code, message, ...extra })
const fromChecked = (c: { ok: false; code: string; message: string }): Fail => fail(c.code, c.message)

/** Text from the database that goes back to the model: data, never instructions. One short line. */
const safe = (v: unknown, max = 80): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

// ---------------------------------------------------------------- rpc helper
type Rpc<T> = { ok: true; data: T } | Fail
async function rpc<T = any>(ctx: ToolCtx, fn: string, args: Record<string, unknown>): Promise<Rpc<T>> {
  try {
    return { ok: true, data: await callRpc<T>(ctx.userDb, fn, args) }
  } catch (e) {
    if (e instanceof RpcFailure) return fail(e.code, messageOfCode(e.code, e.detail))
    return fail('INTERNAL', 'Não consegui consultar os dados agora. Tente de novo.')
  }
}

// ---------------------------------------------------------------- entry reads
export interface EntryView {
  entry_id: string
  kind: 'income' | 'expense'
  entry_type: string
  description: string
  category: string | null
  client_id: string | null
  client_name: string | null
  due_date: string
  created_at: string
  amount_cents: number
  discount_cents: number
  final_cents: number
  paid_cents: number
  open_cents: number
  status: string
  voided: boolean
  appointment_id: string | null
  appointment_status: string | null
  appointment_starts_at: string | null
  appointment_package_id: string | null
  service_name: string | null
  client_package_id: string | null
  payments: Array<{ payment_id: string; amount_cents: number; method: string; paid_at: string }>
  payment: { payment_id: string; amount_cents: number; method: string; paid_at: string; reversed: boolean } | null
  packages: Array<{ client_package_id: string; template_name: string; sessions_total: number; remaining: number; expires_at: string }>
}

async function readEntry(ctx: ToolCtx, by: { entry_id?: string; payment_id?: string }): Promise<Rpc<EntryView>> {
  const r = await rpc<EntryView | null>(ctx, 'rpc_finance_entry_by_id', { p_entry_id: by.entry_id ?? null, p_payment_id: by.payment_id ?? null })
  if (!r.ok) return r
  return r.data ? { ok: true, data: r.data } : fail('NOT_FOUND', messageOfCode('NOT_FOUND'))
}

const saoPauloDay = (ts: unknown): string => {
  const ms = parseInstant(ts)
  return ms === null ? '—' : fmtDate(spParts(ms).ymd)
}

const labelOf = (e: Pick<EntryView, 'client_name' | 'description' | 'service_name'>): string =>
  [e.client_name, e.service_name && e.service_name !== e.description ? e.service_name : e.description].filter(Boolean).join(' · ')

// ---------------------------------------------------------------- clients
interface ClientHit {
  id: string
  name: string
}

async function resolveClient(ctx: ToolCtx, toolName: string, input: Record<string, unknown>, query: unknown): Promise<{ ok: true; client: ClientHit } | Fail> {
  const q = cleanText(query, 2, 60, 'client_query')
  if (!q.ok) return fromChecked(q)
  const r = await rpc<any[]>(ctx, 'rpc_search_clients', { p_query: q.value, p_filter: 'all', p_limit: 8, p_offset: 0 })
  if (!r.ok) return r
  const hits: ClientHit[] = (r.data ?? []).filter((c) => !c.archived).map((c) => ({ id: c.client_id as string, name: safe(c.name) }))
  const picked = ctx.run.picks.client_id
  if (picked) {
    const h = hits.find((x) => x.id === picked)
    return h ? { ok: true, client: h } : fail('NOT_FOUND', 'Cliente não encontrada.')
  }
  if (hits.length === 0) return fail('CLIENT_NOT_FOUND', 'Nenhuma cliente encontrada com esse nome.')
  const exact = hits.filter((h) => foldedIncludes(h.name, q.value) && foldedIncludes(q.value, h.name))
  const only = hits.length === 1 ? hits[0]! : exact.length === 1 ? exact[0]! : null
  if (only) {
    ctx.run.known.add(only.id)
    return { ok: true, client: only }
  }
  const options: ChoiceOption[] = hits.map((h) => ({ label: h.name, detail: 'Cliente', value: h.id }))
  ctx.run.choice = {
    kind: 'choice', choice_id: ctx.uuid(), slot: 'client_id', question: 'Qual cliente?', options,
    intent: { tool: toolName, input, carry: [...ctx.run.proposals] },
  }
  return fail('NEEDS_CHOICE', 'Há mais de uma cliente com esse nome. O sistema vai pedir a escolha; encerre sem texto.')
}

// ---------------------------------------------------------------- ambiguity gate
type Gate = { ok: true } | Fail

/** An id must be known; and an id picked out of a find_entries result with several candidates needs the owner's pick. */
function gateId(ctx: ToolCtx, slot: 'entry_id' | 'payment_id', id: string, toolName: string, input: Record<string, unknown>, plausible: (r: FindRow) => boolean = () => true): Gate {
  if (ctx.run.picks[slot] === id) return { ok: true }
  if (!ctx.run.known.has(id)) return fail('UNKNOWN_ID', 'Esse identificador não veio de uma consulta desta conversa. Use find_entries ou get_entry primeiro.')
  const lf = ctx.run.lastFind
  if (lf) {
    const distinct = new Map<string, FindRow>()
    for (const r of lf.rows) {
      const key = r[slot]
      if (key && plausible(r) && !distinct.has(key)) distinct.set(key, r)
    }
    if (distinct.has(id) && (distinct.size > 1 || lf.count > lf.rows.length)) {
      const options: ChoiceOption[] = [...distinct.entries()].map(([value, r]) => ({
        label: [r.client, r.service && r.service !== r.description ? r.service : r.description].filter(Boolean).join(' · ') || r.description,
        detail: [fmtDate(r.due_date), fmtMoney(slot === 'payment_id' ? r.amount_cents : r.open_cents > 0 ? r.open_cents : r.amount_cents)].join(' · '),
        value,
      }))
      ctx.run.choice = {
        kind: 'choice', choice_id: ctx.uuid(), slot,
        question: slot === 'payment_id' ? 'Qual destes pagamentos?' : 'Qual destes lançamentos?',
        options, intent: { tool: toolName, input, carry: [...ctx.run.proposals] },
      }
      return fail('NEEDS_CHOICE', 'Há mais de um candidato. O sistema vai pedir a escolha; encerre sem texto.')
    }
  }
  return { ok: true }
}

function pushProposal(ctx: ToolCtx, item: PendingActionItem): ToolOut {
  if (ctx.run.proposals.length >= MAX_ACTIONS) return fail('TOO_MANY_ACTIONS', 'No máximo 10 ações por mensagem.')
  ctx.run.proposals.push(item)
  return { ok: true, proposed: true, index: ctx.run.proposals.length - 1, note: 'Proposta registrada. O cartão com os detalhes é montado pelo sistema.' }
}

const line = (label: string, value: string) => ({ label, value })
const payLine = (p: { amount_cents: number; method: string }) => `${METHOD_LABEL[p.method] ?? p.method}: ${fmtMoney(p.amount_cents)}`

// ---------------------------------------------------------------- date helpers
function daysBetween(a: string, b: string): number {
  const p = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)))
  return Math.round((p(b) - p(a)) / 86_400_000)
}

function optDate(ctx: ToolCtx, ref: unknown): Checked<string | null> {
  if (ref === undefined || ref === null) return { ok: true, value: null }
  return resolveDateRef(ref, ctx.now())
}

// ---------------------------------------------------------------- reads
const FIND_STATUS = ['expected', 'partial', 'overdue', 'paid', 'today'] as const

async function findEntries(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const mode = input.mode
  if (mode !== 'receivable' && mode !== 'payable' && mode !== 'statement') return fail('BAD_ARGUMENT', 'mode deve ser receivable, payable ou statement.')
  const single = optDate(ctx, input.date_ref)
  const from = optDate(ctx, input.date_from)
  const to = optDate(ctx, input.date_to)
  for (const d of [single, from, to]) if (!d.ok) return fromChecked(d)
  const dSingle = (single as { value: string | null }).value
  let dFrom = dSingle ?? (from as { value: string | null }).value
  let dTo = dSingle ?? (to as { value: string | null }).value
  const cq = input.client_query === undefined ? null : cleanText(input.client_query, 1, 60, 'client_query')
  const dq = input.description_query === undefined ? null : cleanText(input.description_query, 1, 60, 'description_query')
  if (cq && !cq.ok) return fromChecked(cq)
  if (dq && !dq.ok) return fromChecked(dq)
  let status: string | null = null
  if (input.status !== undefined && input.status !== null) {
    const ok = mode === 'statement' ? typeof input.status === 'string' && ['pix', 'cash', 'debit', 'credit', 'barter'].includes(input.status) : (FIND_STATUS as readonly string[]).includes(input.status as string)
    if (!ok) return fail('BAD_ARGUMENT', 'status inválido para este modo.')
    status = input.status as string
  }
  const today = spParts(ctx.now()).ymd
  const ranged = dFrom !== null || dTo !== null
  if (mode === 'statement') {
    dTo = dTo ?? today
    dFrom = dFrom ?? addDays(dTo, -30)
  } else {
    dFrom = dFrom ?? WIDE_FROM
    dTo = dTo ?? WIDE_TO
  }
  if (dTo < dFrom) return fail('DATE_INVALID', 'A data final vem antes da inicial.')
  const r = await rpc<any[]>(ctx, 'rpc_finance_list', {
    p_mode: mode, p_from: dFrom, p_to: dTo, p_status: status, p_professional_id: null, p_client_id: null,
    p_query: (cq?.ok ? cq.value : dq?.ok ? dq.value : null), p_include_reversed: false, p_limit: 200, p_offset: 0,
  })
  if (!r.ok) return r
  let rows = (r.data ?? []) as any[]
  if (mode !== 'statement' && ranged) rows = rows.filter((x) => typeof x.due_date === 'string' && x.due_date >= dFrom! && x.due_date <= dTo!)
  if (cq?.ok && dq?.ok) rows = rows.filter((x) => foldedIncludes(String(x.description ?? ''), dq.value))
  const total = rows.length
  const view: FindRow[] = rows.slice(0, MAX_ROWS).map((x) => ({
    entry_id: x.entry_id, payment_id: x.payment_id ?? null, client: x.client_name ? safe(x.client_name) : null,
    description: safe(x.description), service: x.service_name ? safe(x.service_name) : null, due_date: x.due_date, status: x.status,
    kind: x.kind, amount_cents: mode === 'statement' ? x.payment_cents : x.final_cents, open_cents: x.open_cents ?? 0,
    paid_at: x.paid_at ?? null, method: x.method ?? null, appointment_status: x.appointment_id ? x.appointment_status ?? null : null,
  }))
  for (const v of view) {
    ctx.run.known.add(v.entry_id)
    if (v.payment_id) ctx.run.known.add(v.payment_id)
  }
  ctx.run.lastFind = { rows: view, count: total }
  const title = mode === 'receivable' ? 'A receber' : mode === 'payable' ? 'A pagar' : 'Pagamentos recebidos'
  ctx.run.readCards.push({
    kind: 'entries', title, total,
    rows: view.map((v) => ({
      title: [v.client, v.service && v.service !== v.description ? v.service : v.description].filter(Boolean).join(' · ') || v.description,
      detail: mode === 'statement' ? `${METHOD_LABEL[v.method ?? ''] ?? v.method ?? ''} · ${saoPauloDay(v.paid_at)}` : fmtDate(v.due_date),
      value: fmtMoney(mode === 'statement' ? v.amount_cents : v.open_cents > 0 ? v.open_cents : v.amount_cents),
      status: mode === 'statement' ? 'Recebido' : ({ expected: 'Previsto', partial: 'Parcial', overdue: 'Atrasado', paid: 'Pago' } as Record<string, string>)[v.status] ?? v.status,
    })),
  })
  return { ok: true, total, shown: view.length, truncated: total > view.length, rows: view }
}

async function getEntryTool(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const id = input.entry_id
  if (!isUuid(id)) return fail('BAD_ARGUMENT', 'entry_id inválido.')
  if (!ctx.run.known.has(id) && ctx.run.picks.entry_id !== id) return fail('UNKNOWN_ID', 'Esse identificador não veio de uma consulta desta conversa.')
  const e = await readEntry(ctx, { entry_id: id })
  if (!e.ok) return e
  const v = e.data
  for (const p of v.payments) ctx.run.known.add(p.payment_id)
  if (v.client_id) ctx.run.known.add(v.client_id)
  const lines = [
    line('Lançamento', safe(v.description)),
    ...(v.client_name ? [line('Cliente', safe(v.client_name))] : []),
    line('Data', fmtDate(v.due_date)),
    line('Valor', fmtMoney(v.amount_cents)),
    ...(v.discount_cents > 0 ? [line('Desconto', fmtMoney(v.discount_cents))] : []),
    line('Pago', fmtMoney(v.paid_cents)),
    line('Em aberto', fmtMoney(v.open_cents)),
    ...v.payments.map((p) => line('Pagamento', `${payLine(p)} · ${saoPauloDay(p.paid_at)}`)),
  ]
  ctx.run.readCards.push({ kind: 'facts', title: v.voided ? 'Lançamento cancelado' : 'Lançamento', lines })
  return {
    ok: true,
    entry: {
      entry_id: v.entry_id, kind: v.kind, description: safe(v.description), client: v.client_name ? safe(v.client_name) : null,
      due_date: v.due_date, status: v.status, voided: v.voided, amount_cents: v.amount_cents, open_cents: v.open_cents,
      appointment_status: v.appointment_status, has_package: !!v.appointment_package_id,
      payments: v.payments.map((p) => ({ payment_id: p.payment_id, amount_cents: p.amount_cents, method: p.method })),
    },
  }
}

function periodRange(ctx: ToolCtx, input: Record<string, unknown>): Checked<{ from: string; to: string; label: string }> {
  const today = spParts(ctx.now()).ymd
  const p = input.period
  if (p === 'today') return { ok: true, value: { from: today, to: today, label: `Hoje (${fmtDate(today)})` } }
  if (p === 'week') {
    const back = (weekdayOfYmd(today) + 6) % 7 // Monday first
    const from = addDays(today, -back)
    const to = addDays(from, 6)
    return { ok: true, value: { from, to, label: `Semana (${fmtDate(from)} a ${fmtDate(to)})` } }
  }
  if (p === 'month') {
    const from = `${today.slice(0, 8)}01`
    let last = 31
    while (!validYmd(`${today.slice(0, 8)}${String(last).padStart(2, '0')}`)) last--
    const to = `${today.slice(0, 8)}${String(last).padStart(2, '0')}`
    return { ok: true, value: { from, to, label: `Mês (${fmtDate(from)} a ${fmtDate(to)})` } }
  }
  if (p === 'date_range') {
    const f = resolveDateRef(input.date_from, ctx.now())
    const t = resolveDateRef(input.date_to, ctx.now())
    if (!f.ok) return f
    if (!t.ok) return t
    if (t.value < f.value) return { ok: false, code: 'DATE_INVALID', message: 'A data final vem antes da inicial.' }
    if (daysBetween(f.value, t.value) > 365) return { ok: false, code: 'RANGE_TOO_LARGE', message: messageOfCode('RANGE_TOO_LARGE') }
    return { ok: true, value: { from: f.value, to: t.value, label: `${fmtDate(f.value)} a ${fmtDate(t.value)}` } }
  }
  return { ok: false, code: 'BAD_ARGUMENT', message: 'period deve ser today, week, month ou date_range.' }
}

async function financeSummary(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const range = periodRange(ctx, input)
  if (!range.ok) return fromChecked(range)
  const r = await rpc<any>(ctx, 'rpc_finance_summary', { p_from: range.value.from, p_to: range.value.to, p_professional_id: null })
  if (!r.ok) return r
  const c = r.data?.cards ?? {}
  const lines = [
    line('Recebido', fmtMoney(c.received_cents ?? 0)),
    line('A receber', fmtMoney(c.receivable_cents ?? 0)),
    line('Atrasado', fmtMoney(c.overdue_cents ?? 0)),
    line('Despesas pagas', fmtMoney(c.expenses_paid_cents ?? 0)),
    line('Resultado', fmtMoney(c.result_cents ?? 0)),
    ...((r.data?.by_method ?? []) as Array<{ method: string; cents: number }>).map((m) => line(METHOD_LABEL[m.method] ?? m.method, fmtMoney(m.cents))),
  ]
  ctx.run.readCards.push({ kind: 'facts', title: `Resumo · ${range.value.label}`, lines })
  return { ok: true, period: String(input.period), note: 'O resumo com os valores foi mostrado ao usuário em um cartão. Não cite números.' }
}

async function clientAccount(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const c = await resolveClient(ctx, 'client_account', input, input.client_query)
  if (!c.ok) return c
  const a = await rpc<any>(ctx, 'rpc_get_client_account', { p_client_id: c.client.id })
  if (!a.ok) return a
  const lines = [
    line('Saldo de crédito', fmtMoney(a.data.credit_balance_cents ?? 0)),
    line('Dívida em aberto', fmtMoney(a.data.open_debt_cents ?? 0)),
    ...((a.data.open_entries ?? []) as any[]).slice(0, 5).map((e) => line(safe(e.description), `${fmtDate(e.due_date)} · ${fmtMoney(e.open_cents)}`)),
  ]
  const card: FactsCard = { kind: 'facts', title: `Conta de ${c.client.name}`, lines }
  ctx.run.readCards.push(card)
  return { ok: true, client: c.client.name, note: 'Os valores foram mostrados ao usuário em um cartão. Não cite números.' }
}

// ---------------------------------------------------------------- proposals: manual entries
const EXPENSE_METHODS: Method[] = ['pix', 'cash', 'debit', 'credit']
const INCOME_METHODS: Method[] = ['pix', 'cash', 'debit', 'credit', 'barter']

async function proposeManual(ctx: ToolCtx, kind: 'expense' | 'income', input: Record<string, unknown>): Promise<ToolOut> {
  const amount = validateAmount(input.amount_cents)
  if (!amount.ok) return fromChecked(amount)
  const reason = cleanText(kind === 'expense' ? input.reason : input.description, 1, 80, kind === 'expense' ? 'reason' : 'description')
  if (!reason.ok) return fromChecked(reason)
  let payee: string | null = null
  if (kind === 'expense' && input.payee !== undefined && input.payee !== null && input.payee !== '') {
    const p = cleanText(input.payee, 1, 60, 'payee')
    if (!p.ok) return fromChecked(p)
    payee = p.value
  }
  const date = input.date_ref === undefined || input.date_ref === null ? resolveDateRef({ kind: 'today' }, ctx.now()) : resolveDateRef(input.date_ref, ctx.now())
  if (!date.ok) return fromChecked(date)
  if (typeof input.paid !== 'boolean') return fail('BAD_ARGUMENT', 'paid deve ser true ou false.')
  let method: Method | null = null
  if (input.paid) {
    if (input.method === undefined || input.method === null) return fail('METHOD_REQUIRED', 'Falta a forma de pagamento. Pergunte com ask_user.')
    const m = validateMethod(input.method, kind === 'expense' ? EXPENSE_METHODS : INCOME_METHODS)
    if (!m.ok) return fromChecked(m)
    method = m.value
  }
  let client: ClientHit | null = null
  if (kind === 'income' && input.client_query !== undefined && input.client_query !== null && input.client_query !== '') {
    const c = await resolveClient(ctx, 'propose_income', input, input.client_query)
    if (!c.ok) return c
    client = c.client
  }
  const description = payee ? `${payee}: ${reason.value}` : reason.value
  const category = kind === 'expense' ? normalizeCategory(input.category) : null
  const dup = await rpc<boolean>(ctx, 'rpc_finance_find_duplicate', { p_kind: kind, p_description: description, p_amount_cents: amount.value, p_due_date: date.value })
  if (!dup.ok) return dup
  const warnings = [...(isHighValue(amount.value) ? ['Valor alto, confira'] : []), ...(dup.data ? ['Já existe um lançamento igual'] : [])]
  return pushProposal(ctx, {
    kind: 'create_entry',
    params: { entry_kind: kind, description, category, amount_cents: amount.value, due_date: date.value, client_id: client?.id ?? null, pay_now: !!input.paid, method },
    summary: {
      title: kind === 'expense' ? 'Lançar despesa' : 'Lançar receita',
      lines: [
        line('Descrição', description),
        ...(client ? [line('Cliente', client.name)] : []),
        ...(category ? [line('Categoria', category)] : []),
        line('Valor', fmtMoney(amount.value)),
        line('Data', fmtDate(date.value)),
        line('Situação', method ? `${kind === 'expense' ? 'Paga' : 'Recebida'} · ${METHOD_LABEL[method]}` : kind === 'expense' ? 'A pagar' : 'A receber'),
      ],
      warnings,
    },
  })
}

// ---------------------------------------------------------------- proposals: payments
interface PayLine {
  amount_cents: number
  method: Method
}

function parsePayments(raw: unknown, allowed: readonly Method[]): Checked<PayLine[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return { ok: false, code: 'BAD_AMOUNT', message: 'Informe de 1 a 4 pagamentos.' }
  const out: PayLine[] = []
  for (const p of raw) {
    const a = validateAmount((p as { amount_cents?: unknown })?.amount_cents)
    if (!a.ok) return a
    const m = validateMethod((p as { method?: unknown })?.method, allowed)
    if (!m.ok) return m
    out.push({ amount_cents: a.value, method: m.value })
  }
  return { ok: true, value: out }
}

async function creditBalance(ctx: ToolCtx, clientId: string): Promise<Rpc<{ credit: number; debt: number }>> {
  const a = await rpc<any>(ctx, 'rpc_get_client_account', { p_client_id: clientId })
  return a.ok ? { ok: true, data: { credit: a.data.credit_balance_cents ?? 0, debt: a.data.open_debt_cents ?? 0 } } : a
}

async function proposePayment(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const id = input.entry_id
  if (!isUuid(id)) return fail('BAD_ARGUMENT', 'entry_id inválido.')
  const g = gateId(ctx, 'entry_id', id, 'propose_payment', input)
  if (!g.ok) return g
  const e0 = await readEntry(ctx, { entry_id: id })
  if (!e0.ok) return e0
  const e = e0.data
  if (e.voided) return fail('BAD_TRANSITION', 'Lançamento cancelado.')
  if (e.entry_type === 'credit_deposit') return fail('BAD_TRANSITION', 'Crédito de cliente não recebe pagamentos por aqui.')
  if (e.appointment_package_id) return fail('BAD_AMOUNT', 'Atendimento de pacote não tem pagamento.')
  const allowed: Method[] = e.kind === 'expense' ? EXPENSE_METHODS : e.client_id ? [...INCOME_METHODS, 'credit_balance'] : INCOME_METHODS
  const pays = parsePayments(input.payments, allowed)
  if (!pays.ok) return fromChecked(pays)
  let discount: number | null = null
  if (input.discount_cents !== undefined && input.discount_cents !== null) {
    const d = input.discount_cents
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > e.amount_cents) return fail('BAD_DISCOUNT', messageOfCode('BAD_DISCOUNT'))
    discount = d
  }
  const disc = discount ?? e.discount_cents
  const sum = pays.value.reduce((s, p) => s + p.amount_cents, 0)
  if (e.amount_cents - disc < e.paid_cents) return fail('BAD_DISCOUNT', messageOfCode('BAD_DISCOUNT'))
  const remaining = e.amount_cents - disc - e.paid_cents
  if (sum > remaining) return fail('OVERPAYMENT', messageOfCode('OVERPAYMENT'))
  const credit = pays.value.filter((p) => p.method === 'credit_balance').reduce((s, p) => s + p.amount_cents, 0)
  if (credit > 0) {
    const bal = await creditBalance(ctx, e.client_id!)
    if (!bal.ok) return bal
    if (credit > bal.data.credit) return fail('CREDIT_INSUFFICIENT', messageOfCode('CREDIT_INSUFFICIENT'))
  }
  let kind: 'register_payments' | 'complete_and_pay'
  if (e.appointment_id) {
    if (e.appointment_status === 'completed') kind = 'register_payments'
    else if (e.appointment_status === 'scheduled' || e.appointment_status === 'confirmed') kind = 'complete_and_pay'
    else return fail('BAD_TRANSITION', messageOfCode('BAD_TRANSITION'))
  } else kind = 'register_payments'
  const after = remaining - sum
  return pushProposal(ctx, {
    kind,
    params: { entry_id: e.entry_id, appointment_id: e.appointment_id, payments: pays.value, discount_cents: discount },
    summary: {
      title: kind === 'complete_and_pay' ? 'Concluir atendimento e receber' : e.kind === 'expense' ? 'Pagar conta' : 'Dar baixa',
      lines: [
        line('Lançamento', safe(labelOf(e), 120)),
        line('Data', fmtDate(e.due_date)),
        line('Valor', fmtMoney(e.amount_cents)),
        ...(discount !== null && discount !== e.discount_cents ? [line('Desconto', fmtMoney(discount))] : e.discount_cents > 0 ? [line('Desconto', fmtMoney(e.discount_cents))] : []),
        ...pays.value.map((p) => line('Pagamento', payLine(p))),
        line('Saldo depois', after === 0 ? 'Quitado' : fmtMoney(after)),
        ...(kind === 'complete_and_pay' ? [line('Atendimento', 'vai concluir o atendimento e receber')] : []),
      ],
      warnings: [...(pays.value.some((p) => isHighValue(p.amount_cents)) ? ['Valor alto, confira'] : [])],
    },
  })
}

// ---------------------------------------------------------------- proposals: package
async function proposeUsePackage(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const id = input.entry_id
  if (!isUuid(id)) return fail('BAD_ARGUMENT', 'entry_id inválido.')
  if (input.client_package_id !== undefined && input.client_package_id !== null && !isUuid(input.client_package_id)) return fail('BAD_ARGUMENT', 'client_package_id inválido.')
  const g = gateId(ctx, 'entry_id', id, 'propose_use_package', input, (r) => ['scheduled', 'confirmed', 'completed'].includes(r.appointment_status ?? '')) // a package sale is not a session
  if (!g.ok) return g
  const e0 = await readEntry(ctx, { entry_id: id })
  if (!e0.ok) return e0
  const e = e0.data
  if (e.voided || e.kind !== 'income' || !e.appointment_id) return fail('BAD_TRANSITION', 'Só dá para usar pacote em lançamento de atendimento.')
  if (!['scheduled', 'confirmed', 'completed'].includes(e.appointment_status ?? '')) return fail('BAD_TRANSITION', messageOfCode('BAD_TRANSITION'))
  if (e.appointment_package_id) return fail('PACKAGE_INVALID', 'Este atendimento já usa um pacote.')
  if (e.payments.length > 0) return fail('HAS_PAYMENTS', messageOfCode('HAS_PAYMENTS'))
  const el = await rpc<any[]>(ctx, 'rpc_eligible_packages', { p_appointment_id: e.appointment_id })
  if (!el.ok) return el
  const eligible = el.data ?? []
  const wanted = (input.client_package_id as string | undefined) ?? null
  const chosen = wanted ? eligible.find((p) => p.client_package_id === wanted) : eligible[0]
  if (!chosen) {
    const mine = e.packages
    const reason = mine.length === 0 ? 'none' : mine.every((p) => p.remaining <= 0) ? 'empty' : 'expired'
    const code = reason === 'none' ? 'PACKAGE_INVALID' : reason === 'empty' ? 'PACKAGE_EMPTY' : 'PACKAGE_EXPIRED'
    const message = reason === 'none' ? 'A cliente não tem pacote deste serviço.' : wanted && eligible.length ? 'Esse pacote não serve para este atendimento.' : messageOfCode(code)
    return fail(code, message, { reason: wanted && eligible.length ? 'not_eligible' : reason })
  }
  const meta = e.packages.find((p) => p.client_package_id === chosen.client_package_id)
  const total = meta?.sessions_total ?? 0
  const session = total - chosen.remaining + 1
  const kind = e.appointment_status === 'completed' ? 'apply_package' : 'complete_and_pay'
  return pushProposal(ctx, {
    kind,
    params: { entry_id: e.entry_id, appointment_id: e.appointment_id, client_package_id: chosen.client_package_id },
    summary: {
      title: kind === 'complete_and_pay' ? 'Concluir atendimento com pacote' : 'Usar pacote no atendimento',
      lines: [
        line('Lançamento', safe(labelOf(e), 120)),
        line('Data', fmtDate(e.due_date)),
        line('Pacote', safe(chosen.template_name)),
        line('Uso', `usa 1 sessão do pacote (sessão ${session}/${total}, restam ${chosen.remaining - 1})`),
        line('Valor depois', fmtMoney(0)),
        ...(kind === 'complete_and_pay' ? [line('Atendimento', 'vai concluir o atendimento com a sessão do pacote')] : []),
      ],
      warnings: [],
    },
  })
}

// ---------------------------------------------------------------- proposals: reverse, void, edit
async function proposeReversePayment(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const id = input.payment_id
  if (!isUuid(id)) return fail('BAD_ARGUMENT', 'payment_id inválido.')
  const g = gateId(ctx, 'payment_id', id, 'propose_reverse_payment', input)
  if (!g.ok) return g
  const e0 = await readEntry(ctx, { payment_id: id })
  if (!e0.ok) return e0
  const e = e0.data
  if (!e.payment) return fail('NOT_FOUND', 'Pagamento não encontrado.')
  if (e.payment.reversed) return fail('BAD_TRANSITION', 'Esse pagamento já foi estornado.')
  return pushProposal(ctx, {
    kind: 'reverse_payment',
    params: { payment_id: e.payment.payment_id, entry_id: e.entry_id, amount_cents: e.payment.amount_cents, method: e.payment.method, paid_at: e.payment.paid_at },
    summary: {
      title: 'Estornar pagamento',
      lines: [
        line('Lançamento', safe(labelOf(e), 120)),
        line('Pagamento', `${payLine(e.payment)} · ${saoPauloDay(e.payment.paid_at)}`),
        line('Saldo depois', fmtMoney(e.open_cents + e.payment.amount_cents)),
      ],
      warnings: [],
    },
  })
}

async function proposeVoidEntry(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const id = input.entry_id
  if (!isUuid(id)) return fail('BAD_ARGUMENT', 'entry_id inválido.')
  const g = gateId(ctx, 'entry_id', id, 'propose_void_entry', input)
  if (!g.ok) return g
  const e0 = await readEntry(ctx, { entry_id: id })
  if (!e0.ok) return e0
  const e = e0.data
  if (e.voided) return fail('BAD_TRANSITION', 'Lançamento já cancelado.')
  if (e.payments.length > 0) return fail('HAS_PAYMENTS', messageOfCode('HAS_PAYMENTS'))
  if (e.appointment_id || e.client_package_id) return fail('BAD_TRANSITION', 'Este lançamento pertence a um atendimento ou pacote ativo.')
  return pushProposal(ctx, {
    kind: 'void_entry',
    params: { entry_id: e.entry_id },
    summary: {
      title: 'Cancelar lançamento',
      lines: [line('Lançamento', safe(labelOf(e), 120)), line('Data', fmtDate(e.due_date)), line('Valor', fmtMoney(e.amount_cents))],
      warnings: ['Não dá para desfazer um cancelamento'],
    },
  })
}

async function proposeEditEntry(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const id = input.entry_id
  if (!isUuid(id)) return fail('BAD_ARGUMENT', 'entry_id inválido.')
  const g = gateId(ctx, 'entry_id', id, 'propose_edit_entry', input)
  if (!g.ok) return g
  let description: string | null = null
  if (input.description !== undefined && input.description !== null) {
    const d = cleanText(input.description, 1, 80, 'description')
    if (!d.ok) return fromChecked(d)
    description = d.value
  }
  const due = optDate(ctx, input.due_date_ref)
  if (!due.ok) return fromChecked(due)
  let amount: number | null = null
  if (input.amount_cents !== undefined && input.amount_cents !== null) {
    const a = validateAmount(input.amount_cents)
    if (!a.ok) return fromChecked(a)
    amount = a.value
  }
  const e0 = await readEntry(ctx, { entry_id: id })
  if (!e0.ok) return e0
  const e = e0.data
  if (e.voided) return fail('BAD_TRANSITION', 'Lançamento cancelado.')
  if (e.entry_type === 'credit_deposit') return fail('BAD_TRANSITION', 'Crédito de cliente não pode ser editado.')
  const changes = [
    ...(description !== null && description !== e.description ? [line('Descrição', `${safe(e.description)} → ${description}`)] : []),
    ...(due.value !== null && due.value !== e.due_date ? [line('Data', `${fmtDate(e.due_date)} → ${fmtDate(due.value)}`)] : []),
    ...(amount !== null && amount !== e.amount_cents ? [line('Valor', `${fmtMoney(e.amount_cents)} → ${fmtMoney(amount)}`)] : []),
  ]
  if (changes.length === 0) return fail('NOTHING_TO_CHANGE', 'Nada muda: os valores informados são iguais aos atuais.')
  if (amount !== null && amount !== e.amount_cents && e.payments.length > 0 && (e.appointment_id || e.client_package_id)) return fail('HAS_PAYMENTS', messageOfCode('HAS_PAYMENTS'))
  if (amount !== null && !e.appointment_id && !e.client_package_id && amount - e.discount_cents < e.paid_cents) return fail('BAD_AMOUNT', messageOfCode('BAD_AMOUNT'))
  return pushProposal(ctx, {
    kind: 'edit_entry',
    params: {
      entry_id: e.entry_id, description, due_date: due.value, amount_cents: amount,
      before: { description: e.description, due_date: e.due_date, amount_cents: e.amount_cents },
    },
    summary: { title: 'Editar lançamento', lines: [line('Lançamento', safe(labelOf(e), 120)), ...changes], warnings: amount !== null && isHighValue(amount) ? ['Valor alto, confira'] : [] },
  })
}

// ---------------------------------------------------------------- proposals: client account (Task 9)
async function proposeAddCredit(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const amount = validateAmount(input.amount_cents)
  if (!amount.ok) return fromChecked(amount)
  const m = validateMethod(input.method, ['pix', 'cash', 'debit', 'credit'])
  if (!m.ok) return fromChecked(m)
  const c = await resolveClient(ctx, 'propose_add_credit', input, input.client_query)
  if (!c.ok) return c
  const bal = await creditBalance(ctx, c.client.id)
  if (!bal.ok) return bal
  return pushProposal(ctx, {
    kind: 'add_credit',
    params: { client_id: c.client.id, amount_cents: amount.value, method: m.value },
    summary: {
      title: 'Adicionar crédito',
      lines: [
        line('Cliente', c.client.name),
        line('Valor', fmtMoney(amount.value)),
        line('Forma', METHOD_LABEL[m.value]!),
        line('Saldo de crédito depois', fmtMoney(bal.data.credit + amount.value)),
      ],
      warnings: isHighValue(amount.value) ? ['Valor alto, confira'] : [],
    },
  })
}

async function proposeSettleAccount(ctx: ToolCtx, input: Record<string, unknown>): Promise<ToolOut> {
  const c = await resolveClient(ctx, 'propose_settle_account', input, input.client_query)
  if (!c.ok) return c
  const pays = parsePayments(input.payments, [...INCOME_METHODS, 'credit_balance'])
  if (!pays.ok) return fromChecked(pays)
  const bal = await creditBalance(ctx, c.client.id)
  if (!bal.ok) return bal
  const sum = pays.value.reduce((s, p) => s + p.amount_cents, 0)
  if (sum > bal.data.debt) return fail('OVERPAYMENT', messageOfCode('OVERPAYMENT'))
  const credit = pays.value.filter((p) => p.method === 'credit_balance').reduce((s, p) => s + p.amount_cents, 0)
  if (credit > bal.data.credit) return fail('CREDIT_INSUFFICIENT', messageOfCode('CREDIT_INSUFFICIENT'))
  return pushProposal(ctx, {
    kind: 'settle_account',
    params: { client_id: c.client.id, payments: pays.value },
    summary: {
      title: 'Quitar conta da cliente',
      lines: [
        line('Cliente', c.client.name),
        line('Dívida em aberto', fmtMoney(bal.data.debt)),
        ...pays.value.map((p) => line('Pagamento', payLine(p))),
        line('Dívida depois', fmtMoney(bal.data.debt - sum)),
      ],
      warnings: pays.value.some((p) => isHighValue(p.amount_cents)) ? ['Valor alto, confira'] : [],
    },
  })
}

// ---------------------------------------------------------------- ask_user
function askUser(ctx: ToolCtx, input: Record<string, unknown>): ToolOut {
  const q = cleanText(input.question, 3, 200, 'question')
  if (!q.ok) return fromChecked(q)
  if (violatesTextGuard(q.value)) return fail('DIGITS_IN_QUESTION', 'A pergunta não pode ter dígitos nem R$. Reescreva só com palavras.')
  const raw = Array.isArray(input.options) ? input.options : []
  if (raw.length > 6) return fail('BAD_ARGUMENT', 'No máximo 6 opções.')
  const options: Array<{ label: string; value: string }> = []
  for (const o of raw) {
    const label = cleanText((o as { label?: unknown })?.label, 1, 40, 'label')
    const value = cleanText((o as { value?: unknown })?.value, 1, 40, 'value')
    if (!label.ok) return fromChecked(label)
    if (!value.ok) return fromChecked(value)
    if (violatesTextGuard(label.value)) return fail('DIGITS_IN_QUESTION', 'As opções não podem ter dígitos nem R$.')
    options.push({ label: label.value, value: value.value })
  }
  ctx.run.question = { kind: 'question', question: q.value, options }
  return { ok: true, note: 'Pergunta enviada ao usuário. Encerre sem texto.' }
}

// ---------------------------------------------------------------- registry
const HANDLERS: Record<string, (ctx: ToolCtx, input: Record<string, unknown>) => Promise<ToolOut> | ToolOut> = {
  find_entries: findEntries,
  get_entry: getEntryTool,
  finance_summary: financeSummary,
  client_account: clientAccount,
  propose_expense: (c, i) => proposeManual(c, 'expense', i),
  propose_income: (c, i) => proposeManual(c, 'income', i),
  propose_payment: proposePayment,
  propose_use_package: proposeUsePackage,
  propose_reverse_payment: proposeReversePayment,
  propose_void_entry: proposeVoidEntry,
  propose_edit_entry: proposeEditEntry,
  propose_add_credit: proposeAddCredit,
  propose_settle_account: proposeSettleAccount,
  ask_user: askUser,
}

export async function executeTool(ctx: ToolCtx, name: string, input: unknown): Promise<ToolOut> {
  const h = HANDLERS[name]
  let out: ToolOut
  if (!h) out = fail('UNKNOWN_TOOL', 'Ferramenta desconhecida.')
  else if (input === null || typeof input !== 'object' || Array.isArray(input)) out = fail('BAD_ARGUMENT', 'Argumentos inválidos.')
  else {
    try {
      out = await h(ctx, input as Record<string, unknown>)
    } catch {
      out = fail('INTERNAL', 'Não consegui concluir essa consulta agora.')
    }
  }
  ctx.run.toolLog.push({ name, ok: out.ok, ...(out.ok ? {} : { code: out.code }) })
  return out
}

// ---------------------------------------------------------------- tool definitions (sent to the model)
const DATE_REF = {
  type: 'object',
  description: 'Data relativa, resolvida pelo sistema em America/Sao_Paulo. kind: today, yesterday, tomorrow, date (value AAAA-MM-DD) ou day_of_month (value = dia, 1 a 31, do mês atual).',
  properties: { kind: { type: 'string', enum: ['today', 'yesterday', 'tomorrow', 'date', 'day_of_month'] }, value: { type: 'string' } },
  required: ['kind'],
}
const METHOD = { type: 'string', enum: ['pix', 'cash', 'debit', 'credit', 'barter', 'credit_balance'] }
const PAYMENTS = {
  type: 'array',
  maxItems: 4,
  items: { type: 'object', properties: { amount_cents: { type: 'integer', description: 'centavos, maior que zero' }, method: METHOD }, required: ['amount_cents', 'method'] },
}

export const TOOL_DEFS = [
  {
    name: 'find_entries',
    description: 'Lista lançamentos (no máximo 10). mode: receivable (a receber), payable (a pagar) ou statement (pagamentos recebidos). Os ids devolvidos podem ser usados nas propostas.',
    input_schema: {
      type: 'object',
      properties: {
        client_query: { type: 'string' }, description_query: { type: 'string' }, date_ref: DATE_REF, date_from: DATE_REF, date_to: DATE_REF,
        mode: { type: 'string', enum: ['receivable', 'payable', 'statement'] },
        status: { type: 'string', description: 'receivable/payable: expected, partial, overdue, paid, today. statement: forma de pagamento.' },
      },
      required: ['mode'],
    },
  },
  { name: 'get_entry', description: 'Detalhe de um lançamento já conhecido (inclui os ids dos pagamentos).', input_schema: { type: 'object', properties: { entry_id: { type: 'string' } }, required: ['entry_id'] } },
  {
    name: 'finance_summary',
    description: 'Resumo financeiro do período. Os valores aparecem num cartão montado pelo sistema.',
    input_schema: { type: 'object', properties: { period: { type: 'string', enum: ['today', 'week', 'month', 'date_range'] }, date_from: DATE_REF, date_to: DATE_REF }, required: ['period'] },
  },
  { name: 'client_account', description: 'Saldo de crédito e dívida em aberto de uma cliente.', input_schema: { type: 'object', properties: { client_query: { type: 'string' } }, required: ['client_query'] } },
  {
    name: 'propose_expense',
    description: `Propõe lançar uma despesa. amount_cents em centavos inteiros. paid=true exige method. category: ${CATEGORIES.join(', ')}.`,
    input_schema: {
      type: 'object',
      properties: { payee: { type: 'string' }, reason: { type: 'string' }, amount_cents: { type: 'integer' }, date_ref: DATE_REF, paid: { type: 'boolean' }, method: METHOD, category: { type: 'string' } },
      required: ['reason', 'amount_cents', 'paid'],
    },
  },
  {
    name: 'propose_income',
    description: 'Propõe lançar uma receita avulsa (sem atendimento). paid=true exige method.',
    input_schema: {
      type: 'object',
      properties: { description: { type: 'string' }, amount_cents: { type: 'integer' }, date_ref: DATE_REF, client_query: { type: 'string' }, paid: { type: 'boolean' }, method: METHOD },
      required: ['description', 'amount_cents', 'paid'],
    },
  },
  {
    name: 'propose_payment',
    description: 'Propõe dar baixa (receber ou pagar) em um lançamento conhecido. Atendimento ainda não concluído é concluído junto.',
    input_schema: { type: 'object', properties: { entry_id: { type: 'string' }, payments: PAYMENTS, discount_cents: { type: 'integer' } }, required: ['entry_id', 'payments'] },
  },
  {
    name: 'propose_use_package',
    description: 'Propõe usar uma sessão de pacote da cliente em um atendimento (lançamento conhecido). O pacote que vence primeiro é o padrão.',
    input_schema: { type: 'object', properties: { entry_id: { type: 'string' }, client_package_id: { type: 'string' } }, required: ['entry_id'] },
  },
  { name: 'propose_reverse_payment', description: 'Propõe estornar um pagamento conhecido.', input_schema: { type: 'object', properties: { payment_id: { type: 'string' } }, required: ['payment_id'] } },
  { name: 'propose_void_entry', description: 'Propõe cancelar um lançamento conhecido (sem pagamentos).', input_schema: { type: 'object', properties: { entry_id: { type: 'string' } }, required: ['entry_id'] } },
  {
    name: 'propose_edit_entry',
    description: 'Propõe editar descrição, data de vencimento ou valor de um lançamento conhecido.',
    input_schema: { type: 'object', properties: { entry_id: { type: 'string' }, description: { type: 'string' }, due_date_ref: DATE_REF, amount_cents: { type: 'integer' } }, required: ['entry_id'] },
  },
  {
    name: 'propose_add_credit',
    description: 'Propõe adicionar crédito (saldo) a uma cliente.',
    input_schema: { type: 'object', properties: { client_query: { type: 'string' }, amount_cents: { type: 'integer' }, method: { type: 'string', enum: ['pix', 'cash', 'debit', 'credit'] } }, required: ['client_query', 'amount_cents', 'method'] },
  },
  {
    name: 'propose_settle_account',
    description: 'Propõe quitar a dívida em aberto de uma cliente (do lançamento mais antigo ao mais novo).',
    input_schema: { type: 'object', properties: { client_query: { type: 'string' }, payments: PAYMENTS }, required: ['client_query', 'payments'] },
  },
  {
    name: 'ask_user',
    description: 'Pergunta ao usuário quando falta uma informação. A pergunta e as opções não podem ter dígitos nem R$. No máximo 6 opções.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', maxItems: 6, items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] } } },
      required: ['question'],
    },
  },
]
