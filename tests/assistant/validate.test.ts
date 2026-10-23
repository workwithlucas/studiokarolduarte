import { describe, expect, it } from 'vitest'
import type { ChoiceCard } from '../../supabase/functions/_shared/assistant-types.ts'
import {
  GUARD_FALLBACK, HIGH_VALUE_CENTS, MAX_AMOUNT_CENTS, derivedUuid, fmtDate, fmtMoney, importKey, isHighValue, normalizeCategory,
  resolveDateRef, validateAmount, validateMethod, validatePick, violatesTextGuard,
} from '../../supabase/functions/_shared/assistant-validate.ts'

const at = (iso: string) => Date.parse(iso) // fixtures only; production code never parses strings this way
const ok = (r: { ok: boolean; value?: unknown }) => (r.ok ? r.value : null)

describe('resolveDateRef', () => {
  const NOW = at('2026-10-23T15:00:00Z') // 12:00 in São Paulo
  it('today, yesterday, tomorrow', () => {
    expect(ok(resolveDateRef({ kind: 'today' }, NOW))).toBe('2026-10-23')
    expect(ok(resolveDateRef({ kind: 'yesterday' }, NOW))).toBe('2026-10-22')
    expect(ok(resolveDateRef({ kind: 'tomorrow' }, NOW))).toBe('2026-10-24')
  })
  it('date accepts only real calendar dates', () => {
    expect(ok(resolveDateRef({ kind: 'date', value: '2026-02-28' }, NOW))).toBe('2026-02-28')
    for (const v of ['2026-02-30', '2026-13-01', '23/10/2026', '', 20261023, null, undefined]) {
      expect(resolveDateRef({ kind: 'date', value: v }, NOW)).toMatchObject({ ok: false, code: 'DATE_INVALID' })
    }
  })
  it('day_of_month is the day of the current month', () => {
    expect(ok(resolveDateRef({ kind: 'day_of_month', value: 5 }, NOW))).toBe('2026-10-05')
    expect(ok(resolveDateRef({ kind: 'day_of_month', value: '31' }, NOW))).toBe('2026-10-31')
    for (const v of [0, 32, 1.5, 'x', null, -1]) expect(resolveDateRef({ kind: 'day_of_month', value: v }, NOW).ok).toBe(false)
  })
  it('month boundary', () => {
    const NOV1 = at('2026-11-01T15:00:00Z')
    expect(ok(resolveDateRef({ kind: 'yesterday' }, NOV1))).toBe('2026-10-31')
    expect(ok(resolveDateRef({ kind: 'tomorrow' }, at('2026-10-31T15:00:00Z')))).toBe('2026-11-01')
    expect(resolveDateRef({ kind: 'day_of_month', value: 31 }, NOV1)).toMatchObject({ ok: false, code: 'DATE_INVALID' }) // November has 30 days
    expect(ok(resolveDateRef({ kind: 'day_of_month', value: 30 }, NOV1))).toBe('2026-11-30')
    expect(ok(resolveDateRef({ kind: 'tomorrow' }, at('2026-12-31T15:00:00Z')))).toBe('2027-01-01')
    expect(ok(resolveDateRef({ kind: 'yesterday' }, at('2027-01-01T15:00:00Z')))).toBe('2026-12-31')
  })
  it('leap years', () => {
    expect(ok(resolveDateRef({ kind: 'day_of_month', value: 29 }, at('2028-02-10T15:00:00Z')))).toBe('2028-02-29')
    expect(resolveDateRef({ kind: 'day_of_month', value: 29 }, at('2027-02-10T15:00:00Z')).ok).toBe(false)
    expect(ok(resolveDateRef({ kind: 'tomorrow' }, at('2028-02-28T15:00:00Z')))).toBe('2028-02-29')
  })
  it('the day is decided in America/Sao_Paulo, not UTC', () => {
    expect(ok(resolveDateRef({ kind: 'today' }, at('2026-10-24T02:30:00Z')))).toBe('2026-10-23') // 23:30 in São Paulo
    expect(ok(resolveDateRef({ kind: 'today' }, at('2026-10-24T03:00:00Z')))).toBe('2026-10-24') // 00:00 in São Paulo
    expect(ok(resolveDateRef({ kind: 'yesterday' }, at('2026-11-01T02:59:00Z')))).toBe('2026-10-30')
  })
  it('structured errors for anything that is not a date_ref', () => {
    for (const bad of [null, undefined, 'today', 5, [], {}, { kind: 'next_week' }, { kind: 7 }]) {
      expect(resolveDateRef(bad, NOW)).toMatchObject({ ok: false, code: 'DATE_INVALID' })
    }
  })
})

