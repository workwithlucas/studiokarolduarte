import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateGates, MAX_ATTEMPTS, scheduledSendAllowed, type GateState } from '../../supabase/functions/_shared/decision.ts'
import { buildMessages, STAFF_LABEL } from '../../supabase/functions/_shared/context.ts'
import { parseSettings, modeAllows, modeRuns } from '../../supabase/functions/_shared/db.ts'
import { phoneKey } from '../../supabase/functions/_shared/phone.ts'
import { parseWebhook, providerTime } from '../../supabase/functions/_shared/zapi.ts'
import { parseInstant } from '../../supabase/functions/_shared/time.ts'

const vectors = JSON.parse(readFileSync('tests/fixtures/phone-keys.json', 'utf8'))
const at = (s: string) => parseInstant(`${s}-03:00`)!
const iso = (s: string) => new Date(at(s)).toISOString()

describe('phoneKey: shared vectors (the same file is checked against SQL by test:agent)', () => {
  it('every spelling of the same number gives the same key', () => {
    for (const v of vectors.same as string[]) expect(phoneKey(v), v).toBe(vectors.sameKey)
  })
  it('a different DDD or number gives a different key', () => {
    for (const v of vectors.different as Array<{ input: string; key: string }>) {
      expect(phoneKey(v.input), v.input).toBe(v.key)
      expect(v.key).not.toBe(vectors.sameKey)
    }
  })
  it('invalid input gives null', () => {
    for (const v of vectors.invalid as Array<string | null>) expect(phoneKey(v)).toBeNull()
  })
  it('a leading 55 is stripped only when it is a country code', () => {
    expect(phoneKey('55 99999-1234')).toBe('5599991234') // DDD 55 (RS), no country code
    expect(phoneKey('+55 55 99999-1234')).toBe('5599991234')
  })
})

// 05/10/2026 15:41 São Paulo
const NOW = at('2026-10-05T15:41:00')
const base = (over: Partial<GateState> = {}): GateState => ({
  db_now: iso('2026-10-05T15:41:00'),
  mode: 'live',
  test_numbers: [],
  human_pause_hours: 3,
  live_since: iso('2026-10-05T15:30:00'),
  off_since: null,
  max_inbound_age_minutes: 10,
  breaker_max_sends: 6,
  breaker_window_minutes: 5,
  conv: { id: 'c', phone_e164: '5547996252877', phone_key: '4796252877', mode: 'agent', human_until: null },
  message: { message_id: 'M2', sent_at: iso('2026-10-05T15:38:00') },
  latest_inbound: { message_id: 'M2', sent_at: iso('2026-10-05T15:38:00') },
  last_agent_out_at: null,
  last_staff_out_at: null,
  head: '2|x',
  decision: null,
  recent_agent_sends: 0,
  ...over,
})

