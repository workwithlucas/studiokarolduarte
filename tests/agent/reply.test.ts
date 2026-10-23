import { describe, expect, it } from 'vitest'
import { slotLabel, parseInstant } from '../../supabase/functions/_shared/time.ts'
import {
  addressLineOf, confirmedReply, correctionNote, expandTokens, findViolations, optionTokens, FALLBACK_TEXT,
  type GuardInput, type OptionRef, type WriteKind,
} from '../../supabase/functions/_shared/reply.ts'
import { OPTIONS_TTL_MS, resolveOption } from '../../supabase/functions/_shared/gates.ts'
import { parseSettings } from '../../supabase/functions/_shared/db.ts'
import { KB } from '../../supabase/functions/_shared/kb.ts'
import { pickPackage } from '../../supabase/functions/_shared/tools.ts'

// "now" = terça-feira 20/10/2026 10:00 in São Paulo
const NOW = parseInstant('2026-10-20T10:00:00-03:00')!

describe('slotLabel', () => {
  it('today / tomorrow / day after / other days', () => {
    expect(slotLabel('2026-10-20T17:00:00-03:00', NOW)).toBe('hoje (terça, 20/10) às 17:00')
    expect(slotLabel('2026-10-21T17:00:00-03:00', NOW)).toBe('amanhã (quarta, 21/10) às 17:00')
    expect(slotLabel('2026-10-22T17:00:00-03:00', NOW)).toBe('depois de amanhã (quinta, 22/10) às 17:00')
    expect(slotLabel('2026-10-23T17:00:00-03:00', NOW)).toBe('sexta (23/10) às 17:00')
    expect(slotLabel('2026-10-24T09:30:00-03:00', NOW)).toBe('sábado (24/10) às 09:30')
    expect(slotLabel('2026-10-25T09:30:00-03:00', NOW)).toBe('domingo (25/10) às 09:30')
    expect(slotLabel('2026-10-26T09:30:00-03:00', NOW)).toBe('segunda (26/10) às 09:30')
  })
  it('weekdays are lowercase pt-BR without "-feira"', () => {
    expect(slotLabel('2026-10-23T17:00:00-03:00', NOW)).not.toMatch(/feira|[A-Z]/)
  })
  it('month boundary', () => {
    const now = parseInstant('2026-10-31T10:00:00-03:00')!
    expect(slotLabel('2026-11-01T08:00:00-03:00', now)).toBe('amanhã (domingo, 01/11) às 08:00')
    expect(slotLabel('2026-11-02T08:00:00-03:00', now)).toBe('depois de amanhã (segunda, 02/11) às 08:00')
    expect(slotLabel('2026-11-03T08:00:00-03:00', now)).toBe('terça (03/11) às 08:00')
  })
  it('year boundary', () => {
    const now = parseInstant('2026-12-31T20:00:00-03:00')!
    expect(slotLabel('2027-01-01T09:00:00-03:00', now)).toBe('amanhã (sexta, 01/01) às 09:00')
    expect(slotLabel('2027-01-02T09:00:00-03:00', now)).toBe('depois de amanhã (sábado, 02/01) às 09:00')
    expect(slotLabel('2027-01-04T09:00:00-03:00', now)).toBe('segunda (04/01) às 09:00')
  })
  it('the day is decided in São Paulo, not in UTC', () => {
    // 02:30Z on the 21st is 23:30 on the 20th in São Paulo
    expect(slotLabel('2026-10-21T02:30:00Z', NOW)).toBe('hoje (terça, 20/10) às 23:30')
    // "now" 02:30Z on the 21st is 23:30 on the 20th in São Paulo: 04:00Z (01:00 on the 21st) is tomorrow, not today
    expect(slotLabel('2026-10-21T04:00:00Z', parseInstant('2026-10-21T02:30:00Z')!)).toBe('amanhã (quarta, 21/10) às 01:00')
  })
  it('accepts epoch milliseconds and rejects invalid input', () => {
    expect(slotLabel(NOW + 86_400_000, NOW)).toBe('amanhã (quarta, 21/10) às 10:00')
    expect(slotLabel('not a date', NOW)).toBe('')
  })
})

