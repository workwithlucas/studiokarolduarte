// Finance helpers: pure logic shared by the screens and the tests. Money is integer cents; dates are São Paulo 'YYYY-MM-DD'.
import Papa from 'papaparse'
import type { PillTone } from '../components/ui'
import { addDaysYMD, formatDate, isValidYMD, ymdOf } from './datetime'
import { centsToPlain } from './money'

// ---------------------------------------------------------------- payment methods
export type PayMethod = 'pix' | 'cash' | 'debit' | 'credit' | 'barter' | 'credit_balance' | 'adjustment'
export const PAY_METHODS: Array<{ value: PayMethod; label: string }> = [
  { value: 'pix', label: 'Pix' },
  { value: 'cash', label: 'Dinheiro' },
  { value: 'debit', label: 'Débito' },
  { value: 'credit', label: 'Crédito' },
  { value: 'barter', label: 'Permuta' },
]
/** Not cash: the client credit used to pay, and the opening balance ("Saldo anterior"). */
export const NONCASH_METHODS: Array<{ value: PayMethod; label: string }> = [
  { value: 'credit_balance', label: 'Crédito da cliente' },
  { value: 'adjustment', label: 'Saldo anterior' },
]
export const CREDIT_METHOD = NONCASH_METHODS[0]!
export const ALL_METHODS = [...PAY_METHODS, ...NONCASH_METHODS]
export function methodLabel(m: string | null | undefined): string {
  return ALL_METHODS.find((x) => x.value === m)?.label ?? '—'
}
/** Methods of a deposit in Adicionar crédito. */
export const DEPOSIT_METHODS = PAY_METHODS.filter((m) => ['pix', 'cash', 'debit', 'credit'].includes(m.value))
export function isNonCash(m: string | null | undefined): boolean {
  return m === 'credit_balance' || m === 'adjustment'
}

// ---------------------------------------------------------------- payment sheet math
export interface PayLine {
  method: PayMethod
  cents: number | null
}

export interface PaymentMath {
  /** Discount actually applied (clamped to 0..gross). */
  discount: number
  /** Gross minus discount. */
  final: number
  /** Still to receive: final minus what was already paid. */
  total: number
  /** Sum of the payment lines. */
  entered: number
  /** total − entered (negative = too much). */
  remaining: number
  discountOk: boolean
  linesOk: boolean
  /** Receivable now: at least one line, no overpayment, valid discount. */
  canReceive: boolean
}

export function paymentMath(grossCents: number, discountCents: number | null, lines: PayLine[], alreadyPaidCents = 0): PaymentMath {
  const raw = discountCents ?? 0
  const discount = Math.min(Math.max(raw, 0), grossCents)
  const final = grossCents - discount
  const total = final - alreadyPaidCents
  const entered = lines.reduce((n, l) => n + (l.cents ?? 0), 0)
  const remaining = total - entered
  const discountOk = raw >= 0 && raw <= grossCents && final >= alreadyPaidCents
  const linesOk = lines.every((l) => l.cents === null || l.cents > 0)
  return { discount, final, total, entered, remaining, discountOk, linesOk, canReceive: discountOk && linesOk && entered > 0 && remaining >= 0 }
}

// ---------------------------------------------------------------- client credit (payment sheet)
/** A credit line can take at most the balance and at most what is still to receive. */
export function creditLimit(balanceCents: number, remainingCents: number): number {
  return Math.max(0, Math.min(balanceCents, remainingCents))
}

/** Limit for line `index`: the balance not used by the other credit lines, and what the other lines leave to receive. */
export function creditLineLimit(lines: PayLine[], index: number, balanceCents: number, totalCents: number): number {
  let credit = 0
  let entered = 0
  lines.forEach((l, i) => {
    if (i === index) return
    entered += l.cents ?? 0
    if (l.method === 'credit_balance') credit += l.cents ?? 0
  })
  return creditLimit(balanceCents - credit, totalCents - entered)
}

/** True when the credit lines together ask for more than the balance. */
export function creditExceeded(lines: PayLine[], balanceCents: number): boolean {
  return lines.reduce((n, l) => n + (l.method === 'credit_balance' ? (l.cents ?? 0) : 0), 0) > balanceCents
}

