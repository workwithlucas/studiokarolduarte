import { describe, expect, it } from 'vitest'
import {
  allocationPreview,
  creditExceeded,
  creditLimit,
  creditLineLimit,
  linesPayload,
  methodLabel,
  monthBounds,
  monthLabel,
  formatPercent,
  parsePercent,
  paymentDay,
  paymentMath,
  resolvePeriod,
  shiftMonth,
  statementToCsv,
  statusPill,
  totalsByMethod,
} from './finance'
import { centsToPlain, formatBRL, parseBRL } from './money'

const nbsp = /\s/g
const fmt = (c: number) => formatBRL(c).replace(nbsp, ' ')

describe('BRL parse and format', () => {
  it.each([
    ['R$ 1.234,56', 123456],
    ['1.234,56', 123456],
    ['12,5', 1250],
    ['12,50', 1250],
    ['12.50', 1250],
    ['1.234', 123400],
    ['1.234.567', 123456700],
    ['0,99', 99],
    ['150', 15000],
    ['  R$ 8 ', 800],
    ['0', 0],
  ])('parses %j -> %j', (input, cents) => expect(parseBRL(input)).toBe(cents))

  it.each(['', '   ', 'abc', '-5', '1,2,3', 'R$', '12,5x'])('rejects %j', (input) => expect(parseBRL(input)).toBeNull())
  it('null and undefined are null', () => {
    expect(parseBRL(null)).toBeNull()
    expect(parseBRL(undefined)).toBeNull()
  })

  it('formats cents as BRL and round-trips', () => {
    expect(fmt(123456)).toBe('R$ 1.234,56')
    expect(fmt(5)).toBe('R$ 0,05')
    expect(fmt(0)).toBe('R$ 0,00')
    for (const c of [0, 5, 99, 1250, 123456]) expect(parseBRL(formatBRL(c))).toBe(c)
  })

  it('formats plain numbers for CSV', () => {
    expect(centsToPlain(123450)).toBe('1234,50')
    expect(centsToPlain(5)).toBe('0,05')
    expect(centsToPlain(-250)).toBe('-2,50')
  })
})

describe('payment sheet math', () => {
  it('total = gross - discount, live', () => {
    const m = paymentMath(20000, 4000, [{ method: 'pix', cents: 16000 }])
    expect(m).toMatchObject({ discount: 4000, final: 16000, total: 16000, entered: 16000, remaining: 0, canReceive: true })
  })

  it('no discount and no lines: nothing to receive yet', () => {
    const m = paymentMath(20000, null, [{ method: 'pix', cents: null }])
    expect(m).toMatchObject({ discount: 0, total: 20000, entered: 0, remaining: 20000, canReceive: false })
  })

  it('split shows the remaining amount live', () => {
    const lines = [
      { method: 'pix' as const, cents: 12000 },
      { method: 'cash' as const, cents: null },
    ]
    expect(paymentMath(20000, 0, lines).remaining).toBe(8000)
    lines[1]!.cents = 8000
    expect(paymentMath(20000, 0, lines)).toMatchObject({ remaining: 0, canReceive: true })
  })

  it('partial is allowed and the remainder stays open', () => {
    const m = paymentMath(20000, 0, [{ method: 'pix', cents: 5000 }])
    expect(m).toMatchObject({ remaining: 15000, canReceive: true })
  })

  it('overpayment blocks the button', () => {
    const m = paymentMath(20000, 0, [{ method: 'pix', cents: 20001 }])
    expect(m.remaining).toBe(-1)
    expect(m.canReceive).toBe(false)
  })

  it('discount above gross is invalid; below what was already paid is invalid', () => {
    expect(paymentMath(20000, 20001, []).discountOk).toBe(false)
    expect(paymentMath(20000, 20001, []).discount).toBe(20000)
    const m = paymentMath(20000, 10000, [{ method: 'pix', cents: 1 }], 15000)
    expect(m.discountOk).toBe(false)
    expect(m.canReceive).toBe(false)
  })

  it('pay mode counts what was already paid', () => {
    const m = paymentMath(20000, 0, [{ method: 'pix', cents: 5000 }], 15000)
    expect(m).toMatchObject({ total: 5000, remaining: 0, canReceive: true })
  })

  it('payload drops empty lines', () => {
    expect(
      linesPayload([
        { method: 'pix', cents: 100 },
        { method: 'cash', cents: null },
        { method: 'debit', cents: 0 },
      ]),
    ).toEqual([{ amount_cents: 100, method: 'pix' }])
  })
})