const opts: OptionRef[] = [
  { token: 'o1', professional_id: 'p', service_id: 's', action: 'placement', starts_at: '2026-10-21T20:00:00Z', label: 'amanhã (quarta, 21/10) às 17:00' },
  { token: 'o2', professional_id: 'p', service_id: 's', action: 'placement', starts_at: '2026-10-22T13:00:00Z', label: 'depois de amanhã (quinta, 22/10) às 10:00' },
]
const guard = (over: Partial<GuardInput> = {}): GuardInput => ({ usedDayTools: false, writes: new Set<WriteKind>(), tokens: { ...optionTokens(opts), resumo: 'x' }, ...over })
const rules = (text: string, g = guard()) => findViolations(text, g).map((v) => v.rule)

describe('reply guards', () => {
  it('literal times are violations (HH:MM, HHh, HHhMM)', () => {
    expect(rules('Tenho às 17:00')).toContain('time')
    expect(rules('Tenho às 9:30')).toContain('time')
    expect(rules('Pode ser 17h?')).toContain('time')
    expect(rules('Pode ser 17h30?')).toContain('time')
    expect(rules('Pode ser às 8h?')).toContain('time')
  })
  it('literal dates are violations', () => {
    expect(rules('Dia 21/10 está livre')).toContain('date')
    expect(rules('Dia 1/2 está livre')).toContain('date')
    expect(rules('Em 21/10/2026')).toContain('date')
  })
  it('day words are violations only when the run used get_availability, propose_* or list_my_appointments', () => {
    for (const w of ['hoje', 'amanhã', 'depois de amanhã', 'sexta', 'sexta-feira', 'sábado', 'domingo', 'segunda', 'terça', 'quarta', 'quinta']) {
      expect(rules(`Pode ser ${w}?`, guard({ usedDayTools: true }))).toContain('day_word')
      expect(rules(`Pode ser ${w}?`, guard({ usedDayTools: false }))).not.toContain('day_word')
    }
  })
  it('ordinary text passes: prices, durations, ordinals, tokens', () => {
    expect(rules('Fica R$ 150,00, dura 90 minutos. Tenho {o1} ou {o2}. {resumo} Posso confirmar?', guard({ usedDayTools: true }))).toEqual([])
    expect(rules('Oi, Ana! Como posso ajudar?')).toEqual([])
    expect(rules('Prefere com a Mara ou com a Milena?')).toEqual([])
    expect(rules('A Karol vai confirmar com você')).toEqual([])
  })
  it('claims need a matching successful write', () => {
    for (const t of ['Marquei seu horário', 'Agendei!', 'Está agendado', 'Já está marcado', 'Reservei para você', 'Remarquei', 'Está remarcado', 'Desmarquei', 'Ficou desmarcado', 'Cancelei', 'Está cancelado', 'Confirmei', 'Está confirmado']) {
      expect(rules(t), t).toContain('claim')
    }
    const w = (...k: WriteKind[]) => guard({ writes: new Set(k) })
    expect(rules('Marquei!', w('book'))).not.toContain('claim')
    expect(rules('Agendei!', w('reschedule'))).not.toContain('claim')
    expect(rules('Remarquei', w('reschedule'))).not.toContain('claim')
    expect(rules('Remarquei', w('book'))).toContain('claim')
    expect(rules('Cancelei', w('cancel'))).not.toContain('claim')
    expect(rules('Cancelei', w('book', 'confirm'))).toContain('claim')
    expect(rules('Confirmei', w('confirm'))).not.toContain('claim')
    expect(rules('Confirmado!', w('book'))).toContain('claim')
  })
  it('promises are always violations, even with writes', () => {
    for (const t of ['Vou marcar já', 'vou agendar para você', 'Vou reservar', 'vou remarcar', 'Vou desmarcar seu horário', 'Vou cancelar', 'vou confirmar', 'Vou te agendar', 'Vamos ajustar', 'vou ajustar o horário']) {
      expect(rules(t, guard({ writes: new Set<WriteKind>(['book', 'cancel', 'reschedule', 'confirm']) })), t).toContain('promise')
    }
  })
  it('telling the client the Karol will check something is not a promise of an action', () => {
    expect(rules(FALLBACK_TEXT)).toEqual([])
    expect(rules('Vou confirmar com a Karol e te aviso')).toEqual([])
  })
  it('unknown tokens are violations', () => {
    expect(rules('Tenho {o9}')).toContain('token')
    expect(rules('Tenho {o1}')).toEqual([])
  })
  it('tokens never hide a literal time next to them', () => {
    expect(rules('{o1} às 17:00')).toContain('time')
  })
  it('the corrective note names the rule', () => {
    expect(correctionNote(findViolations('Tenho 17:00', guard()))).toMatch(/CORREÇÃO OBRIGATÓRIA[\s\S]*nunca escreva horários/)
    expect(correctionNote(findViolations('Vou marcar', guard()))).toMatch(/nunca prometa uma ação/)
    expect(correctionNote(findViolations('Marquei', guard()))).toMatch(/nunca diga que uma ação foi feita/)
  })
})

