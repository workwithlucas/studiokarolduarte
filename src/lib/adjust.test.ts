import { describe, expect, it } from 'vitest'
import { endedEarly, maskBRDate, maskTime24, newStartFromInputs, normalizeGap, parseBRDate, parseTime24 } from './adjust'

describe('typed date and time', () => {
  it('accepts valid DD/MM/AAAA and HH:MM', () => {
    expect(parseBRDate('06/10/2026')).toBe('2026-10-06')
    expect(parseBRDate('29/02/2028')).toBe('2028-02-29')
    expect(parseTime24('00:00')).toBe('00:00')
    expect(parseTime24('23:59')).toBe('23:59')
    expect(newStartFromInputs('06/10/2026', '15:07')).toBe('2026-10-06T15:07:00-03:00')
  })

  it.each(['', '6/10/2026', '31/02/2026', '29/02/2027', '00/10/2026', '10/13/2026', '10/10/26', '2026-10-06', '10-10-2026', '10/10/1999', 'ab/cd/efgh'])(
    'date parser rejects %j',
    (v) => expect(parseBRDate(v)).toBeNull(),
  )

  it.each(['', '9:05', '24:00', '12:60', '1230', '12:5', 'ab:cd', '12:30:00'])('time parser rejects %j', (v) =>
    expect(parseTime24(v)).toBeNull(),
  )

  it('rejects non-strings without throwing', () => {
    for (const v of [null, undefined, 12, {}, [], NaN]) {
      expect(parseBRDate(v)).toBeNull()
      expect(parseTime24(v)).toBeNull()
    }
    expect(newStartFromInputs('31/02/2026', '10:00')).toBeNull()
    expect(newStartFromInputs('06/10/2026', '25:00')).toBeNull()
  })

  it('masks typing', () => {
    expect(maskBRDate('1010')).toBe('10/10')
    expect(maskBRDate('10102026xx')).toBe('10/10/2026')
    expect(maskTime24('1530')).toBe('15:30')
    expect(maskTime24('15')).toBe('15')
  })
})

const row = (over: Record<string, unknown> = {}) => ({
  gap_start: '2026-10-12T18:00:00+00:00', // 15:00 SP
  gap_end: '2026-10-12T19:30:00+00:00', // 16:30 SP
  candidates: [
    { appointment_id: 'b', starts_at: '2026-10-12T20:30:00+00:00', duration_min: 60, client_name: 'Bia', service_name: 'Gel' },
    { appointment_id: 'a', starts_at: '2026-10-12T19:30:00+00:00', duration_min: 30, client_name: 'Ana', service_name: 'Esmalte' },
    { appointment_id: 'c', starts_at: '2026-10-12T21:00:00+00:00', duration_min: 91, client_name: 'Cris', service_name: 'Alongamento' },
  ],
  ...over,
})

describe('gap and candidates', () => {
  it('computes the gap length, keeps only candidates that fit, and orders them by start', () => {
    const g = normalizeGap(row())!
    expect(g.minutes).toBe(90)
    expect(g.candidates.map((c) => c.appointmentId)).toEqual(['a', 'b']) // 91 min does not fit 90
  })

  it('a candidate exactly the size of the gap fits', () => {
    const g = normalizeGap(row({ candidates: [{ appointment_id: 'x', starts_at: '2026-10-12T20:00:00Z', duration_min: 90 }] }))!
    expect(g.candidates).toHaveLength(1)
  })

  it('invalid or empty gaps and bad candidates are dropped', () => {
    expect(normalizeGap(null)).toBeNull()
    expect(normalizeGap(row({ gap_start: 'nope' }))).toBeNull()
    expect(normalizeGap(row({ gap_end: '2026-10-12T18:00:00+00:00' }))).toBeNull() // zero length
    expect(normalizeGap(row({ gap_end: '2026-10-12T17:00:00+00:00' }))).toBeNull() // negative
    const bad = [{ appointment_id: 'x', starts_at: 'bad', duration_min: 30 }, { starts_at: '2026-10-12T20:00:00Z', duration_min: 30 }, 5, null]
    expect(normalizeGap(row({ candidates: bad }))!.candidates).toEqual([])
    expect(normalizeGap(row({ candidates: null }))!.candidates).toEqual([])
  })

  it('detects an early close', () => {
    expect(endedEarly('2026-10-12T18:00:00Z', '2026-10-12T18:30:00Z')).toBe(true)
    expect(endedEarly('2026-10-12T18:30:00Z', '2026-10-12T18:30:00Z')).toBe(false)
    expect(endedEarly('garbage', '2026-10-12T18:30:00Z')).toBe(false)
    expect(endedEarly(null, null)).toBe(false)
  })
})
