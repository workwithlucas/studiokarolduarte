// Agent integration tests: LOCAL database with the real rpc_* + stubbed LLM (scripted tool calls) and stubbed
// Z-API/Groq/legacy through an injected fetch. Needs: supabase start. Prints failures and a one-line summary only.
import { createClient } from '@supabase/supabase-js'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { runAgent, HANDOFF_TEXT } from '../supabase/functions/_shared/agent.ts'
import { runConfirmations } from '../supabase/functions/_shared/confirmations.ts'
import { executeTool, type ToolCtx } from '../supabase/functions/_shared/tools.ts'
import { runSweep } from '../supabase/functions/_shared/sweep.ts'
import { addDays, parseInstant, spParts } from '../supabase/functions/_shared/time.ts'
import { getConversation, loadSettings } from '../supabase/functions/_shared/db.ts'
import { handleReceived } from '../supabase/functions/_shared/webhook.ts'
import type { Db, Deps } from '../supabase/functions/_shared/types.ts'

// ---------------------------------------------------------------- environment
function localStatus(): { API_URL: string; SERVICE_ROLE_KEY: string; ANON_KEY: string; DB_URL: string } {
  const r = spawnSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', shell: true })
  const out = r.stdout ?? ''
  try {
    return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  } catch {
    console.log('test:agent FAIL: run `supabase start` first (could not read `supabase status -o json`).')
    process.exit(1)
  }
}
const status = localStatus()
const host = new URL(status.API_URL).hostname
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.log(`test:agent REFUSED: Supabase host is "${host}", not local.`)
  process.exit(1)
}
const client = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const db = client as unknown as Db
const pgc = new pg.Client({ connectionString: status.DB_URL })

const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await pgc.query(sql, params)).rows as T[]

// ---------------------------------------------------------------- tiny harness
let passed = 0
const failures: string[] = []
let scenario = ''
function check(name: string, ok: boolean, extra = '') {
  if (ok) passed++
  else failures.push(`[${scenario}] ${name}${extra ? ` (${extra})` : ''}`)
}

// ---------------------------------------------------------------- stubbed world
type Block = Record<string, any>
interface Ctx {
  req: any
  results: Array<{ name: string; out: any }>
  last: (name: string) => any
}
type Step = (c: Ctx) => Block[]

const world = {
  llmCalls: 0,
  requests: [] as any[],
  sends: [] as Array<{ phone: string; message: string }>,
  legacy: [] as string[],
  logs: [] as string[],
  script: [] as Step[],
  llmDelayMs: 0,
  groq: 'fail' as 'fail' | string,
  reset() {
    this.llmCalls = 0
    this.requests = []
    this.sends = []
    this.legacy = []
    this.logs = []
    this.script = []
    this.llmDelayMs = 0
    this.groq = 'fail'
  },
}
let uid = 0
const tu = (name: string, input: Record<string, unknown> = {}): Block => ({ type: 'tool_use', id: `tu_${++uid}`, name, input })
const text = (t: string): Block => ({ type: 'text', text: t })

function resultsOf(req: any): Array<{ name: string; out: any }> {
  const names = new Map<string, string>()
  const out: Array<{ name: string; out: any }> = []
  for (const m of req.messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === 'tool_use') names.set(b.id, b.name)
      if (b.type === 'tool_result') out.push({ name: names.get(b.tool_use_id) ?? '?', out: JSON.parse(b.content) })
    }
  }
  return out
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let outId = 0

