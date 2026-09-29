import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { formatReply, hasForbiddenPhrase, dropForbiddenSentences, limitQuestions } from '../../supabase/functions/_shared/filters.ts'
import { argEnum, argText, argUuid, argUuidList, awayDue, checkPendingGate, isKnownClient, isLatestInbound } from '../../supabase/functions/_shared/gates.ts'
import { normalizePhone } from '../../supabase/functions/_shared/phone.ts'
import { safeEqual } from '../../supabase/functions/_shared/security.ts'
import { inWindow, parseInstant, spParts, tsKey } from '../../supabase/functions/_shared/time.ts'
import { parseWebhook } from '../../supabase/functions/_shared/zapi.ts'
import { parseSettings, modeAllows } from '../../supabase/functions/_shared/db.ts'
import { buildMessages } from '../../supabase/functions/_shared/context.ts'
import { confirmationsOpen, confirmationText, selectConfirmations, type CandidateAppt } from '../../supabase/functions/_shared/confirmations.ts'
import { DEFAULT_SETTINGS, type PendingAction, type Settings } from '../../supabase/functions/_shared/types.ts'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/zapi/${n}.json`, 'utf8'))

// São Paulo is UTC-3: 2026-10-05 12:00 SP = 15:00Z
const sp = (s: string) => parseInstant(`${s}-03:00`)!

describe('debounce: latest-message rule', () => {
  it('continues only for the newest inbound', () => {
    expect(isLatestInbound('B', 'B')).toBe(true)
    expect(isLatestInbound('C', 'B')).toBe(false)
    expect(isLatestInbound(undefined, 'B')).toBe(false)
  })
})

describe('window logic', () => {
  it('start inclusive, end exclusive, in São Paulo time', () => {
    expect(inWindow(sp('2026-10-05T06:59:00'), '07:00', '22:00')).toBe(false)
    expect(inWindow(sp('2026-10-05T07:00:00'), '07:00', '22:00')).toBe(true)
    expect(inWindow(sp('2026-10-05T21:59:00'), '07:00', '22:00')).toBe(true)
    expect(inWindow(sp('2026-10-05T22:00:00'), '07:00', '22:00')).toBe(false)
  })
  it('uses São Paulo wall clock, not UTC', () => {
    // 01:30Z is 22:30 the previous day in São Paulo
    expect(spParts(Date.UTC(2026, 9, 6, 1, 30)).ymd).toBe('2026-10-05')
    expect(inWindow(Date.UTC(2026, 9, 6, 1, 30), '07:00', '22:00')).toBe(false)
  })
  it('away message: once, then again after 12h', () => {
    const now = sp('2026-10-05T23:00:00')
    expect(awayDue(null, now)).toBe(true)
    expect(awayDue(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe(false)
    expect(awayDue(new Date(now - 12 * 3_600_000).toISOString(), now)).toBe(true)
  })
})

describe('time parsing', () => {
  it('rejects invalid input instead of guessing', () => {
    expect(parseInstant('2026-02-30T10:00')).toBeNull()
    expect(parseInstant('amanhã')).toBeNull()
    expect(parseInstant(42)).toBeNull()
  })
  it('offset-less input is São Paulo time', () => {
    expect(parseInstant('2026-10-05T12:00')).toBe(Date.UTC(2026, 9, 5, 15, 0))
  })
  it('tsKey keeps microsecond order', () => {
    expect(tsKey('2026-10-05T15:00:00.123456+00:00')!).toBeGreaterThan(tsKey('2026-10-05T15:00:00.123455+00:00')!)
    expect(tsKey('2026-10-05T15:00:00.12+00:00')!).toBeLessThan(tsKey('2026-10-05T15:00:00.123+00:00')!)
  })
})

describe('phone normalization (same as SQL normalize_phone)', () => {
  it.each([
    ['(11) 98765-4321', '5511987654321'],
    ['011 98765-4321', '5511987654321'],
    ['1133334444', '551133334444'],
    ['+55 11 98765-4321', '5511987654321'],
    ['5544999999999', '5544999999999'],
    ['554499999999', '554499999999'],
    ['12345', null],
    ['', null],
    [null, null],
  ])('%s -> %s', (i, o) => expect(normalizePhone(i)).toBe(o))
})

describe('forbidden-phrase filter', () => {
  it.each([
    'Não consigo ouvir áudios, pode escrever?',
    'Infelizmente não consigo ver imagens por aqui.',
    'Não consigo abrir a foto que você mandou.',
    'Não consigo interpretar figurinhas.',
    'Não escuto áudio.',
    'Pode mandar por texto?',
    'Consegue me enviar em texto o que você precisa?',
    'Escreva por escrito, por favor.',
    'Meu sistema não lê áudios.',
    'Não tenho como ouvir mensagens de voz.',
  ])('blocks: %s', (t) => expect(hasForbiddenPhrase(t)).toBe(true))

  it.each([
    'Pode me mandar a foto do modelo que você quer?',
    'Quer com a Mara, como das outras vezes?',
    'Não consigo hoje às 15h, mas tenho às 16h.',
    'Que lindo! Vou avisar a Karol da sua referência.',
    'Não trabalhamos com acrílico, mas temos gel.',
    'Não consegui entender direito, pode repetir?',
  ])('allows: %s', (t) => expect(hasForbiddenPhrase(t)).toBe(false))

  it('drops only the offending sentence', () => {
    expect(dropForbiddenSentences('Oi! Não consigo ouvir áudios. Qual serviço você quer?')).toBe('Oi! Qual serviço você quer?')
  })
})

describe('message splitter', () => {
  it('short text stays one message', () => {
    expect(formatReply('Oi, Maria! Como posso ajudar?')).toEqual(['Oi, Maria!\nComo posso ajudar?'])
  })
  it('never exceeds 2 messages, 3 lines, 320 chars', () => {
    const long = Array.from({ length: 14 }, (_, i) => `Frase número ${i} com um texto razoável para ocupar espaço.`).join(' ')
    const parts = formatReply(long)
    expect(parts.length).toBeLessThanOrEqual(2)
    for (const p of parts) {
      expect(p.split('\n').length).toBeLessThanOrEqual(3)
      expect(p.length).toBeLessThanOrEqual(320)
    }
  })
  it('respects a paragraph break as message boundary', () => {
    expect(formatReply('Combinado!\n\nSe precisar remarcar é só me falar.')).toEqual(['Combinado!', 'Se precisar remarcar é só me falar.'])
  })
  it('clips one giant sentence', () => {
    const parts = formatReply('a '.repeat(500))
    expect(parts.every((p) => p.length <= 320)).toBe(true)
  })
  it('keeps only one question', () => {
    expect(limitQuestions('Qual serviço? E qual dia? Ok.')).toBe('Qual serviço? Ok.')
    expect(formatReply('Qual serviço? Qual dia?')).toEqual(['Qual serviço?'])
  })
  it('empty in, empty out', () => expect(formatReply('  ')).toEqual([]))
})

describe('pending_action gate', () => {
  const now = sp('2026-10-05T10:00:00')
  const pending = (over: Partial<PendingAction> = {}): PendingAction => ({
    type: 'book', params: {}, summary: {}, proposed_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 20 * 60_000).toISOString(),
    presented_baseline: '2026-10-05T12:59:00+00:00', ...over,
  })
  it('refuses without a pending action', () => expect(checkPendingGate(null, now, 'x')).toMatchObject({ ok: false, error: 'NO_PENDING' }))
  it('refuses when expired', () =>
    expect(checkPendingGate(pending({ expires_at: new Date(now - 1).toISOString() }), now, '2026-10-05T13:30:00+00:00')).toMatchObject({ error: 'EXPIRED' }))
  it('refuses when the summary was never presented', () =>
    expect(checkPendingGate(pending({ presented_baseline: null }), now, '2026-10-05T13:30:00+00:00')).toMatchObject({ error: 'NOT_PRESENTED' }))
  it('refuses without an inbound after the proposal', () => {
    expect(checkPendingGate(pending(), now, '2026-10-05T12:59:00+00:00')).toMatchObject({ error: 'NO_CLIENT_REPLY' })
    expect(checkPendingGate(pending(), now, null)).toMatchObject({ error: 'NO_CLIENT_REPLY' })
  })
  it('allows after a client reply', () => expect(checkPendingGate(pending(), now, '2026-10-05T13:00:01+00:00')).toEqual({ ok: true }))
})

describe('ownership guard and argument validation', () => {
  const conv = { known_client_ids: ['11111111-1111-4111-8111-111111111111'] }
  it('accepts only known client ids', () => {
    expect(isKnownClient(conv, '11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isKnownClient(conv, '22222222-2222-4222-8222-222222222222')).toBe(false)
    expect(isKnownClient(conv, undefined)).toBe(false)
    expect(isKnownClient(conv, "x' or 1=1")).toBe(false)
  })
  it('validates uuids, enums, lists and text', () => {
    expect(argUuid('nope', 'x').ok).toBe(false)
    expect(argUuid('11111111-1111-4111-8111-111111111111', 'x').ok).toBe(true)
    expect(argEnum('placement', ['placement', 'maintenance'] as const, 'a').ok).toBe(true)
    expect(argEnum('drop table', ['placement'] as const, 'a').ok).toBe(false)
    expect(argUuidList(['bad'], 'l').ok).toBe(false)
    expect(argUuidList(undefined, 'l')).toEqual({ ok: true, value: [] })
    expect(argText('  a  ', 't', 2, 10).ok).toBe(false)
    expect(argText('x'.repeat(11), 't', 1, 10).ok).toBe(false)
    expect(argText('  Maria   Silva ', 't', 2, 80)).toEqual({ ok: true, value: 'Maria Silva' })
  })
  it('constant-time compare', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(false)
    expect(safeEqual(null, 'a')).toBe(false)
  })
})

describe('settings and mode gate', () => {
  it('fails closed on unknown mode and invalid values', () => {
    const s = parseSettings([{ key: 'agent_mode', value: 'YOLO' }, { key: 'debounce_seconds', value: 9999 }])
    expect(s.agent_mode).toBe('off')
    expect(s.debounce_seconds).toBe(8)
  })
  it('off blocks all, test only whitelisted, live all', () => {
    const base: Settings = { ...DEFAULT_SETTINGS, agent_test_numbers: ['5511999990000'] }
    expect(modeAllows({ ...base, agent_mode: 'off' }, '5511999990000')).toBe(false)
    expect(modeAllows({ ...base, agent_mode: 'test' }, '5511999990000')).toBe(true)
    expect(modeAllows({ ...base, agent_mode: 'test' }, '5511888880000')).toBe(false)
    expect(modeAllows({ ...base, agent_mode: 'live' }, '5511888880000')).toBe(true)
  })
})

describe('audio failure path', () => {
  it('a failed transcript reaches the model as a neutral placeholder, never as an audio limitation', () => {
    const msgs = buildMessages([
      { id: '1', direction: 'in', external_id: 'a', kind: 'audio', body: null, purpose: null, from_human: false, created_at: 'x' },
    ])
    expect(msgs).toEqual([{ role: 'user', content: '[mensagem de voz sem transcrição]' }])
  })
  it('merges consecutive inbound messages into one user turn and starts with a user turn', () => {
    const m = (direction: 'in' | 'out', body: string) => ({ id: body, direction, external_id: body, kind: 'text', body, purpose: null, from_human: false, created_at: 'x' })
    expect(buildMessages([m('out', 'oi'), m('in', 'a'), m('in', 'b'), m('in', 'c')])).toEqual([{ role: 'user', content: 'a\nb\nc' }])
  })
})

describe('Z-API payload parser (fixtures)', () => {
  it('text', () => expect(parseWebhook(fx('text'))).toMatchObject({ type: 'inbound', kind: 'text', text: 'teste', phone: '5544999999999', externalId: '3EB0AAAA0001' }))
  it('audio', () => expect(parseWebhook(fx('audio'))).toMatchObject({ type: 'inbound', kind: 'audio', mediaUrl: 'https://example.test/a.ogg' }))
  it('image', () => expect(parseWebhook(fx('image'))).toMatchObject({ type: 'inbound', kind: 'image', mediaUrl: 'https://example.test/i.jpg', mimeType: 'image/jpeg' }))
  it('sticker', () => expect(parseWebhook(fx('sticker'))).toMatchObject({ type: 'inbound', kind: 'sticker' }))
  it.each(['video', 'document', 'location', 'contact'])('%s -> other', (n) => expect(parseWebhook(fx(n))).toMatchObject({ type: 'inbound', kind: 'other' }))
  it('ignores groups, broadcasts, reactions and non-message events', () => {
    expect(parseWebhook(fx('group'))).toEqual({ type: 'ignore', reason: 'group_or_broadcast' })
    expect(parseWebhook(fx('broadcast'))).toEqual({ type: 'ignore', reason: 'group_or_broadcast' })
    expect(parseWebhook(fx('reaction'))).toMatchObject({ type: 'ignore' })
    expect(parseWebhook(fx('status-callback'))).toEqual({ type: 'ignore', reason: 'not_message' })
    expect(parseWebhook(null)).toMatchObject({ type: 'ignore' })
    expect(parseWebhook('x')).toMatchObject({ type: 'ignore' })
  })
  it('fromMe', () => expect(parseWebhook(fx('from-me'))).toMatchObject({ type: 'from_me', fromApi: false, body: 'Oi, aqui é a Karol' }))
  it('fromApi marks messages we sent', () => expect(parseWebhook({ ...fx('from-me'), fromApi: true })).toMatchObject({ type: 'from_me', fromApi: true }))
})

describe('confirmation selection', () => {
  const now = sp('2026-10-05T16:30:00')
  const mk = (id: string, over: Partial<CandidateAppt> = {}): CandidateAppt => ({
    id, client_id: `c-${id}`, client_name: 'maria silva', client_phone: '11 98765-4321', status: 'scheduled',
    starts_at: '2026-10-06T10:00:00-03:00', created_at: '2026-10-01T10:00:00-03:00', service_name: 'Manicure com gel', action: 'placement', professional_name: 'Mara', ...over,
  })
  const settings: Settings = { ...DEFAULT_SETTINGS, agent_mode: 'live', confirmation_enabled: true }
  const sel = (a: CandidateAppt[], sent = new Set<string>(), s = settings) => selectConfirmations({ appointments: a, alreadySent: sent, nowMs: now, settings: s })

  it('selects only tomorrow in São Paulo time', () => {
    expect(sel([mk('a'), mk('today', { starts_at: '2026-10-05T18:00:00-03:00' }), mk('later', { starts_at: '2026-10-07T10:00:00-03:00' })]).flatMap((b) => b.items.map((i) => i.id))).toEqual(['a'])
    // 23:30 SP tomorrow is 02:30Z the day after: still "tomorrow" locally
    expect(sel([mk('late', { starts_at: '2026-10-06T23:30:00-03:00' })])).toHaveLength(1)
  })
  it('only status scheduled', () => expect(sel([mk('a', { status: 'confirmed' }), mk('b', { status: 'cancelled' }), mk('c')]).flatMap((b) => b.items.map((i) => i.id))).toEqual(['c']))
  it('skips invalid phones and archived-less rows without phone', () => expect(sel([mk('a', { client_phone: null }), mk('b', { client_phone: '123' })])).toEqual([]))
  it('skips appointments created less than 3h ago', () =>
    expect(sel([mk('new', { created_at: '2026-10-05T14:00:00-03:00' }), mk('old', { created_at: '2026-10-05T13:00:00-03:00' })]).flatMap((b) => b.items.map((i) => i.id))).toEqual(['old']))
  it('uniqueness: never re-sends an appointment that already has a confirmation', () => expect(sel([mk('a'), mk('b')], new Set(['a'])).flatMap((b) => b.items.map((i) => i.id))).toEqual(['b']))
  it('batches per phone, ordered by time', () => {
    const b = sel([mk('b', { starts_at: '2026-10-06T15:00:00-03:00' }), mk('a'), mk('x', { client_phone: '21 99999-0000' })])
    expect(b).toHaveLength(2)
    expect(b[0]!.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(confirmationText(b[0]!)).toContain('Oi, Maria!')
    expect(confirmationText(b[0]!)).toContain('10:00')
    expect(confirmationText(b[0]!)).toContain('Posso confirmar?')
  })
  it('test mode: whitelisted phones only', () => expect(sel([mk('a')], new Set(), { ...settings, agent_mode: 'test', agent_test_numbers: [] })).toEqual([]))
  it('caps at 40 recipients per run', () => {
    const many = Array.from({ length: 50 }, (_, i) => mk(`m${i}`, { client_phone: `11 9${String(1000_0000 + i)}` }))
    expect(sel(many)).toHaveLength(40)
  })
  it('opens between confirmation_hour and 20:00 only, and never when off', () => {
    expect(confirmationsOpen(settings, sp('2026-10-05T15:59:00'))).toBe(false)
    expect(confirmationsOpen(settings, sp('2026-10-05T16:00:00'))).toBe(true)
    expect(confirmationsOpen(settings, sp('2026-10-05T20:00:00'))).toBe(false)
    expect(confirmationsOpen({ ...settings, agent_mode: 'off' }, sp('2026-10-05T17:00:00'))).toBe(false)
    expect(confirmationsOpen({ ...settings, confirmation_enabled: false }, sp('2026-10-05T17:00:00'))).toBe(false)
  })
})
