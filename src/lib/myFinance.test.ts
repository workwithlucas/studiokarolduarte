import { describe, expect, it } from 'vitest'
import { monthBounds, monthLabel, shiftMonth } from './finance'
import { todaySP } from './datetime'
import { formatBRL } from './money'

const nb = (s: string) => s.replace(/\s/g, ' ')

describe('professional finance tab', () => {
  it('defaults to the current São Paulo month', () => {
    // 01:30 UTC on the 1st is still the last day of the previous month in São Paulo
    expect(todaySP(new Date('2026-10-01T01:30:00Z')).slice(0, 7)).toBe('2026-09')
    expect(todaySP(new Date('2026-10-01T12:00:00Z')).slice(0, 7)).toBe('2026-10')
  })
  it('month arrows cross year boundaries and keep the range under 366 days', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(monthLabel(shiftMonth('2026-02', -2))).toBe('dezembro de 2025')
    expect(monthBounds('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(monthBounds('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })
  it('formats integer cents as BRL and refuses non-integers', () => {
    expect(nb(formatBRL(0))).toBe('R$ 0,00')
    expect(nb(formatBRL(26000))).toBe('R$ 260,00')
    expect(nb(formatBRL(123456789))).toBe('R$ 1.234.567,89')
    expect(formatBRL(10.5)).toBe('—')
    expect(formatBRL(undefined)).toBe('—')
  })
})