const stubFetch: Deps['fetch'] = async (input, init) => {
  const url = String(input)
  if (url.startsWith('https://api.anthropic.com/')) {
    world.llmCalls++
    const req = JSON.parse(String(init?.body))
    world.requests.push(req)
    if (world.llmDelayMs) await new Promise((r) => setTimeout(r, world.llmDelayMs))
    const step = world.script.shift()
    if (!step) return json({ error: 'script exhausted' }, 500)
    const results = resultsOf(req)
    const content = step({ req, results, last: (n) => [...results].reverse().find((r) => r.name === n)?.out })
    return json({ content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
  }
  if (url.startsWith('https://api.z-api.io/')) {
    const b = JSON.parse(String(init?.body))
    world.sends.push({ phone: b.phone, message: b.message })
    const id = `OUT-${++outId}`
    return json({ zaapId: 'Z', messageId: id, id })
  }
  if (url.startsWith('https://legacy.test/')) {
    world.legacy.push(String(init?.body))
    return json({ ok: true })
  }
  if (url.startsWith('https://media.test/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/ogg' } })
  if (url.startsWith('https://api.groq.com/')) return world.groq === 'fail' ? json({ error: 'x' }, 500) : json({ text: world.groq })
  throw new Error(`unexpected fetch ${url}`)
}

function mkDeps(over: Partial<Deps> = {}): Deps {
  return {
    db,
    fetch: stubFetch,
    now: () => Date.now(),
    sleep: async () => {},
    random: () => 0.5,
    cfg: { anthropicKey: 'test', groqKey: 'test', model: 'test-model', zapi: { instanceId: 'I', token: 'T', clientToken: 'C' }, legacyUrl: 'https://legacy.test/hook' },
    log: (e, d) => world.logs.push(`${e} ${JSON.stringify(d ?? {})}`),
    ...over,
  }
}

// ---------------------------------------------------------------- fixtures
const P = (n: number) => `55119990${String(n).padStart(5, '0')}` // test phones: 5511999000NN
const phones = Array.from({ length: 30 }, (_, i) => P(i + 1))
let maraId = ''
let milenaId = ''
let svcId = ''
let addonId = ''
const today = () => spParts(Date.now()).ymd

async function ensureFixtures() {
  const pros = await q<{ id: string; name: string }>("select id, name from professionals where name in ('Mara','Milena')")
  maraId = pros.find((p) => p.name === 'Mara')!.id
  milenaId = pros.find((p) => p.name === 'Milena')!.id
  const found = await q<{ id: string }>("select id from services where name = 'ZZA Manicure'")
  svcId =
    found[0]?.id ??
    (await q<{ id: string }>("select rpc_upsert_service(null,'ZZA Manicure','unhas','standard',60,8000,50,6000,null,true) as id"))[0]!.id
  const ad = await q<{ id: string }>("select id from service_addons where name = 'ZZA Nail art' and service_id = $1", [svcId])
  addonId = ad[0]?.id ?? (await q<{ id: string }>("select rpc_upsert_addon(null,$1,'ZZA Nail art',1500,15,true) as id", [svcId]))[0]!.id
  for (const p of [maraId, milenaId]) await q('insert into professional_services values ($1,$2) on conflict do nothing', [p, svcId])
  await q("update studio_settings set value = '10' where key = 'debounce_seconds'")
}

async function setSettings(patch: Record<string, unknown>) {
  const base: Record<string, unknown> = {
    agent_mode: 'live', agent_window_start: '00:00', agent_window_end: '23:59', agent_test_numbers: [],
    confirmation_enabled: false, confirmation_hour: '16:00', human_takeover_hours: 3,
  }
  for (const [k, v] of Object.entries({ ...base, ...patch })) {
    await q('insert into studio_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value', [k, JSON.stringify(v)])
  }
}

async function reset() {
  world.reset()
  await q("delete from wa_confirmations where appointment_id in (select a.id from appointments a join clients c on c.id = a.client_id where c.name like 'ZZA %')")
  await q("delete from ledger_entries where client_id in (select id from clients where name like 'ZZA %')")
  await q("delete from appointment_addons where appointment_id in (select a.id from appointments a join clients c on c.id = a.client_id where c.name like 'ZZA %')")
  await q("delete from appointments where client_id in (select id from clients where name like 'ZZA %')")
  await q("delete from wa_conversations where phone_e164 like '5511999000%'")
  await q("delete from client_packages where client_id in (select id from clients where name like 'ZZA %')")
  await q("delete from clients where name like 'ZZA %'")
  await setSettings({})
}

const newClient = async (name: string, phone: string) => (await q<{ id: string }>('select rpc_upsert_client($1,$2,null,null,null) as id', [name, phone]))[0]!.id

async function bookStaff(clientId: string, proId: string, startsAt: string, force = false) {
  return (
    await q<{ id: string }>(
      "select rpc_book_appointment($1::uuid,$2::uuid,$3::uuid,'placement'::service_action,'{}'::uuid[],$4::timestamptz,'staff'::appointment_source,$5,null,null,$6) as id",
      [clientId, proId, svcId, startsAt, `zza-${Math.random()}`, force],
    )
  )[0]!.id
}

/** Slots at least 2h apart, so several bookings by the same professional never overlap. */
function spaced(all: string[], n: number): string[] {
  const out: string[] = []
  for (const s of all) if (!out.length || parseInstant(s)! - parseInstant(out.at(-1)!)! >= 2 * 3600_000) out.push(s)
  return out.slice(0, n)
}

async function slots(proId: string, from = 1, to = 12): Promise<string[]> {
  const { data, error } = await db.rpc('rpc_get_availability', {
    p_professional_id: proId, p_service_id: svcId, p_action: 'placement', p_addon_ids: [], p_from: addDays(today(), from), p_to: addDays(today(), to), p_source: 'agent',
  })
  if (error) throw new Error(error.message)
  return (data as Array<{ starts_at: string }>).map((r) => r.starts_at)
}

async function invariants(): Promise<number> {
  const { data, error } = await db.rpc('check_invariants')
  if (error) throw new Error(error.message)
  return (data as unknown[]).length
}

// ---------------------------------------------------------------- driving conversations
let inId = 0
const zapiText = (phone: string, body: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ instanceId: 'I', messageId: `IN-${++inId}`, phone, fromMe: false, momment: Date.now(), status: 'RECEIVED', isGroup: false, isNewsletter: false, broadcast: false, waitingMessage: false, isEdit: false, type: 'ReceivedCallback', text: { message: body }, ...over })