describe('token expansion', () => {
  it('expands {o1}…{o12} to labels and drops unknown ones', () => {
    expect(expandTokens('Tenho {o1} ou {o2}. {o7}', optionTokens(opts))).toBe('Tenho amanhã (quarta, 21/10) às 17:00 ou depois de amanhã (quinta, 22/10) às 10:00. ')
  })
  it('expands {resumo} and package facts', () => {
    expect(expandTokens('{resumo} Vale até {p1_vence}.', { resumo: 'Resumo.', p1_vence: '20/11/2026' })).toBe('Resumo. Vale até 20/11/2026.')
  })
})

describe('code-built replies', () => {
  const address = addressLineOf(KB)
  it('finds the address in the KB and ignores a TODO', () => {
    expect(address).toMatch(/^R\. José Siqueira/)
    expect(addressLineOf('Endereço e como chegar: TODO: preencher')).toBeNull()
    expect(addressLineOf('sem endereço')).toBeNull()
  })
  it('book, paid, with the address line', () => {
    expect(confirmedReply([{ kind: 'book', clientName: 'Ana', service: 'Volume', professional: 'Mara', label: 'amanhã (quarta, 21/10) às 17:00', packageRemaining: null }], address)).toEqual([
      'Pronto, Ana! Agendei Volume com Mara amanhã (quarta, 21/10) às 17:00.',
      `Endereço: ${address}`,
    ])
  })
  it('book with a package', () => {
    expect(confirmedReply([{ kind: 'book', clientName: 'Ana', service: 'Volume', professional: 'Mara', label: 'sexta (23/10) às 17:00', packageRemaining: 2 }], address)[0]).toBe(
      'Pronto, Ana! Agendei Volume com Mara sexta (23/10) às 17:00. Vai usar uma sessão do seu pacote (restam 2).',
    )
  })
  it('book without an address in the KB: no address message', () => {
    expect(confirmedReply([{ kind: 'book', clientName: null, service: 'Volume', professional: 'Mara', label: 'sexta (23/10) às 17:00', packageRemaining: null }], null)).toEqual([
      'Pronto! Agendei Volume com Mara sexta (23/10) às 17:00.',
    ])
  })
  it('reschedule', () => {
    expect(confirmedReply([{ kind: 'reschedule', service: 'Volume', label: 'sexta (23/10) às 17:00' }], address)).toEqual([
      'Remarquei seu Volume para sexta (23/10) às 17:00.',
      `Endereço: ${address}`,
    ])
  })
  it('cancel, with and without a package; no address', () => {
    expect(confirmedReply([{ kind: 'cancel', service: 'Volume', label: 'sexta (23/10) às 17:00', package: false }], address)).toEqual([
      'Cancelei seu Volume de sexta (23/10) às 17:00. Se quiser remarcar é só me falar.',
    ])
    expect(confirmedReply([{ kind: 'cancel', service: 'Volume', label: 'sexta (23/10) às 17:00', package: true }], address)).toEqual([
      'Cancelei seu Volume de sexta (23/10) às 17:00. A sessão do pacote volta para você. Se quiser remarcar é só me falar.',
    ])
  })
  it('attendance confirmation, one or several', () => {
    expect(confirmedReply([{ kind: 'confirm', label: 'amanhã (quarta, 21/10) às 10:00' }], address)).toEqual(['Confirmado! Te esperamos amanhã (quarta, 21/10) às 10:00.'])
    expect(confirmedReply([{ kind: 'confirm', label: 'amanhã (quarta, 21/10) às 10:00' }, { kind: 'confirm', label: 'amanhã (quarta, 21/10) às 15:00' }], address)).toEqual([
      'Confirmado! Te esperamos amanhã (quarta, 21/10) às 10:00 e amanhã (quarta, 21/10) às 15:00.',
    ])
  })
})