// ---------------------------------------------------------------- settlement preview (oldest first)
export interface OpenEntry {
  entry_id: string
  due_date: string
  description: string
  open_cents: number
}
export interface AllocationRow extends OpenEntry {
  applied_cents: number
  left_cents: number
}
/** Mirrors rpc_settle_client_account: the total goes across the entries in the given (oldest first) order. */
export function allocationPreview(entries: OpenEntry[], totalCents: number, totalDebtCents?: number) {
  let left = Math.max(0, totalCents)
  const rows: AllocationRow[] = entries.map((e) => {
    const applied = Math.min(e.open_cents, left)
    left -= applied
    return { ...e, applied_cents: applied, left_cents: e.open_cents - applied }
  })
  const debt = totalDebtCents ?? entries.reduce((n, e) => n + e.open_cents, 0)
  const applied = rows.reduce((n, r) => n + r.applied_cents, 0)
  return { rows, applied, remainingDebt: Math.max(0, debt - Math.max(0, totalCents)), overpay: totalCents > debt }
}

/** Payload for rpc_register_payments / rpc_complete_and_pay: empty lines are dropped. */
export function linesPayload(lines: PayLine[]): Array<{ amount_cents: number; method: PayMethod }> {
  return lines.filter((l) => l.cents !== null && l.cents > 0).map((l) => ({ amount_cents: l.cents!, method: l.method }))
}

// ---------------------------------------------------------------- status pill
export interface PillInput {
  status: string
  appointment_status?: string | null
  appointment_starts_at?: string | null
}
export interface PillInfo {
  label: string
  tone: PillTone
  /** Money can be received on this row now. */
  payable: boolean
}

function futureUncompleted(row: PillInput, now: number): boolean {
  if (!row.appointment_status || row.appointment_status === 'completed') return false
  const t = row.appointment_starts_at ? Date.parse(row.appointment_starts_at) : NaN
  return Number.isFinite(t) && t > now
}

/**
 * v_ledger status → pill. A future appointment that is not completed yet is PREVISTO and cannot be paid.
 * Expense rows say A PAGAR instead of A RECEBER.
 */
export function statusPill(row: PillInput, kind: 'income' | 'expense' = 'income', now: number = Date.now()): PillInfo {
  const open = kind === 'income' ? 'A RECEBER' : 'A PAGAR'
  switch (row.status) {
    case 'voided':
      return { label: 'CANCELADO', tone: 'neutral', payable: false }
    case 'paid':
      return { label: 'PAGO', tone: 'success', payable: false }
    case 'partial':
      return { label: 'PARCIAL', tone: 'warn', payable: true }
    case 'overdue':
      return { label: 'VENCIDO', tone: 'danger', payable: !futureUncompleted(row, now) }
    default:
      return futureUncompleted(row, now)
        ? { label: 'PREVISTO', tone: 'neutral', payable: false }
        : { label: open, tone: 'gold', payable: true }
  }
}

// ---------------------------------------------------------------- periods (São Paulo dates; no Date parsing of user input)
export function isValidYM(ym: unknown): ym is string {
  return typeof ym === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(ym)
}

/** First and last day of a 'YYYY-MM' month. */
export function monthBounds(ym: string): { from: string; to: string } {
  if (!isValidYM(ym)) throw new Error(`invalid month: ${String(ym)}`)
  const [y, m] = ym.split('-').map(Number) as [number, number]
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  return { from: `${ym}-01`, to: addDaysYMD(next, -1) }
}