let lastOutcome: Awaited<ReturnType<typeof runAgent>> | null = null
async function say(phone: string, body: string, deps = mkDeps(), over: Record<string, unknown> = {}) {
  lastOutcome = null
  const raw = zapiText(phone, body, over)
  const res = await handleReceived(deps, raw, async (cid) => {
    lastOutcome = await runAgent(deps, cid)
  })
  return { res, outcome: lastOutcome as Awaited<ReturnType<typeof runAgent>> | null, raw }
}
const convOf = async (phone: string) => (await q<any>('select * from wa_conversations where phone_e164 = $1', [phone]))[0]
const sentTo = (phone: string) => world.sends.filter((s) => s.phone === phone)
const apptsOf = (clientId: string) => q<any>('select * from appointments where client_id = $1 order by starts_at', [clientId])

// ---------------------------------------------------------------- scenarios
const scenarios: Array<[string, () => Promise<void>]> = []
const sc = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn])

sc('1 new client books', async () => {
  const phone = P(1)
  const pick = (c: Ctx) => c.last('get_availability').days[0].slots[0].starts_at as string
  const clientOf = (c: Ctx) => c.last('register_client').client_id as string
  world.script = [
    () => [tu('lookup_client')],
    () => [tu('register_client', { name: 'ZZA Ana Nova' })],
    () => [tu('list_services')],
    () => [tu('suggest_professionals', { service_id: svcId })],
    () => [tu('get_availability', { professional_id: maraId, service_id: svcId, action: 'placement', addon_ids: [addonId], from_date: addDays(today(), 1), to_date: addDays(today(), 10) })],
    (c) => [tu('propose_booking', { client_id: clientOf(c), professional_id: maraId, service_id: svcId, action: 'placement', addon_ids: [addonId], starts_at: pick(c) })],
    () => [text('Fica assim: manicure, com a Mara. Posso confirmar?')],
  ]
  const r1 = await say(phone, 'Oi, quero fazer as unhas')
  check('run 1 sent', r1.outcome?.status === 'sent', String(r1.outcome?.status))
  const c1 = await convOf(phone)
  check('pending stored and presented', c1.pending_action?.type === 'book' && !!c1.pending_action.presented_baseline)
  check('no appointment before the client says yes', (await q('select 1 from appointments a join clients c on c.id=a.client_id where c.name like $1', ['ZZA Ana%'])).length === 0)
  world.script = [() => [tu('confirm_pending')], () => [text('Pronto! Te espero. Se precisar remarcar é só me falar.')]]
  const r2 = await say(phone, 'sim')
  check('run 2 sent', r2.outcome?.status === 'sent', String(r2.outcome?.status))
  const appts = await q<any>("select a.*, (select count(*) from ledger_entries l where l.appointment_id=a.id and l.voided_at is null)::int as live from appointments a join clients c on c.id=a.client_id where c.name like 'ZZA Ana%'")
  check('one appointment booked by the agent', appts.length === 1 && appts[0].source === 'agent' && appts[0].price_cents === 9500 && appts[0].duration_min === 75, JSON.stringify(appts.map((a) => [a.source, a.price_cents, a.duration_min])))
  check('exactly one live ledger entry', appts[0]?.live === 1)
  check('pending cleared', (await convOf(phone)).pending_action === null)
  check('client is known to the conversation', (await convOf(phone)).known_client_ids.length === 1)
  check('agent audit entry', (await q("select 1 from audit_log where actor_type='agent' and action='book_appointment'")).length > 0)
})

sc('2 known client, habitual professional', async () => {
  const phone = P(2)
  const cid = await newClient('ZZA Bia Habitual', phone)
  const past = ['2026-08-03T13:00:00Z', '2026-08-17T13:00:00Z']
  for (const s of past) {
    const id = await bookStaff(cid, milenaId, s, true)
    await q('select rpc_complete_appointment($1)', [id])
  }
  world.script = [
    () => [tu('lookup_client')],
    (c) => {
      const l = c.last('lookup_client')
      check('single candidate is selected', l.candidates.length === 1 && l.current_client_id === cid)
      check('habitual professional in context', l.context.habitual_professional?.name === 'Milena')
      check('no money in the client context', !/spent|total_spent|cents_spent/i.test(JSON.stringify(l.context)))
      return [tu('suggest_professionals', { service_id: svcId })]
    },
    (c) => {
      const s = c.last('suggest_professionals').professionals
      check('suggestion puts the habitual professional first', s[0].name === 'Milena' && s[0].habitual === true)
      return [text('Oi, Bia! Quer com a Milena, como das outras vezes?')]
    },
  ]
  const r = await say(phone, 'oi, quero marcar manicure')
  check('sent', r.outcome?.status === 'sent')
  check('offers the habitual professional', sentTo(phone)[0]?.message.includes('Milena') === true)
  const c = await convOf(phone)
  check('client selected and known', c.client_id === cid && c.known_client_ids.includes(cid))
})