describe('option tokens (30-minute validity)', () => {
  const conv = (ageMs: number | null) => ({ last_options: opts, options_at: ageMs === null ? null : new Date(NOW - ageMs).toISOString() })
  it('resolves a fresh token, also written with braces', () => {
    const r = resolveOption(conv(60_000), 'o2', NOW)
    expect(r.ok && r.option.token).toBe('o2')
    expect(resolveOption(conv(60_000), '{o1}', NOW).ok).toBe(true)
  })
  it('expires after 30 minutes', () => {
    expect(resolveOption(conv(OPTIONS_TTL_MS), 'o1', NOW).ok).toBe(true)
    const r = resolveOption(conv(OPTIONS_TTL_MS + 1000), 'o1', NOW)
    expect(r).toMatchObject({ ok: false, code: 'OPTION_EXPIRED' })
  })
  it('no stored options or no timestamp is expired', () => {
    expect(resolveOption({ last_options: null, options_at: null }, 'o1', NOW)).toMatchObject({ ok: false, code: 'OPTION_EXPIRED' })
    expect(resolveOption(conv(null), 'o1', NOW)).toMatchObject({ ok: false, code: 'OPTION_EXPIRED' })
  })
  it('unknown or non-string token is invalid, not expired', () => {
    expect(resolveOption(conv(1000), 'o9', NOW)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(resolveOption(conv(1000), 3, NOW)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
  })
})

describe('package choice for a booking', () => {
  const pk = (remaining: number, expires_at: string, id = 'a') => ({ client_package_id: id, template_name: 'T', remaining, expires_at, status: 'active' })
  it('uses the first package with sessions that is valid on the day', () => {
    expect(pickPackage([pk(2, '2026-11-30', 'x')], '2026-11-01', 'Volume').use?.client_package_id).toBe('x')
    expect(pickPackage([pk(2, '2026-10-30', 'early'), pk(1, '2026-12-30', 'late')], '2026-11-05', 'Volume').use?.client_package_id).toBe('late')
  })
  it('expired at that date: warning line, paid', () => {
    expect(pickPackage([pk(2, '2026-10-30')], '2026-11-05', 'Volume')).toEqual({ use: null, note: 'Seu pacote de Volume não pode ser usado nessa data.' })
  })
  it('no sessions left: warning line, paid', () => {
    expect(pickPackage([pk(0, '2026-12-30')], '2026-11-05', 'Volume')).toEqual({ use: null, note: 'Seu pacote de Volume já usou todas as sessões.' })
  })
  it('no package at all: nothing', () => {
    expect(pickPackage([], '2026-11-05', 'Volume')).toEqual({ use: null, note: null })
  })
})

describe('confirmation pacing settings', () => {
  it('defaults to 2 and 6 seconds', () => {
    expect(parseSettings([])).toMatchObject({ confirmation_delay_min_s: 2, confirmation_delay_max_s: 6 })
  })
  it('reads the settings; max is never below min; junk falls back', () => {
    expect(parseSettings([{ key: 'confirmation_delay_min_s', value: 3 }, { key: 'confirmation_delay_max_s', value: 9 }])).toMatchObject({ confirmation_delay_min_s: 3, confirmation_delay_max_s: 9 })
    expect(parseSettings([{ key: 'confirmation_delay_min_s', value: 8 }, { key: 'confirmation_delay_max_s', value: 3 }])).toMatchObject({ confirmation_delay_min_s: 8, confirmation_delay_max_s: 8 })
    expect(parseSettings([{ key: 'confirmation_delay_min_s', value: 'x' }])).toMatchObject({ confirmation_delay_min_s: 2 })
  })
})