describe('amount, method and category validation', () => {
  it('amount: integer cents, > 0, <= 5,000,000', () => {
    expect(ok(validateAmount(1))).toBe(1)
    expect(ok(validateAmount(MAX_AMOUNT_CENTS))).toBe(MAX_AMOUNT_CENTS)
    for (const v of [0, -1, MAX_AMOUNT_CENTS + 1, 10.5, NaN, Infinity, '2000', null, undefined]) {
      expect(validateAmount(v)).toMatchObject({ ok: false, code: 'BAD_AMOUNT' })
    }
  })
  it('high value starts above 1,000,000', () => {
    expect(isHighValue(HIGH_VALUE_CENTS)).toBe(false)
    expect(isHighValue(HIGH_VALUE_CENTS + 1)).toBe(true)
  })
  it('category: known (any case/accents) or Outros', () => {
    expect(normalizeCategory('contas')).toBe('Contas')
    expect(normalizeCategory('  MATERIAIS ')).toBe('Materiais')
    expect(normalizeCategory('Aluguel')).toBe('Aluguel')
    for (const v of ['Lanche', '', null, undefined, 5]) expect(normalizeCategory(v)).toBe('Outros')
  })
  it('methods are a closed list', () => {
    const pays = ['pix', 'cash', 'debit', 'credit', 'barter', 'credit_balance'] as const
    for (const m of pays) expect(ok(validateMethod(m, pays))).toBe(m)
    expect(validateMethod('boleto', pays).ok).toBe(false)
    expect(validateMethod('barter', ['pix']).ok).toBe(false)
    expect(validateMethod(undefined, pays).ok).toBe(false)
  })
})

describe('text guard', () => {
  it('rejects digits and R$', () => {
    for (const t of ['Total 20', 'R$', 'valor em R$ cem', 'a1', 'dia ٣', '１２']) expect(violatesTextGuard(t)).toBe(true)
  })
  it('accepts plain words', () => {
    for (const t of ['Preparei a despesa. Confira o cartão.', 'Quanto você pagou, em reais?', 'Reais e centavos', '']) expect(violatesTextGuard(t)).toBe(false)
  })
  it('the fallback itself passes the guard', () => {
    expect(violatesTextGuard(GUARD_FALLBACK)).toBe(false)
  })
})

describe('formatting', () => {
  it('money and dates are built in code', () => {
    expect(fmtMoney(2000)).toBe('R$ 20,00')
    expect(fmtMoney(5)).toBe('R$ 0,05')
    expect(fmtMoney(123456789)).toBe('R$ 1.234.567,89')
    expect(fmtMoney(-250)).toBe('-R$ 2,50')
    expect(fmtDate('2026-10-05')).toBe('05/10/2026')
    expect(fmtDate('nope')).toBe('—')
  })
})

describe('idempotency keys', () => {
  it('derived uuid is stable, valid and differs per index', async () => {
    const p = '11111111-2222-4333-8444-555555555555'
    const a = await derivedUuid(p, 0)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await derivedUuid(p, 0)).toBe(a)
    expect(await derivedUuid(p, 1)).not.toBe(a)
    expect(await derivedUuid(p, 0, 'undo')).not.toBe(a)
    expect(await derivedUuid('11111111-2222-4333-8444-555555555556', 0)).not.toBe(a)
  })
  it('import key', () => {
    expect(importKey('abc', 2)).toBe('assist-abc-2')
  })
})

describe('ChoiceChips pick validation', () => {
  const card: ChoiceCard = {
    kind: 'choice', choice_id: 'c1', slot: 'entry_id', question: 'Qual destes lançamentos?',
    options: [{ label: 'A', detail: 'x', value: 'e1' }, { label: 'B', detail: 'y', value: 'e2' }],
    intent: { tool: 'propose_payment', input: {}, carry: [] },
  }
  it('accepts only a stored candidate of the named card', () => {
    expect(validatePick(card, false, 'c1', 'e2')).toMatchObject({ ok: true, value: { value: 'e2' } })
  })
  it('rejects values outside the candidates', () => {
    for (const v of ['e3', '', null, undefined, 5]) expect(validatePick(card, false, 'c1', v).ok).toBe(false)
  })
  it('rejects another card id, a resolved card and a missing card', () => {
    expect(validatePick(card, false, 'other', 'e1').ok).toBe(false)
    expect(validatePick(card, true, 'c1', 'e1').ok).toBe(false)
    expect(validatePick(null, false, 'c1', 'e1').ok).toBe(false)
    expect(validatePick({ ...card, kind: 'question' } as never, false, 'c1', 'e1').ok).toBe(false)
  })
})