sc('3 three rapid messages produce one reply', async () => {
  const phone = P(3)
  world.script = [() => [text('Oi! Qual serviço você quer?')]]
  const deps = mkDeps({ sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1500))) })
  const results = await Promise.all(
    ['oi', 'tudo bem?', 'quero unhas'].map(async (t, i) => {
      await new Promise((r) => setTimeout(r, i * 150))
      return say(phone, t, deps)
    }),
  )
  const actions = results.map((r) => r.res.action).sort()
  check('one run, two superseded', actions.join() === 'run,superseded,superseded', actions.join())
  check('one LLM call', world.llmCalls === 1, String(world.llmCalls))
  check('one reply', sentTo(phone).length === 1)
  const last = world.requests[0].messages.at(-1)
  check('the three messages arrive as one user turn', last.role === 'user' && ['oi', 'tudo bem?', 'quero unhas'].every((t) => String(last.content).includes(t)), JSON.stringify(last))
})

sc('4 two concurrent runs produce one reply', async () => {
  const phone = P(4)
  world.llmDelayMs = 400
  world.script = [() => [text('Oi! Como posso ajudar?')], () => [text('Duplicada!')]]
  const deps = mkDeps()
  const ing = await q<any>('select * from agent_ingest_inbound($1,$2,$3,$4)', [phone, 'CONC-1', 'text', 'oi'])
  const [a, b] = await Promise.all([runAgent(deps, ing[0].conversation_id), runAgent(deps, ing[0].conversation_id)])
  const st = [a.status, b.status].sort()
  check('one sent, one not claimed', st.join() === 'not_claimed,sent', st.join())
  check('one reply only', sentTo(phone).length === 1)
  check('lease released', (await convOf(phone)).lease_until === null)
})

sc('5 reschedule keeps the same ledger entry', async () => {
  const phone = P(5)
  const cid = await newClient('ZZA Rita Remarca', phone)
  const [s1, s2] = await slots(maraId)
  const apptId = await bookStaff(cid, maraId, s1!)
  const before = await q<any>('select id, due_date from ledger_entries where appointment_id=$1 and voided_at is null', [apptId])
  const target = (await slots(maraId, 1, 12)).find((s) => s !== s1 && s !== s2) ?? s2!
  world.script = [
    () => [tu('lookup_client')],
    () => [tu('list_my_appointments')],
    () => [tu('propose_reschedule', { appointment_id: apptId, new_starts_at: target })],
    () => [text('Posso remarcar para o novo horário?')],
  ]
  await say(phone, 'preciso remarcar')
  world.script = [() => [tu('confirm_pending')], () => [text('Remarcado! Se precisar mudar é só me falar.')]]
  const r = await say(phone, 'pode ser')
  check('reply sent', r.outcome?.status === 'sent')
  const [a] = await apptsOf(cid)
  check('appointment moved', parseInstant(a.starts_at.toISOString()) === parseInstant(target), `${a.starts_at.toISOString()} vs ${target}`)
  const after = await q<any>('select id, due_date from ledger_entries where appointment_id=$1 and voided_at is null', [apptId])
  check('same ledger entry (no new one)', after.length === 1 && after[0].id === before[0].id)
  const all = await q<any>('select 1 from ledger_entries where appointment_id=$1', [apptId])
  check('no extra ledger rows created', all.length === 1)
})

sc('6 cancel voids the ledger entry', async () => {
  const phone = P(6)
  const cid = await newClient('ZZA Cida Cancela', phone)
  const apptId = await bookStaff(cid, maraId, (await slots(maraId))[0]!)
  world.script = [() => [tu('lookup_client')], () => [tu('propose_cancel', { appointment_id: apptId })], () => [text('Quer mesmo cancelar?')]]
  await say(phone, 'quero cancelar')
  world.script = [() => [tu('confirm_pending')], () => [text('Cancelado. Quando quiser é só chamar.')]]
  await say(phone, 'sim')
  const [a] = await apptsOf(cid)
  check('appointment cancelled with reason', a.status === 'cancelled' && a.cancel_reason === 'Cliente cancelou pelo WhatsApp', a.status)
  const l = await q<any>('select voided_at from ledger_entries where appointment_id=$1', [apptId])
  check('ledger entry voided', l.length === 1 && l[0].voided_at !== null)
})