describe('evaluateGates: first match stops', () => {
  it('lets a fresh, unanswered message through', () => {
    expect(evaluateGates(base(), NOW)).toBeNull()
  })
  it('1: already decided -> skipped_duplicate; an error decision may retry until MAX_ATTEMPTS', () => {
    expect(evaluateGates(base({ decision: { id: 'd', action: 'replied', reason: null, attempts: 1 } }), NOW)?.action).toBe('skipped_duplicate')
    expect(evaluateGates(base({ decision: { id: 'd', action: 'skipped_before_live', reason: 'quarantined', attempts: 1 } }), NOW)?.action).toBe('skipped_duplicate')
    expect(evaluateGates(base({ decision: { id: 'd', action: 'error', reason: null, attempts: 1 } }), NOW)).toBeNull()
    expect(evaluateGates(base({ decision: { id: 'd', action: 'error', reason: null, attempts: MAX_ATTEMPTS } }), NOW)?.action).toBe('skipped_duplicate')
  })
  it('2: off -> skipped_mode; test needs the allow-list (by phone_key); shadow runs', () => {
    expect(evaluateGates(base({ mode: 'off' }), NOW)).toEqual({ action: 'skipped_mode', reason: 'off' })
    expect(evaluateGates(base({ mode: 'test', test_numbers: ['5511999990000'] }), NOW)?.action).toBe('skipped_mode')
    expect(evaluateGates(base({ mode: 'test', test_numbers: ['(47) 9625-2877'] }), NOW)).toBeNull() // same key, other spelling
    expect(evaluateGates(base({ mode: 'shadow', live_since: null }), NOW)).toBeNull()
  })
  it('3: before live_since and unanswered -> skipped_before_live (also when live_since is missing)', () => {
    expect(evaluateGates(base({ live_since: iso('2026-10-05T15:39:00') }), NOW)?.action).toBe('skipped_before_live')
    expect(evaluateGates(base({ live_since: null }), NOW)?.action).toBe('skipped_before_live')
  })
  it('3: before live_since but answered by staff -> the answered gate names it', () => {
    const st = base({ live_since: iso('2026-10-05T15:39:00'), last_staff_out_at: iso('2026-10-05T15:38:30') })
    expect(evaluateGates(st, NOW)?.action).toBe('skipped_answered')
  })
  it('4: older than max_inbound_age_minutes -> skipped_stale (the 03/10 backlog replayed on 05/10)', () => {
    const sat = base({ message: { message_id: 'M1', sent_at: iso('2026-10-03T10:00:00') }, live_since: iso('2026-10-03T09:00:00') })
    expect(evaluateGates(sat, NOW)?.action).toBe('skipped_stale')
    expect(evaluateGates(base({ message: { message_id: 'M2', sent_at: iso('2026-10-05T15:30:59') } }), NOW)?.action).toBe('skipped_stale')
    expect(evaluateGates(base({ message: { message_id: 'M2', sent_at: iso('2026-10-05T15:31:01') } }), NOW)).toBeNull()
  })
  it('5: any outbound after the inbound -> skipped_answered (agent or staff)', () => {
    expect(evaluateGates(base({ last_agent_out_at: iso('2026-10-05T15:39:00') }), NOW)).toEqual({ action: 'skipped_answered', reason: 'agent_answered' })
    expect(evaluateGates(base({ last_staff_out_at: iso('2026-10-05T15:39:00') }), NOW)).toEqual({ action: 'skipped_answered', reason: 'staff_answered' })
  })
  it('5: staff spoke before the inbound inside human_pause_hours, or the thread is paused -> skipped_human', () => {
    expect(evaluateGates(base({ last_staff_out_at: iso('2026-10-05T13:00:00') }), NOW)).toEqual({ action: 'skipped_human', reason: 'staff_window' })
    expect(evaluateGates(base({ last_staff_out_at: iso('2026-10-05T12:00:00') }), NOW)).toBeNull() // 3h41 ago: window over
    const paused = base({ conv: { id: 'c', phone_e164: '5547996252877', phone_key: '4796252877', mode: 'human', human_until: null } })
    expect(evaluateGates(paused, NOW)).toEqual({ action: 'skipped_human', reason: 'thread_paused' })
    const until = base({ conv: { id: 'c', phone_e164: '5547996252877', phone_key: '4796252877', mode: 'human', human_until: iso('2026-10-05T18:00:00') } })
    expect(evaluateGates(until, NOW)?.action).toBe('skipped_human')
    const over = base({ conv: { id: 'c', phone_e164: '5547996252877', phone_key: '4796252877', mode: 'human', human_until: iso('2026-10-05T15:00:00') } })
    expect(evaluateGates(over, NOW)).toBeNull()
    expect(evaluateGates(paused, NOW, { duplicate: true, latest: true, ignorePause: true })).toBeNull() // the agent's own handoff sentence
  })
  it('6: only the latest unanswered inbound of a thread is answered', () => {
    const st = base({ latest_inbound: { message_id: 'M3', sent_at: iso('2026-10-05T15:40:00') } })
    expect(evaluateGates(st, NOW)).toEqual({ action: 'no_reply', reason: 'superseded' })
    expect(evaluateGates(st, NOW, { duplicate: true, latest: false })).toBeNull()
  })
  it('order: mode beats everything after it', () => {
    const st = base({ mode: 'off', last_staff_out_at: iso('2026-10-05T15:39:00'), live_since: null })
    expect(evaluateGates(st, NOW)?.action).toBe('skipped_mode')
  })
})

