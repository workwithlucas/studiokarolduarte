import { describe, expect, it } from 'vitest'
import { endsAtFrom, endTimeLabel, normalizeSearchQuery, normalizeSearchRows, parseDurationInput } from './editAppointment'

describe('end-time computation', () => {
  const start = '2026-10-12T13:00:00+00:00' // 10:00 São Paulo
  it('adds minutes to the start', () => {
    expect(endsAtFrom(start, 45)).toBe('2026-10-12T13:45:00.000Z')
    expect(endTimeLabel(start, 45)).toBe('10:45')
    expect(endTimeLabel(start, 90)).toBe('11:30')
    expect(endTimeLabel(start, 5)).toBe('10:05')
    expect(endTimeLabel(start, 600)).toBe('20:00')
  })
  it('crosses midnight in São Paulo time', () => {
    expect(endTimeLabel('2026-10-12T01:30:00Z', 90)).toBe('00:00') // 22:30 SP the day before + 90 min
  })
  it.each([null, undefined, '', 'x', 4, 601, 45.5, NaN, '45'])('rejects duration %j', (m) => {
    expect(endsAtFrom(start, m)).toBeNull()
  })
  it.each([null, undefined, '', 'nope', '2026-13-45T10:00:00Z', {}, 12])('rejects start %j', (s) => {
    expect(endsAtFrom(s, 30)).toBeNull()
    expect(endTimeLabel(s, 30)).toBeNull()
  })
})

describe('duration input validation', () => {
  it.each([
    ['5', 5],
    ['45', 45],
    [' 90 ', 90],
    ['600', 600],
    ['060', 60],
  ])('accepts %j', (v, n) => {
    expect(parseDurationInput(v)).toBe(n)
  })
  it.each(['', ' ', '4', '601', '0', '-30', '30.5', '30,5', '1e2', 'abc', '30 min', '1000', '+30'])('rejects %j', (v) => {
    expect(parseDurationInput(v)).toBeNull()
  })
  it('rejects non-strings', () => {
    for (const v of [null, undefined, 45, {}, []]) expect(parseDurationInput(v)).toBeNull()
  })
})

describe('search query normalization', () => {
  it('needs 2 characters', () => {
    expect(normalizeSearchQuery('')).toBeNull()
    expect(normalizeSearchQuery(' a ')).toBeNull()
    expect(normalizeSearchQuery('é')).toBeNull()
    expect(normalizeSearchQuery('!!')).toBeNull()
    expect(normalizeSearchQuery(null)).toBeNull()
    expect(normalizeSearchQuery('Jo')).toEqual({ text: 'Jo', kind: 'name' })
  })
  it('trims and collapses spaces', () => {
    expect(normalizeSearchQuery('  Ana   Lúcia ')).toEqual({ text: 'Ana Lúcia', kind: 'name' })
  })
  it('digits and phone punctuation are a phone search', () => {
    expect(normalizeSearchQuery('(11) 96666-1234')).toEqual({ text: '11966661234', kind: 'phone' })
    expect(normalizeSearchQuery('6666')).toEqual({ text: '6666', kind: 'phone' })
    expect(normalizeSearchQuery('7')).toBeNull()
    expect(normalizeSearchQuery('()')).toBeNull()
  })
  it('a name with a digit stays a name search', () => {
    expect(normalizeSearchQuery('Ana 2')?.kind).toBe('name')
  })
})

describe('search rows', () => {
  it('normalizes rows and tolerates bad data', () => {
    const rows = normalizeSearchRows([
      { appointment_id: 'a1', client_id: 'c1', client_name: 'Ana', starts_at: '2026-10-12T13:00:00+00:00', professional_name: 'Karol', service_name: 'Gel', status: 'scheduled' },
      { appointment_id: null, client_id: 'c2', client_name: 'Bia', starts_at: null, professional_name: null, service_name: null, status: null },
      { appointment_id: 'a3', client_id: 'c3', client_name: 'Cris', starts_at: 'lixo', professional_name: 'Mara', service_name: 'x', status: 'confirmed' },
      { client_name: 'sem id' },
      null,
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ appointmentId: 'a1', startsAt: '2026-10-12T13:00:00.000Z', clientName: 'Ana' })
    expect(rows[1]).toMatchObject({ appointmentId: null, startsAt: null, professionalName: '' })
    expect(rows[2]).toMatchObject({ appointmentId: null, startsAt: null })
    expect(normalizeSearchRows('x')).toEqual([])
  })
})