sc('7 cancel of another client appointment is refused', async () => {
  const phone = P(7)
  const mine = await newClient('ZZA Minha Cliente', phone)
  const other = await newClient('ZZA Outra Pessoa', P(8))
  const [s1, s2] = spaced(await slots(maraId), 2)
  const theirs = await bookStaff(other, maraId, s1!)
  await bookStaff(mine, maraId, s2!)
  world.script = [
    () => [tu('lookup_client')],
    () => [tu('propose_cancel', { appointment_id: theirs })],
    (c) => {
      check('propose_cancel refused', c.last('propose_cancel').ok === false && c.last('propose_cancel').error === 'NOT_FOUND', JSON.stringify(c.last('propose_cancel')))
      return [text('Não achei esse horário. Quer ver os seus?')]
    },
  ]
  await say(phone, 'cancela o horário da minha amiga')
  // An attacker-crafted pending action is stopped at confirm time as well.
  const cv = await convOf(phone)
  const base = (await q<any>("select created_at from wa_messages where conversation_id=$1 and direction='in' order by created_at desc limit 1", [cv.id]))[0].created_at.toISOString()
  await q('update wa_conversations set pending_action = $2::jsonb where id = $1', [cv.id, JSON.stringify({ type: 'cancel', params: { appointment_id: theirs }, summary: {}, proposed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(), presented_baseline: base })])
  world.script = [() => [tu('confirm_pending')], (c) => {
    check('confirm_pending refused for foreign appointment', c.last('confirm_pending').ok === false && c.last('confirm_pending').error === 'NOT_FOUND', JSON.stringify(c.last('confirm_pending')))
    return [text('Não consegui achar esse horário.')]
  }]
  await say(phone, 'sim')
  check("other client's appointment untouched", (await apptsOf(other))[0].status === 'scheduled')
  check('pending cleared after the refusal', (await convOf(phone)).pending_action === null)
})

sc('8 shared phone: choose_client and register_client', async () => {
  const phone = P(9)
  const mae = await newClient('ZZA Marta Mae', phone)
  const filha = await newClient('ZZA Julia Filha', phone)
  const [s1] = await slots(maraId)
  world.script = [
    () => [tu('lookup_client')],
    (c) => {
      check('two candidates, none selected', c.last('lookup_client').candidates.length === 2 && c.last('lookup_client').current_client_id === null)
      return [tu('choose_client', { client_id: filha })]
    },
    () => [tu('register_client', { name: 'ZZA Prima Nova' })],
    () => [tu('propose_booking', { client_id: mae, professional_id: maraId, service_id: svcId, action: 'placement', addon_ids: [], starts_at: s1 })],
    (c) => {
      check('a client not chosen is refused', c.last('propose_booking').ok === false && c.last('propose_booking').error === 'NOT_ALLOWED', JSON.stringify(c.last('propose_booking')))
      return [tu('choose_client', { client_id: '00000000-0000-4000-8000-000000000000' })]
    },
    (c) => {
      check('a stranger id is refused', c.last('choose_client').error === 'NOT_A_CANDIDATE')
      return [text('Certo! Para quem é o horário?')]
    },
  ]
  await say(phone, 'oi, é pra minha filha')
  const cv = await convOf(phone)
  const prima = (await q<any>("select id, phone_e164 from clients where name = 'ZZA Prima Nova'"))[0]
  check('relative registered on the same phone as a new client', prima?.phone_e164 === phone && prima.id !== mae && prima.id !== filha)
  check('known set has chosen + registered, not the mother', cv.known_client_ids.includes(filha) && cv.known_client_ids.includes(prima.id) && !cv.known_client_ids.includes(mae))
  check('current client is the registered one', cv.client_id === prima.id)
})

sc('9 send-confirmations, then "sim" confirms', async () => {
  const phone = P(10)
  const cid = await newClient('ZZA Nina Confirma', phone)
  const fake = parseInstant(`${today()}T17:00:00`)!
  const tomorrow = addDays(today(), 1)
  const apptId = await bookStaff(cid, maraId, `${tomorrow}T10:00:00-03:00`, true)
  await q("update appointments set created_at = $2::timestamptz where id = $1", [apptId, new Date(fake - 5 * 3600_000).toISOString()])
  await setSettings({ confirmation_enabled: true, confirmation_hour: '16:00' })
  const deps = mkDeps({ now: () => fake })
  const r1 = await runConfirmations(deps)
  check('one confirmation sent', r1.sent === 1 && sentTo(phone).length === 1, JSON.stringify(r1))
  check('message asks to confirm', sentTo(phone)[0]?.message.includes('Posso confirmar?') === true)
  check('confirmation row + outbound message', (await q('select 1 from wa_confirmations where appointment_id=$1', [apptId])).length === 1 && (await q("select 1 from wa_messages m join wa_conversations c on c.id=m.conversation_id where c.phone_e164=$1 and m.purpose='confirmation'", [phone])).length === 1)
  const r2 = await runConfirmations(deps)
  check('idempotent: nothing sent the second time', r2.sent === 0 && sentTo(phone).length === 1, JSON.stringify(r2))
  world.script = [
    () => [tu('lookup_client')],
    (c) => {
      check('dynamic block lists the appointment awaiting confirmation', JSON.stringify(c.req.system).includes(apptId))
      return [tu('confirm_attendance', { appointment_id: apptId })]
    },
    () => [text('Confirmado! Te esperamos.')],
  ]
  await say(phone, 'sim')
  check('appointment confirmed', (await apptsOf(cid))[0].status === 'confirmed')
  // an appointment that is not awaiting confirmation cannot be confirmed by the model
  const other = await newClient('ZZA Nina Outra', P(11))
  const otherAppt = await bookStaff(other, maraId, (await slots(maraId, 2, 14))[0]!)
  world.script = [() => [tu('lookup_client')], () => [tu('confirm_attendance', { appointment_id: otherAppt })], (c) => {
    check('confirm_attendance refused outside wa_confirmations', c.last('confirm_attendance').error === 'NOT_ALLOWED')
    return [text('Ok!')]
  }]
  await say(phone, 'confirma o outro também')
})