describe('scheduled sends (reminders): off and shadow never send', () => {
  it('only live, or test with an allow-listed number', () => {
    expect(scheduledSendAllowed({ mode: 'off', test_numbers: [] }, '5547996252877')).toBe(false)
    expect(scheduledSendAllowed({ mode: 'shadow', test_numbers: [] }, '5547996252877')).toBe(false)
    expect(scheduledSendAllowed({ mode: 'test', test_numbers: ['5547996252877'] }, '554796252877')).toBe(true)
    expect(scheduledSendAllowed({ mode: 'test', test_numbers: ['5511999990000'] }, '5547996252877')).toBe(false)
    expect(scheduledSendAllowed({ mode: 'live', test_numbers: [] }, '5547996252877')).toBe(true)
  })
})

describe('modes', () => {
  it('shadow is a known mode and never sends; unknown fails closed', () => {
    const s = parseSettings([{ key: 'agent_mode', value: 'shadow' }])
    expect(s.agent_mode).toBe('shadow')
    expect(modeAllows(s, '5547996252877')).toBe(false)
    expect(modeRuns(s, '5547996252877')).toBe(true)
    expect(parseSettings([{ key: 'agent_mode', value: 'banana' }]).agent_mode).toBe('off')
    expect(modeRuns(parseSettings([{ key: 'agent_mode', value: 'off' }]), 'x')).toBe(false)
  })
})

describe('provider time and staff labeling', () => {
  it('providerTime accepts plausible epoch-ms only', () => {
    expect(providerTime(1759678860000)).toBe(new Date(1759678860000).toISOString())
    for (const v of [undefined, null, 'x', NaN, 0, 1632, -5, 9e15, '1759678860000']) expect(providerTime(v)).toBeNull()
  })
  it('parseWebhook carries the provider time', () => {
    const raw = JSON.parse(readFileSync('tests/fixtures/zapi/text.json', 'utf8'))
    const ev = parseWebhook(raw)
    expect(ev.type).toBe('inbound')
    if (ev.type === 'inbound') expect(ev.sentAt).toBe(providerTime(raw.momment))
  })
  it('staff messages reach the model labeled "Equipe" and merge as the assistant turn', () => {
    const m = (direction: 'in' | 'out', body: string, sender: 'client' | 'agent' | 'staff', from_human = false) =>
      ({ id: body, direction, external_id: body, kind: 'text', body, purpose: null, from_human, sender, created_at: '2026-10-05T15:00:00Z' }) as never
    const out = buildMessages([m('in', 'oi', 'client'), m('out', 'Oi! Tenho horário amanhã.', 'staff', true), m('in', 'pode ser', 'client')])
    expect(out).toHaveLength(3)
    expect(out[1]!.content).toBe(`${STAFF_LABEL} Oi! Tenho horário amanhã.`)
    expect(STAFF_LABEL).toBe('[Equipe]')
  })
})

describe('one outbound function: nothing else may call Z-API', () => {
  const root = 'supabase/functions'
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
    })
  it('only outbound.ts imports sendText; no other file fetches api.z-api.io', () => {
    const offenders: string[] = []
    for (const f of files(root)) {
      const norm = f.replaceAll('\\', '/')
      if (norm.endsWith('_shared/zapi.ts') || norm.endsWith('_shared/outbound.ts')) continue
      const src = readFileSync(f, 'utf8')
      if (/\bsendText\b/.test(src) || /api\.z-api\.io/.test(src)) offenders.push(norm)
    }
    expect(offenders).toEqual([])
    expect(readFileSync(`${root}/_shared/outbound.ts`, 'utf8')).toMatch(/import \{ sendText \} from '\.\/zapi\.ts'/)
  })
  it('the agent function never reads settings once and sends later: sendReply re-reads before every part', () => {
    const src = readFileSync(`${root}/_shared/outbound.ts`, 'utf8')
    const loop = src.slice(src.indexOf('for (let i = 0; i < req.parts.length'))
    expect(loop.indexOf('getGateState')).toBeGreaterThan(-1)
    expect(loop.indexOf('getGateState')).toBeLessThan(loop.indexOf('sendText('))
  })
})