export function shiftMonth(ym: string, n: number): string {
  if (!isValidYM(ym)) return ym
  const [y, m] = ym.split('-').map(Number) as [number, number]
  const idx = y * 12 + (m - 1) + n
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
export function monthLabel(ym: string): string {
  if (!isValidYM(ym)) return '—'
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${MONTHS[m - 1]} de ${y}`
}

export interface Period {
  from: string
  to: string
}

/** Custom De/Até overrides the month; an invalid or inverted custom range falls back to the month. */
export function resolvePeriod(ym: string, custom: Period | null): Period {
  if (custom && isValidYMD(custom.from) && isValidYMD(custom.to) && custom.from <= custom.to) return { from: custom.from, to: custom.to }
  return monthBounds(ym)
}

/** The São Paulo calendar day a payment timestamp belongs to (23:30 SP on the 31st is still the 31st). */
export function paymentDay(paidAt: string): string {
  return ymdOf(paidAt)
}

// ---------------------------------------------------------------- statement export
export interface StatementRow {
  paid_at: string | null
  client_name: string | null
  description: string
  service_name: string | null
  method: string | null
  professional_name: string | null
  payment_cents: number | null
  reversed_at: string | null
}

export function statementToCsv(rows: StatementRow[]): string {
  return Papa.unparse({
    fields: ['data', 'cliente', 'descricao', 'servico', 'forma', 'profissional', 'valor', 'estornado'],
    data: rows.map((r) => [
      formatDate(r.paid_at),
      r.client_name ?? '',
      r.description,
      r.service_name ?? '',
      methodLabel(r.method),
      r.professional_name ?? '',
      centsToPlain(r.payment_cents ?? 0),
      r.reversed_at ? 'sim' : '',
    ]),
  })
}

/** Totals per method over the non-reversed rows, in method order, plus the grand total. */
export function totalsByMethod(rows: Array<Pick<StatementRow, 'method' | 'payment_cents' | 'reversed_at'>>) {
  const map = new Map<string, number>()
  for (const r of rows) {
    if (r.reversed_at || !r.method) continue
    map.set(r.method, (map.get(r.method) ?? 0) + (r.payment_cents ?? 0))
  }
  const list = PAY_METHODS.filter((m) => map.has(m.value)).map((m) => ({ method: m.value, label: m.label, cents: map.get(m.value)! }))
  // Non-cash lines never enter the total.
  const noncash = NONCASH_METHODS.filter((m) => map.has(m.value)).map((m) => ({ method: m.value, label: m.label, cents: map.get(m.value)! }))
  return { list, total: list.reduce((n, x) => n + x.cents, 0), noncash }
}

// ---------------------------------------------------------------- RPC result shapes (jsonb)
export interface FinanceSummary {
  cards: { received_cents: number; receivable_cents: number; overdue_cents: number; expenses_paid_cents: number; result_cents: number }
  by_professional: Array<{ professional_id: string; name: string; count: number; production_cents: number; commission_cents: number; studio_cents: number; gross_cents: number; studio_share_cents: number }>
  by_method: Array<{ method: string; cents: number; count: number }>
  barter_cents: number
  /** credit_balance and adjustment: never part of received_cents. */
  noncash_by_method: Array<{ method: string; cents: number; count: number }>
  accounts: {
    credit_total_cents: number
    open_debt_total_cents: number
    top: Array<{ client_id: string; client: string; balance_cents: number; debt_cents: number }>
  }
  packages: { sold_count: number; sold_cents: number; sessions_used: number }
  expenses_by_category: Array<{ category: string; cents: number }>
  warnings: { missing_commission_rules: number }
}

export interface PaymentResult {
  entry_id: string
  amount_cents: number
  discount_cents: number
  final_cents: number
  paid_cents: number
  open_cents: number
  status: string
  payment_ids: string[]
}

export interface SettleAllocation {
  entry_id: string
  amount_cents: number
  method: PayMethod
}

export interface ClientAccount {
  credit_balance_cents: number
  open_debt_cents: number
  open_entries_count: number
  open_entries: OpenEntry[]
  movements: Array<{ date: string; type: 'deposit' | 'use' | 'settlement' | 'opening'; method: PayMethod; amount_cents: number; note: string | null }>
}

export interface FinanceEntry {
  entry_id: string
  kind: 'income' | 'expense'
  amount_cents: number
  discount_cents: number
  final_cents: number
  paid_cents: number
  open_cents: number
  status: string
  due_date: string
  description: string
}

// ---------------------------------------------------------------- commission percent
/** '58' | '58,5' | '58.25' → number in 0..100 with at most 2 decimals; null when blank or invalid. */
export function parsePercent(input: string | null | undefined): number | null {
  const s = (input ?? '').replace('%', '').trim().replace(',', '.')
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null
  const n = Number(s)
  return n >= 0 && n <= 100 ? n : null
}

export function formatPercent(n: number | string): string {
  return String(Number(n)).replace('.', ',')
}