sc('10 outside the window: away message once per 12h, no LLM', async () => {
  const phone = P(12)
  await setSettings({ agent_window_start: '12:00', agent_window_end: '13:00' })
  const at = (hhmm: string) => parseInstant(`${today()}T${hhmm}:00`)!
  const r1 = await say(phone, 'oi', mkDeps({ now: () => at('03:00') }))
  check('away sent', r1.outcome?.status === 'away' && sentTo(phone).length === 1)
  const r2 = await say(phone, 'alguém aí?', mkDeps({ now: () => at('08:00') }))
  check('not repeated within 12h', r2.outcome?.status === 'skipped' && sentTo(phone).length === 1, String(r2.outcome?.status))
  const r3 = await say(phone, 'oi??', mkDeps({ now: () => at('16:00') }))
  check('sent again after 12h', r3.outcome?.status === 'away' && sentTo(phone).length === 2, String(r3.outcome?.status))
  check('no LLM call', world.llmCalls === 0)
  check('messages left pending', (await convOf(phone)).pending_since !== null)
  check('away message text is the configured one', sentTo(phone)[0]!.message.startsWith('Oi! Recebi sua mensagem'))
})

sc('11 fromMe message pauses the agent', async () => {
  const phone = P(13)
  world.script = [() => [text('Oi! Como posso ajudar?')]]
  await say(phone, 'oi')
  const ourId = (await q<any>("select external_id from wa_messages m join wa_conversations c on c.id=m.conversation_id where c.phone_e164=$1 and direction='out'", [phone]))[0].external_id
  const deps = mkDeps()
  const echo = await handleReceived(deps, zapiText(phone, 'Oi! Como posso ajudar?', { fromMe: true, messageId: ourId }), async () => {})
  check('an id we sent is ignored', echo.action === 'ignored' && (await convOf(phone)).mode === 'agent', echo.action)
  const viaApi = await handleReceived(deps, zapiText(phone, 'x', { fromMe: true, fromApi: true, messageId: 'API-1' }), async () => {})
  check('fromApi is ignored', viaApi.action === 'ignored')
  const human = await handleReceived(deps, zapiText(phone, 'Oi, aqui é a Karol!', { fromMe: true, messageId: 'HUMAN-1' }), async () => {})
  const c = await convOf(phone)
  const hours = (new Date(c.human_until).getTime() - Date.now()) / 3600_000
  check('human takeover', human.action === 'human' && c.mode === 'human' && hours > 2.9 && hours <= 3.01, `${human.action} ${c.mode} ${hours}`)
  check('human message stored', (await q("select 1 from wa_messages where external_id='HUMAN-1' and from_human")).length === 1)
  world.script = [() => [text('não deveria responder')]]
  const r = await say(phone, 'obrigada')
  check('agent stays silent in human mode', r.outcome?.status === 'skipped' && world.llmCalls === 1, String(r.outcome?.status))
  await q("update wa_conversations set human_until = now() - interval '1 minute' where phone_e164 = $1", [phone])
  const sw = await runSweep(deps, async () => {})
  check('sweep returns the conversation to the agent', sw.returned >= 1 && (await convOf(phone)).mode === 'agent')
})

sc('12 test mode forwards non-whitelisted payloads to the legacy url', async () => {
  const mine = P(14)
  const stranger = P(15)
  await setSettings({ agent_mode: 'test', agent_test_numbers: [mine] })
  const s = await say(stranger, 'quero horário', mkDeps())
  check('forwarded', s.res.action === 'forwarded' && world.legacy.length === 1)
  check('raw body forwarded untouched', world.legacy[0] === s.raw)
  check('no LLM, no reply for the stranger', world.llmCalls === 0 && sentTo(stranger).length === 0)
  world.script = [() => [text('Oi! Aqui é a Thaís.')]]
  const m = await say(mine, 'oi', mkDeps())
  check('whitelisted phone is handled by the agent', m.outcome?.status === 'sent' && world.legacy.length === 1)
  const sw = await runSweep(mkDeps(), async (id) => { throw new Error(`sweep must not invoke ${id}`) })
  check('sweep skips non-whitelisted conversation', sw.invoked === 0)
})