describe('period boundaries', () => {
  it('month bounds', () => {
    expect(monthBounds('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(monthBounds('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(monthBounds('2027-02').to).toBe('2027-02-28')
  })
  it('rejects a bad month', () => {
    expect(() => monthBounds('2026-13')).toThrow()
    expect(() => monthBounds('26-01')).toThrow()
  })
  it('shifts across years', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-09', 0)).toBe('2026-09')
    expect(shiftMonth('2026-09', 15)).toBe('2027-12')
  })
  it('labels in pt-BR', () => expect(monthLabel('2026-03')).toBe('março de 2026'))
  it('custom De/Até overrides the month; invalid falls back', () => {
    expect(resolvePeriod('2026-09', { from: '2026-08-15', to: '2026-09-10' })).toEqual({ from: '2026-08-15', to: '2026-09-10' })
    expect(resolvePeriod('2026-09', { from: '2026-09-10', to: '2026-09-01' })).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(resolvePeriod('2026-09', { from: '2026-02-30', to: '2026-09-01' })).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(resolvePeriod('2026-09', null)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })
  it('a payment at 23:30 São Paulo on the 30th belongs to the 30th (02:30Z on the 1st)', () => {
    expect(paymentDay('2026-10-01T02:30:00Z')).toBe('2026-09-30')
    expect(paymentDay('2026-10-01T03:00:00Z')).toBe('2026-10-01')
    expect(paymentDay('2026-09-30T23:30:00-03:00')).toBe('2026-09-30')
  })
})

describe('status pill mapping', () => {
  const now = Date.parse('2026-09-30T12:00:00-03:00')
  it.each([
    [{ status: 'paid' }, 'PAGO', 'success', false],
    [{ status: 'partial' }, 'PARCIAL', 'warn', true],
    [{ status: 'overdue' }, 'VENCIDO', 'danger', true],
    [{ status: 'expected' }, 'A RECEBER', 'gold', true],
    [{ status: 'voided' }, 'CANCELADO', 'neutral', false],
  ])('%j', (row, label, tone, payable) => expect(statusPill(row, 'income', now)).toEqual({ label, tone, payable }))

  it('a future appointment that is not completed is PREVISTO and cannot be paid', () => {
    const row = { status: 'expected', appointment_status: 'scheduled', appointment_starts_at: '2026-10-05T10:00:00-03:00' }
    expect(statusPill(row, 'income', now)).toEqual({ label: 'PREVISTO', tone: 'neutral', payable: false })
  })
  it('a past appointment not yet completed is payable (it completes on payment)', () => {
    const row = { status: 'overdue', appointment_status: 'confirmed', appointment_starts_at: '2026-09-20T10:00:00-03:00' }
    expect(statusPill(row, 'income', now)).toMatchObject({ label: 'VENCIDO', payable: true })
  })
  it('a completed appointment is A RECEBER', () => {
    const row = { status: 'expected', appointment_status: 'completed', appointment_starts_at: '2026-10-05T10:00:00-03:00' }
    expect(statusPill(row, 'income', now).label).toBe('A RECEBER')
  })
  it('expenses say A PAGAR', () => expect(statusPill({ status: 'expected' }, 'expense', now).label).toBe('A PAGAR'))
})

describe('statement helpers', () => {
  const rows = [
    { paid_at: '2026-09-10T15:00:00Z', client_name: 'Ana', description: 'Cílios', service_name: 'Volume', method: 'pix', professional_name: 'Milena', payment_cents: 16000, reversed_at: null },
    { paid_at: '2026-09-11T15:00:00Z', client_name: null, description: 'Venda avulsa', service_name: null, method: 'cash', professional_name: null, payment_cents: 5050, reversed_at: null },
    { paid_at: '2026-09-11T16:00:00Z', client_name: 'Bia', description: 'x', service_name: null, method: 'pix', professional_name: null, payment_cents: 999, reversed_at: '2026-09-12T10:00:00Z' },
  ]
  it('totals per method skip reversed payments', () => {
    const t = totalsByMethod(rows)
    expect(t.list).toEqual([
      { method: 'pix', label: 'Pix', cents: 16000 },
      { method: 'cash', label: 'Dinheiro', cents: 5050 },
    ])
    expect(t.total).toBe(21050)
  })
  it('CSV has one line per row with plain money and the reversed flag', () => {
    const lines = statementToCsv(rows).split('\r\n')
    expect(lines[0]).toBe('data,cliente,descricao,servico,forma,profissional,valor,estornado')
    expect(lines[1]).toBe('10/09/2026,Ana,Cílios,Volume,Pix,Milena,"160,00",')
    expect(lines[3]).toBe('11/09/2026,Bia,x,,Pix,,"9,99",sim')
  })
  it('method labels', () => {
    expect(methodLabel('barter')).toBe('Permuta')
    expect(methodLabel(null)).toBe('—')
  })
})

describe('commission percent', () => {
  it.each([
    ['58', 58],
    ['58,5', 58.5],
    ['58.25', 58.25],
    [' 70% ', 70],
    ['0', 0],
    ['100', 100],
  ])('parses %j', (input, n) => expect(parsePercent(input)).toBe(n))
  it.each(['', 'abc', '101', '-1', '5,555', '1,2,3'])('rejects %j', (input) => expect(parsePercent(input)).toBeNull())
  it('formats with a decimal comma', () => {
    expect(formatPercent('58.00')).toBe('58')
    expect(formatPercent(62.5)).toBe('62,5')
  })
})

describe('client credit in the payment sheet', () => {
  it('limit = min(balance, remaining)', () => {
    expect(creditLimit(5000, 15000)).toBe(5000)
    expect(creditLimit(20000, 15000)).toBe(15000)
    expect(creditLimit(0, 15000)).toBe(0)
    expect(creditLimit(5000, 0)).toBe(0)
    expect(creditLimit(5000, -100)).toBe(0)
  })
  it('limit of a line discounts the other lines', () => {
    const lines = [
      { method: 'credit_balance' as const, cents: 3000 },
      { method: 'pix' as const, cents: 2000 },
      { method: 'credit_balance' as const, cents: null },
    ]
    // balance 5000, other credit 3000, total 15000, other lines 5000
    expect(creditLineLimit(lines, 2, 5000, 15000)).toBe(2000)
    expect(creditLineLimit(lines, 0, 5000, 15000)).toBe(5000)
  })
  it('credit lines above the balance block the receipt', () => {
    expect(creditExceeded([{ method: 'credit_balance', cents: 5001 }], 5000)).toBe(true)
    expect(creditExceeded([{ method: 'credit_balance', cents: 5000 }, { method: 'pix', cents: 99999 }], 5000)).toBe(false)
  })
  it('a service paid with credit + pix closes the entry', () => {
    const m = paymentMath(15000, null, [{ method: 'credit_balance', cents: 5000 }, { method: 'pix', cents: 10000 }])
    expect(m.remaining).toBe(0)
    expect(m.canReceive).toBe(true)
    expect(linesPayload([{ method: 'credit_balance', cents: 5000 }])).toEqual([{ amount_cents: 5000, method: 'credit_balance' }])
  })
  it('labels the new methods', () => {
    expect(methodLabel('credit_balance')).toBe('Crédito da cliente')
    expect(methodLabel('adjustment')).toBe('Saldo anterior')
  })
  it('extrato keeps non-cash out of the total', () => {
    const t = totalsByMethod([
      { method: 'cash', payment_cents: 20000, reversed_at: null },
      { method: 'credit_balance', payment_cents: 15000, reversed_at: null },
      { method: 'adjustment', payment_cents: 7000, reversed_at: null },
    ])
    expect(t.total).toBe(20000)
    expect(t.noncash.map((x) => [x.method, x.cents])).toEqual([['credit_balance', 15000], ['adjustment', 7000]])
  })
})

describe('settlement allocation preview', () => {
  const entries = [
    { entry_id: 'a', due_date: '2026-09-01', description: 'A', open_cents: 5000 },
    { entry_id: 'b', due_date: '2026-09-05', description: 'B', open_cents: 8000 },
    { entry_id: 'c', due_date: '2026-09-10', description: 'C', open_cents: 10000 },
  ]
  it('goes oldest first, partial on the last, with the remaining debt', () => {
    const p = allocationPreview(entries, 15000)
    expect(p.rows.map((r) => r.applied_cents)).toEqual([5000, 8000, 2000])
    expect(p.rows.map((r) => r.left_cents)).toEqual([0, 0, 8000])
    expect(p.remainingDebt).toBe(8000)
    expect(p.overpay).toBe(false)
  })
  it('nothing entered applies nothing', () => {
    const p = allocationPreview(entries, 0)
    expect(p.applied).toBe(0)
    expect(p.remainingDebt).toBe(23000)
  })
  it('flags a total above the debt', () => {
    const p = allocationPreview(entries, 23001)
    expect(p.overpay).toBe(true)
    expect(p.applied).toBe(23000)
  })
  it('uses the real total debt when the list is cut at 50', () => {
    expect(allocationPreview(entries, 1000, 99000).remainingDebt).toBe(98000)
  })
})
