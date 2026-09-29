import { describe, expect, it } from 'vitest'
import {
  addDaysYMD,
  formatDayLong,
  formatDayShort,
  hhmmToMinutes,
  isoAtMinutes,
  isValidYMD,
  minutesOfDaySP,
  minutesSinceDayStart,
  minutesToHHMM,
  parseDateTime,
  toSaoPauloISO,
  weekdayOf,
  weekStartYMD,
  ymdOf,
} from './datetime'

describe('datetime helpers never throw on bad input', () => {
  const bad = [null, undefined, 42, {}, '', 'abc', '2026-13-40', '2026-02-30', '2026-09-29T25:00', new Date('x')]
  it('return fallbacks', () => {
    for (const b of bad) {
      expect(parseDateTime(b)).toBeNull()
      expect(ymdOf(b, 'fb')).toBe('fb')
      expect(addDaysYMD(b, 1, 'fb')).toBe('fb')
      expect(weekStartYMD(b, 'fb')).toBe('fb')
      expect(weekdayOf(b)).toBeNull()
      expect(minutesOfDaySP(b, -1)).toBe(-1)
      expect(minutesSinceDayStart(b, b, -7)).toBe(-7)
      expect(isoAtMinutes(b, 60)).toBeNull()
      expect(formatDayShort(b, 'fb')).toBe('fb')
      expect(formatDayLong(b, 'fb')).toBe('fb')
      expect(isValidYMD(b)).toBe(false)
    }
    expect(toSaoPauloISO('2026-09-29', '25:00')).toBeNull()
    expect(hhmmToMinutes('nope', 5)).toBe(5)
    expect(minutesToHHMM(NaN)).toBe('--:--')
  })
})

describe('São Paulo date math', () => {
  it('adds days and finds the week start (Monday)', () => {
    expect(addDaysYMD('2026-09-29', 3)).toBe('2026-10-02')
    expect(addDaysYMD('2026-03-01', -1)).toBe('2026-02-28')
    expect(weekStartYMD('2026-09-29')).toBe('2026-09-28') // Tuesday -> Monday
    expect(weekStartYMD('2026-09-27')).toBe('2026-09-21') // Sunday -> previous Monday
  })

  it('weekday uses 0 = Sunday', () => {
    expect(weekdayOf('2026-09-27')).toBe(0)
    expect(weekdayOf('2026-09-28')).toBe(1)
  })

  it('reads timestamps in São Paulo time', () => {
    expect(ymdOf('2026-09-30T01:30:00Z')).toBe('2026-09-29') // 22:30 in São Paulo
    expect(minutesOfDaySP('2026-09-29T13:00:00Z')).toBe(10 * 60)
  })

  it('builds ISO from date + minutes and back', () => {
    const iso = isoAtMinutes('2026-09-29', 9 * 60 + 15)!
    expect(iso).toBe('2026-09-29T12:15:00.000Z')
    expect(minutesSinceDayStart('2026-09-29', iso)).toBe(555)
    expect(minutesToHHMM(555)).toBe('09:15')
    expect(hhmmToMinutes('09:15:00')).toBe(555)
  })

  it('formats labels in pt-BR', () => {
    expect(formatDayShort('2026-09-29').toLowerCase()).toBe('ter, 29 set')
    expect(formatDayLong('2026-09-29')).toBe('terça-feira, 29 de setembro')
  })
})