sc('13 audio failure path', async () => {
  const phone = P(16)
  const audio = (id: string) => ({ messageId: id, text: undefined, audio: { ptt: true, seconds: 5, audioUrl: 'https://media.test/a.ogg', mimeType: 'audio/ogg; codecs=opus' } })
  world.script = [(c) => {
    check('model gets the neutral placeholder', JSON.stringify(c.req.messages).includes('[mensagem de voz sem transcrição]'))
    check('dynamic block asks to repeat without naming limitations', JSON.stringify(c.req.system).includes('AVISO'))
    return [text('Não consegui entender direito. Pode repetir?')]
  }]
  const a1 = await say(phone, '', mkDeps(), audio('AUD-1'))
  check('first failure: agent asks to repeat', a1.outcome?.status === 'sent' && (await convOf(phone)).audio_failures === 1, String(a1.outcome?.status))
  const a2 = await say(phone, '', mkDeps(), audio('AUD-2'))
  const c = await convOf(phone)
  check('two consecutive failures: handoff without LLM', a2.outcome?.status === 'handoff' && c.mode === 'human' && c.needs_attention && world.llmCalls === 1, String(a2.outcome?.status))
  check('handoff message sent', sentTo(phone).at(-1)?.message === HANDOFF_TEXT)
  const ok = P(17)
  world.groq = 'quero marcar unha na quinta'
  world.script = [() => [text('Claro! Qual serviço?')]]
  await say(ok, '', mkDeps(), audio('AUD-3'))
  const body = (await q<any>("select body from wa_messages where external_id='AUD-3'"))[0].body
  check('transcript stored as the message body', body === 'quero marcar unha na quinta')
})

sc('14 mode off: no LLM call', async () => {
  const phone = P(18)
  await setSettings({ agent_mode: 'off' })
  const r = await say(phone, 'oi')
  check('stopped after ingest', r.res.action === 'stopped')
  const direct = await runAgent(mkDeps(), (await convOf(phone)).id)
  check('direct run skipped', direct.status === 'skipped' && world.llmCalls === 0 && world.sends.length === 0)
  check('message was still stored', (await q('select 1 from wa_messages where external_id like $1', ['IN-%'])).length >= 1)
})

sc('15 SLOT_TAKEN recovery', async () => {
  const phone = P(19)
  const cid = await newClient('ZZA Sara Slot', phone)
  const rival = await newClient('ZZA Rival', P(20))
  const [s1, s2, s3] = await slots(maraId)
  const propose = (start: string, cidv = cid) => tu('propose_booking', { client_id: cidv, professional_id: maraId, service_id: svcId, action: 'placement', addon_ids: [], starts_at: start })
  world.script = [() => [tu('lookup_client')], () => [propose(s1!)], () => [text('Posso confirmar o primeiro horário?')]]
  await say(phone, 'quero manicure')
  await bookStaff(rival, maraId, s1!) // someone takes the slot meanwhile
  world.script = [
    () => [tu('confirm_pending')],
    (c) => {
      check('SLOT_TAKEN returned as a structured error', c.last('confirm_pending').ok === false && c.last('confirm_pending').error === 'SLOT_TAKEN', JSON.stringify(c.last('confirm_pending')))
      return [tu('get_availability', { professional_id: maraId, service_id: svcId, action: 'placement', from_date: addDays(today(), 1), to_date: addDays(today(), 10) })]
    },
    (c) => {
      const flat = c.last('get_availability').days.flatMap((d: any) => d.slots.map((x: any) => x.starts_at))
      check('taken slot no longer offered', !flat.includes(s1))
      return [propose(flat.find((x: string) => x === s2 || x === s3) ?? flat[0])]
    },
    () => [text('Esse horário acabou de ser ocupado. Que tal este outro?')],
  ]
  await say(phone, 'sim')
  world.script = [() => [tu('confirm_pending')], () => [text('Pronto! Se precisar remarcar é só me falar.')]]
  await say(phone, 'pode')
  const a = await apptsOf(cid)
  check('booked at the new slot', a.length === 1 && a[0].status === 'scheduled' && a[0].starts_at.toISOString() !== new Date(s1!).toISOString())
})

sc('16 confirm_pending without a client reply is refused', async () => {
  const phone = P(21)
  const cid = await newClient('ZZA Paula Pendente', phone)
  const [s1] = await slots(maraId)
  world.script = [
    () => [tu('lookup_client')],
    () => [tu('propose_booking', { client_id: cid, professional_id: maraId, service_id: svcId, action: 'placement', addon_ids: [], starts_at: s1 })],
    () => [tu('confirm_pending')],
    (c) => {
      check('same-run confirm refused (summary not presented)', c.last('confirm_pending').error === 'NOT_PRESENTED', JSON.stringify(c.last('confirm_pending')))
      return [text('Fica assim, posso confirmar?')]
    },
  ]
  await say(phone, 'quero manicure')
  check('nothing booked', (await apptsOf(cid)).length === 0)
  // presented, but the client has not answered since
  const cv = await getConversation(db, (await convOf(phone)).id)
  const lastIn = (await q<any>("select created_at from wa_messages where conversation_id=$1 and direction='in' order by created_at desc limit 1", [cv!.id]))[0].created_at.toISOString()
  const ctx = (snapshot: string | null): ToolCtx => ({ deps: mkDeps(), conv: cv!, settings: undefined as never, snapshotLastInboundAt: snapshot, flags: { handoff: false, noted: false, booked: false } })
  const noReply = await executeTool(ctx(lastIn), 'confirm_pending', {})
  check('no reply after the summary: refused', noReply.error === 'NO_CLIENT_REPLY', JSON.stringify(noReply))
  cv!.pending_action = { ...cv!.pending_action!, expires_at: new Date(Date.now() - 1000).toISOString() }
  const expired = await executeTool(ctx(new Date(Date.now() + 5000).toISOString()), 'confirm_pending', {})
  check('expired proposal refused', expired.error === 'EXPIRED', JSON.stringify(expired))
  check('still nothing booked', (await apptsOf(cid)).length === 0)
})

sc('17 tool loop limit and 3 failed runs', async () => {
  const phone = P(22)
  world.script = Array.from({ length: 10 }, () => () => [tu('list_services')])
  const r = await say(phone, 'oi')
  check('loop stops after 6 tool rounds plus one closing call, run fails', r.outcome?.status === 'failed' && world.llmCalls === 7, `${r.outcome?.status} ${world.llmCalls}`)
  check('no message to the client on failure', sentTo(phone).length === 0)
  check('failed_runs incremented and lease released', (await convOf(phone)).failed_runs === 1 && (await convOf(phone)).lease_until === null)
  await q('update wa_conversations set failed_runs = 3, last_inbound_at = now() - interval \'5 minutes\' where phone_e164 = $1', [phone])
  const sw = await runSweep(mkDeps(), async (id) => { throw new Error(`sweep must stop retrying ${id}`) })
  const c = await convOf(phone)
  check('sweep flags "Erro do agente" and stops retrying', sw.flagged >= 1 && c.needs_attention && c.attention_reason === 'Erro do agente' && sw.invoked === 0, JSON.stringify(sw))
})

sc('18 owner RPCs: only the owner, settings validated', async () => {
  const { error: e1 } = await client.rpc('rpc_agent_overview')
  check('service_role is not the owner', e1?.message === 'FORBIDDEN', e1?.message)
  const ok = (await q<any>('select rpc_agent_overview() as o'))[0].o // direct connection = system, allowed
  check('overview shape', Array.isArray(ok.attention) && Array.isArray(ok.actions) && ok.settings.agent_mode)
  let bad = ''
  try { await q("select rpc_agent_set_settings('{\"agent_mode\":\"yolo\"}')") } catch (e) { bad = String((e as Error).message) }
  check('invalid mode rejected', bad === 'INVALID_SETTING', bad)
  try { bad = ''; await q("select rpc_agent_set_settings('{\"nope\":1}')") } catch (e) { bad = String((e as Error).message) }
  check('unknown key rejected', bad === 'INVALID_SETTING', bad)
  await q("select rpc_agent_set_settings('{\"agent_test_numbers\":[\"(11) 98765-4321\",\"11987654321\"]}')")
  check('numbers normalized and deduped', JSON.stringify((await loadSettings(db)).agent_test_numbers) === '["5511987654321"]')
  const anon = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false } })
  const { error: e2 } = await anon.rpc('agent_purge_old')
  check('anon cannot call service-only functions', !!e2, 'no error')
  const { error: e3 } = await anon.rpc('rpc_agent_overview')
  check('anon cannot call owner rpcs', !!e3, 'no error')
})

// ---------------------------------------------------------------- run
async function main() {
  await pgc.connect()
  await ensureFixtures()
  for (const [name, fn] of scenarios) {
    scenario = name
    try {
      await reset()
      const before = failures.length
      await fn()
      if (failures.length > before && world.logs.length) failures.push(`[${name}] logs: ${world.logs.slice(0, 4).join(" ; ")}`)
      const bad = await invariants()
      check('check_invariants() = 0 rows', bad === 0, String(bad))
    } catch (e) {
      failures.push(`[${name}] threw: ${e instanceof Error ? e.message : String(e)}${world.logs.length ? ` | logs: ${world.logs.slice(0, 3).join(' ; ')}` : ''}`)
    }
  }
  scenario = 'cleanup'
  await reset()
  await q("update studio_settings set value = '\"off\"' where key = 'agent_mode'")
  await pgc.end()
  if (failures.length) console.log(failures.join('\n'))
  console.log(`test:agent ${failures.length ? 'FAIL' : 'PASS'} (${passed} checks, ${failures.length} failed, ${scenarios.length} scenarios)`)
  process.exit(failures.length ? 1 : 0)
}
void main()
void phones
