// Finance assistant integration tests: LOCAL database with the real rpc_* + stubbed LLM (scripted tool calls).
// Users sign in with real local JWTs (owner and professional). Needs: supabase start. Prints failures and a one-line summary only.
import { createClient } from '@supabase/supabase-js'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { handleAssistant, type AssistantRuntime } from '../supabase/functions/_shared/assistant.ts'
import type { Card, ChoiceCard, MessageView, PendingView } from '../supabase/functions/_shared/assistant-types.ts'
import { GUARD_FALLBACK } from '../supabase/functions/_shared/assistant-validate.ts'
import type { Db } from '../supabase/functions/_shared/types.ts'

const DEV_PASSWORD = 'studio-dev-123' // local demo password set by scripts/dev-users.ts

// ---------------------------------------------------------------- environment
function localStatus(): { API_URL: string; SERVICE_ROLE_KEY: string; ANON_KEY: string; DB_URL: string } {
  const r = spawnSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', shell: true })
  const out = r.stdout ?? ''
  try {
    return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  } catch {
    console.log('test:assistant FAIL: run `supabase start` first (could not read `supabase status -o json`).')
    process.exit(1)
  }
}
const status = localStatus()
const host = new URL(status.API_URL).hostname
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.log(`test:assistant REFUSED: Supabase host is "${host}", not local.`)
  process.exit(1)
}
const svc = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } })
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

// ---------------------------------------------------------------- stubbed LLM
type Block = Record<string, any>
interface Ctx {
  req: any
  last: (name: string) => any
}
type Step = (c: Ctx) => Block[]
const world = {
  llmCalls: 0,
  requests: [] as any[],
  script: [] as Step[],
  reset() {
    this.llmCalls = 0
    this.requests = []
    this.script = []
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

const jres = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const stubFetch: AssistantRuntime['fetch'] = async (input, init) => {
  const url = String(input)
  if (!url.startsWith('https://api.anthropic.com/')) throw new Error(`unexpected fetch ${url}`)
  world.llmCalls++
  const req = JSON.parse(String(init?.body))
  world.requests.push(req)
  const step = world.script.shift()
  if (!step) return jres({ error: 'script exhausted' }, 500)
  const results = resultsOf(req)
  const content = step({ req, last: (n) => [...results].reverse().find((r) => r.name === n)?.out })
  return jres({ content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
}

// ---------------------------------------------------------------- runtime with real JWTs
async function login(email: string): Promise<string> {
  const anon = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password: DEV_PASSWORD })
  if (error || !data.session) throw new Error(`login ${email}: ${error?.message}`)
  return data.session.access_token
}

const runtime = (over: Partial<AssistantRuntime> = {}): AssistantRuntime => ({
  svc: svc as unknown as Db,
  authenticate: async (jwt) => {
    const { data, error } = await svc.auth.getUser(jwt)
    return error || !data.user ? null : { id: data.user.id }
  },
  userDb: (jwt) =>
    createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } }) as unknown as Db,
  fetch: stubFetch,
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
  cfg: { anthropicKey: 'test', model: 'test-model' },
  log: () => {},
  ...over,
})

let ownerJwt = ''
let proJwt = ''
let ownerId = ''

interface Res {
  status: number
  body: any
  messages: MessageView[]
  pendings: PendingView[]
}
async function call(body: Record<string, unknown>, jwt: string | null = ownerJwt, rt = runtime()): Promise<Res> {
  const r = await handleAssistant(rt, jwt, { request_id: crypto.randomUUID(), ...body })
  const b = r.body as any
  if (process.env.DEBUG) console.log(JSON.stringify(b.messages?.map((m: any) => m.body ?? m.card) ?? b))
  return { status: r.status, body: b, messages: b.messages ?? [], pendings: b.pendings ?? [] }
}
const say = (t: string, extra: Record<string, unknown> = {}) => call({ action: 'message', text: t, ...extra })
const confirm = (id: string, extra: Record<string, unknown> = {}) => call({ action: 'confirm', pending_id: id, ...extra })
const cancel = (id: string) => call({ action: 'cancel', pending_id: id })
const undo = (id: string, idx?: number) => call({ action: 'undo', pending_id: id, ...(idx === undefined ? {} : { action_index: idx }) })

const cardOf = <K extends Card['kind']>(r: Res, kind: K): Extract<Card, { kind: K }> | undefined =>
  r.messages.map((m) => m.card).find((c): c is Extract<Card, { kind: K }> => c?.kind === kind)
const textOf = (r: Res) => r.messages.filter((m) => m.role === 'assistant').map((m) => m.body).join(' ')
const proposalOf = (r: Res) => cardOf(r, 'proposal')
const flat = (c: { lines: Array<{ label: string; value: string }> } | undefined) => (c?.lines ?? []).map((l) => `${l.label}: ${l.value}`).join(' | ')

// ---------------------------------------------------------------- fixtures
let maraId = ''
let svcId = ''
let tplId = ''

async function ensureFixtures() {
  spawnSync('npx', ['tsx', 'scripts/dev-users.ts'], { shell: true, stdio: 'ignore' })
  ownerJwt = await login('karol@studio.test')
  proJwt = await login('mara@studio.test')
  ownerId = (await q<{ user_id: string }>("select user_id from professionals where name = 'Karol Duarte'"))[0]!.user_id
  maraId = (await q<{ id: string }>("select id from professionals where name = 'Mara'"))[0]!.id
  const found = await q<{ id: string }>("select id from services where name = 'ZZS Servico'")
  svcId = found[0]?.id ?? (await q<{ id: string }>("select rpc_upsert_service(null,'ZZS Servico','unhas','standard',60,8000,null,null,null,true) as id"))[0]!.id
  await q('insert into professional_services values ($1,$2) on conflict do nothing', [maraId, svcId])
  const t = await q<{ id: string }>("select id from package_templates where name = 'ZZS Pacote x3'")
  tplId = t[0]?.id ?? (await q<{ id: string }>("select rpc_upsert_package_template(null,'ZZS Pacote x3',$1,3,30,18000,true) as id", [svcId]))[0]!.id
}

async function reset() {
  world.reset()
  await q('delete from assistant_messages')
  await q('delete from assistant_pending')
  const clients = "select id from clients where name like 'ZZS %'"
  const entries = `select id from ledger_entries where description like 'ZZS%' or description like 'novo ZZS%' or import_key like 'assist-%' or client_id in (${clients})`
  await q(`delete from ledger_payments where entry_id in (${entries})`)
  await q(`delete from account_settlements where client_id in (${clients})`)
  await q(`delete from ledger_entries where id in (${entries})`)
  await q(`delete from appointment_addons where appointment_id in (select id from appointments where client_id in (${clients}))`)
  await q(`delete from appointments where client_id in (${clients})`)
  await q(`delete from client_packages where client_id in (${clients})`)
  await q("delete from clients where name like 'ZZS %'")
  await q("insert into studio_settings (key, value) values ('assistant_enabled', 'true') on conflict (key) do update set value = 'true'")
}

const newClient = async (name: string, n: number) => (await q<{ id: string }>('select rpc_upsert_client($1,$2,null,null,null) as id', [name, `1198880${String(n).padStart(4, '0')}`]))[0]!.id
let apptSeq = 0
/** Appointment today at hh:mm (force-booked so hours and notice never get in the way). */
async function bookToday(clientId: string, hhmm: string, pkgId: string | null = null): Promise<string> {
  return (
    await q<{ id: string }>(
      "select rpc_book_appointment($1::uuid,$2::uuid,$3::uuid,'placement'::service_action,'{}'::uuid[],((today_sp() + $4::time) at time zone 'America/Sao_Paulo'),'staff'::appointment_source,$5,null,$6::uuid,true) as id",
      [clientId, maraId, svcId, hhmm, `zzs-${++apptSeq}-${Math.random()}`, pkgId],
    )
  )[0]!.id
}
const entryOfAppt = async (apptId: string) => (await q<any>('select * from v_ledger where appointment_id = $1 and voided_at is null', [apptId]))[0]
const paymentsOf = (entryId: string) => q<any>('select * from ledger_payments where entry_id = $1 order by created_at, id', [entryId])
const manualEntry = async (desc: string, cents: number, kind = 'expense') =>
  (await q<{ id: string }>("select rpc_create_manual_entry($1::entry_kind,$2,'Outros',$3,today_sp(),null,null,false,null,null) as id", [kind, desc, cents]))[0]!.id
const pendingRow = async (id: string) => (await q<any>('select * from assistant_pending where id = $1', [id]))[0]
const entriesLike = (like: string) => q<any>('select * from v_ledger where description like $1 and voided_at is null order by created_at', [like])

async function invariants(): Promise<number> {
  const { data, error } = await svc.rpc('check_invariants')
  if (error) throw new Error(error.message)
  return (data as unknown[]).length
}

const scenarios: Array<[string, () => Promise<void>]> = []
const sc = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn])
const fund = (c: Ctx, tool: string) => c.last(tool)

// ---------------------------------------------------------------- scenarios
sc('1 expense paid: proposal, confirm, entry paid, request shape', async () => {
  world.script = [
    () => [tu('propose_expense', { payee: 'ZZS Zé', reason: 'gás', amount_cents: 2000, paid: true, method: 'pix', category: 'contas' })],
    () => [text('Preparei a despesa. Confira o cartão e confirme.')],
  ]
  const r = await say('Lançar 20 de despesa em nome do Zé, motivo gás')
  const p = proposalOf(r)
  check('proposal card', !!p && p.actions.length === 1)
  check('card built by code', flat(p?.actions[0]).includes('R$ 20,00') && flat(p?.actions[0]).includes('ZZS Zé: gás') && flat(p?.actions[0]).includes('Contas'), flat(p?.actions[0]))
  check('model text has no digits', !/\d/.test(textOf(r)))
  check('nothing written before confirm', (await entriesLike('ZZS Zé%')).length === 0)
  check('pending view', r.pendings.length === 1 && r.pendings[0]!.status === 'pending')
  const req = world.requests[0]
  check('llm request shape', req.model === 'test-model' && req.max_tokens === 600 && req.temperature === 0.2 && req.system[0].cache_control?.type === 'ephemeral' && req.tools.length >= 13)
  check('date block in system', /\d{4}-\d{2}-\d{2}/.test(req.system[1].text) && req.system[1].text.includes('America/Sao_Paulo'))
  const meta = (await q<any>("select meta from assistant_messages where role in ('assistant','card') order by created_at limit 1"))[0].meta
  check('tool calls recorded in meta', meta.tools?.[0]?.name === 'propose_expense' && meta.tools[0].ok === true)
  const c = await confirm(p!.pending_id)
  const e = (await entriesLike('ZZS Zé: gás'))[0]
  check('entry exists paid', !!e && e.amount_cents === 2000 && e.status === 'paid' && e.category === 'Contas' && e.kind === 'expense', JSON.stringify(e?.status))
  check('due date today', (await q<any>('select (due_date = today_sp()) as ok from ledger_entries where id = $1', [e.id]))[0].ok === true)
  check('payment pix', (await paymentsOf(e.id)).length === 1 && (await paymentsOf(e.id))[0].method === 'pix')
  check('reply built by code', textOf(c).startsWith('Feito:') && textOf(c).includes('R$ 20,00'))
  check('result card with undo', c.pendings[0]!.status === 'confirmed' && c.pendings[0]!.undoable.length === 1)
  const row = await pendingRow(p!.pending_id)
  check('executed_at and undo stored', !!row.executed_at && row.undo.length === 1 && row.result.lines[0].ok === true)
})

sc('2 expense unpaid', async () => {
  world.script = [
    () => [tu('propose_expense', { payee: 'ZZS Luz', reason: 'conta de luz', amount_cents: 15050, date_ref: { kind: 'tomorrow' }, paid: false })],
    () => [text('Preparei o lançamento.')],
  ]
  const r = await say('Conta de luz de amanhã')
  const c = await confirm(proposalOf(r)!.pending_id)
  const e = (await entriesLike('ZZS Luz: conta de luz'))[0]
  check('entry open', !!e && e.status === 'expected' && e.open_cents === 15050 && e.paid_cents === 0)
  check('due tomorrow', e && String(e.due_date) !== '' && (await q<any>("select (due_date = today_sp() + 1) as ok from ledger_entries where id = $1", [e.id]))[0].ok === true)
  check('reply mentions open', textOf(c).includes('em aberto'))
})

sc('3 double confirm executes once; same request id replays', async () => {
  world.script = [() => [tu('propose_expense', { payee: 'ZZS Dup', reason: 'teste', amount_cents: 1000, paid: false })], () => [text('Ok.')]]
  const r = await say('despesa')
  const id = proposalOf(r)!.pending_id
  const rid = crypto.randomUUID()
  const a = await confirm(id, { request_id: rid })
  const b = await confirm(id) // another request, already confirmed
  const c = await confirm(id, { request_id: rid }) // same request id: replay
  check('one entry', (await entriesLike('ZZS Dup%')).length === 1)
  check('second confirm returns stored result', cardOf(b, 'result')?.pending_id === id && !textOf(b).startsWith('Feito'))
  check('replay returns the same messages', a.messages.map((m) => m.id).join() === c.messages.map((m) => m.id).join())
  check('no extra pending rows', (await q<any>('select count(*)::int as n from assistant_pending'))[0].n === 1)
})

sc('4 cancel, then confirm after cancel', async () => {
  world.script = [() => [tu('propose_expense', { payee: 'ZZS Cancel', reason: 'x', amount_cents: 1000, paid: false })], () => [text('Ok.')]]
  const r = await say('despesa')
  const id = proposalOf(r)!.pending_id
  const c = await cancel(id)
  check('cancelled', (await pendingRow(id)).status === 'cancelled' && c.pendings[0]!.status === 'cancelled')
  const d = await confirm(id)
  check('confirm after cancel does nothing', (await entriesLike('ZZS Cancel%')).length === 0 && textOf(d).includes('cancelada'))
  check('cancel after cancel is harmless', textOf(await cancel(id)).includes('cancelada'))
})

sc('5 expired proposal is discarded', async () => {
  world.script = [() => [tu('propose_expense', { payee: 'ZZS Exp', reason: 'x', amount_cents: 1000, paid: false })], () => [text('Ok.')]]
  const r = await say('despesa')
  const id = proposalOf(r)!.pending_id
  const exp = await q<any>('select expires_at - created_at as ttl from assistant_pending where id = $1', [id])
  check('ttl is 15 minutes', exp[0].ttl.minutes === 15 && !exp[0].ttl.hours)
  await q("update assistant_pending set expires_at = now() - interval '1 second' where id = $1", [id])
  const c = await confirm(id)
  check('expired, nothing executed', (await pendingRow(id)).status === 'expired' && (await entriesLike('ZZS Exp%')).length === 0)
  check('message says expired', textOf(c).includes('expirou'))
  check('confirm again still nothing', (await entriesLike('ZZS Exp%')).length === 0 && textOf(await confirm(id)).includes('expirou'))
})

sc('6 ambiguous Julio: choice card, invalid picks, pick -> pay and complete', async () => {
  const a = await newClient('ZZS Julio Alves', 1)
  const b = await newClient('ZZS Julio Braga', 2)
  const apA = await bookToday(a, '09:00')
  const apB = await bookToday(b, '11:00')
  world.script = [
    () => [tu('find_entries', { client_query: 'ZZS Julio', mode: 'receivable', date_ref: { kind: 'today' } })],
    (c) => [tu('propose_payment', { entry_id: fund(c, 'find_entries').rows[0].entry_id, payments: [{ amount_cents: 8000, method: 'pix' }] })],
  ]
  const r = await say('Dar baixa no lançamento do Julio de hoje, 80 no pix')
  const choice = cardOf(r, 'choice') as ChoiceCard
  check('choice card with both candidates', !!choice && choice.options.length === 2 && choice.slot === 'entry_id')
  check('options carry client, date, service, value', choice.options.every((o) => o.label.includes('ZZS Julio') && o.detail.includes('R$ 80,00')), JSON.stringify(choice.options))
  check('no proposal, no pending', !proposalOf(r) && (await q<any>('select count(*)::int as n from assistant_pending'))[0].n === 0)
  check('llm stopped after choice', world.llmCalls === 2 && world.script.length === 0)
  // invalid picks
  const bad1 = await say('x', { pick: { choice_id: choice.choice_id, value: crypto.randomUUID() } })
  check('pick outside the stored candidates rejected', !proposalOf(bad1) && textOf(bad1).length > 0)
  const bad2 = await say('x', { pick: { choice_id: crypto.randomUUID(), value: choice.options[0]!.value } })
  check('pick with another choice id rejected', !proposalOf(bad2))
  check('still unresolved after bad picks', (await q<any>("select count(*)::int as n from assistant_messages where meta->>'resolved' = 'true'"))[0].n === 0)
  const target = choice.options.find((o) => o.label.includes('Braga'))!
  const p = await say('Julio Braga', { pick: { choice_id: choice.choice_id, value: target.value } })
  const prop = proposalOf(p)
  check('pick builds the proposal from the stored intent', !!prop && flat(prop.actions[0]).includes('Julio Braga') && flat(prop.actions[0]).includes('vai concluir o atendimento e receber'), flat(prop?.actions[0]))
  check('no llm call for the pick', world.llmCalls === 2)
  const again = await say('Julio Braga', { pick: { choice_id: choice.choice_id, value: target.value } })
  check('a resolved choice cannot be picked again', !proposalOf(again))
  const c = await confirm(prop!.pending_id)
  const ent = await entryOfAppt(apB)
  check('appointment completed and paid', (await q<any>('select status from appointments where id = $1', [apB]))[0].status === 'completed' && ent.status === 'paid' && (await paymentsOf(ent.id))[0].method === 'pix')
  check('other Julio untouched', (await q<any>('select status from appointments where id = $1', [apA]))[0].status === 'scheduled')
  check('reply', textOf(c).startsWith('Feito:'))
})

sc('7 payment on a completed appointment entry: partial', async () => {
  const cl = await newClient('ZZS Roberta Lima', 3)
  const ap = await bookToday(cl, '13:00')
  await q('select rpc_complete_appointment($1)', [ap])
  world.script = [
    () => [tu('find_entries', { client_query: 'ZZS Roberta', mode: 'receivable' })],
    (c) => [tu('propose_payment', { entry_id: fund(c, 'find_entries').rows[0].entry_id, payments: [{ amount_cents: 3000, method: 'pix' }] })],
    () => [text('Baixa preparada.')],
  ]
  const r = await say('Recebi 30 no pix da Roberta')
  const prop = proposalOf(r)
  check('single candidate: no choice', !!prop && !cardOf(r, 'choice'))
  check('resulting balance on the card', flat(prop?.actions[0]).includes('Saldo depois: R$ 50,00'), flat(prop?.actions[0]))
  const c = await confirm(prop!.pending_id)
  const ent = await entryOfAppt(ap)
  check('partial', ent.status === 'partial' && ent.paid_cents === 3000 && ent.open_cents === 5000)
  check('reply mentions rest', textOf(c).includes('restam R$ 50,00'))
})

sc('8 use package on scheduled and completed appointments; undo', async () => {
  const cl = await newClient('ZZS Pkg Client', 4)
  const pk = (await q<any>('select rpc_sell_package($1,$2) as id', [cl, tplId]))[0].id
  const apS = await bookToday(cl, '09:00')
  world.script = [
    () => [tu('find_entries', { client_query: 'ZZS Pkg', mode: 'receivable', date_ref: { kind: 'today' } })],
    (c) => [tu('propose_use_package', { entry_id: fund(c, 'find_entries').rows.find((r: any) => r.appointment_status).entry_id })],
    () => [text('Preparei o uso do pacote.')],
  ]
  const r = await say('Dar baixa no lançamento da Pkg de hoje, usar pacote ativo')
  const prop = proposalOf(r)
  check('card says session', flat(prop?.actions[0]).includes('usa 1 sessão do pacote (sessão 1/3, restam 2)'), flat(prop?.actions[0]))
  check('card says it completes', flat(prop?.actions[0]).includes('concluir o atendimento'))
  const c = await confirm(prop!.pending_id)
  const ent = await entryOfAppt(apS)
  const ap = (await q<any>('select * from appointments where id = $1', [apS]))[0]
  check('appointment completed with package', ap.status === 'completed' && ap.client_package_id === pk)
  check('ledger zero, no payments', ent.amount_cents === 0 && (await paymentsOf(ent.id)).length === 0)
  check('session consumed', (await q<any>('select remaining from v_client_packages where client_package_id = $1', [pk]))[0].remaining === 2)
  check('reply', textOf(c).includes('sessão 1/3') && c.pendings[0]!.undoable.length === 1)
  const u = await undo(prop!.pending_id)
  const ent2 = await entryOfAppt(apS)
  check('undo removes package', (await q<any>('select client_package_id from appointments where id = $1', [apS]))[0].client_package_id === null && ent2.amount_cents === 8000, textOf(u))
  check('undo reply', textOf(u).startsWith('Desfeito:') && u.pendings[0]!.undoable.length === 0)
  // completed appointment: apply_package
  const c2 = await newClient('ZZS Apply Pkg', 12)
  const pk2 = (await q<any>('select rpc_sell_package($1,$2) as id', [c2, tplId]))[0].id
  const apC = await bookToday(c2, '11:00')
  await q('select rpc_complete_appointment($1)', [apC])
  world.script = [
    () => [tu('find_entries', { client_query: 'ZZS Apply Pkg', mode: 'receivable' })],
    (c) => [tu('propose_use_package', { entry_id: fund(c, 'find_entries').rows.find((r: any) => r.appointment_status).entry_id })],
    () => [text('Ok.')],
  ]
  const r2 = await say('usar pacote no atendimento concluído')
  const prop2 = proposalOf(r2)!
  check('completed appointment: apply, no completion line', !flat(prop2.actions[0]).includes('concluir o atendimento'), flat(prop2.actions[0]))
  await confirm(prop2.pending_id)
  check('package applied to the completed appointment', (await q<any>('select client_package_id from appointments where id = $1', [apC]))[0].client_package_id === pk2 && (await entryOfAppt(apC)).amount_cents === 0)
  check('kind is apply_package', (await pendingRow(prop2.pending_id)).actions[0].kind === 'apply_package')
})

sc('9 package problems: expired, empty, none', async () => {
  const seen: any[] = []
  const attempt = async (cl: string, ap: string) => {
    void ap
    world.script = [
      () => [tu('find_entries', { client_query: cl, mode: 'receivable', date_ref: { kind: 'today' } })],
      (c) => [tu('propose_use_package', { entry_id: fund(c, 'find_entries').rows.find((r: any) => r.appointment_status).entry_id })],
      (c) => {
        seen.push(c.last('propose_use_package'))
        return [text('Não foi possível.')]
      },
    ]
    return await say('usar pacote')
  }
  const e1 = await newClient('ZZS Exp Pkg', 5)
  const pk1 = (await q<any>('select rpc_sell_package($1,$2) as id', [e1, tplId]))[0].id
  const a1 = await bookToday(e1, '09:00')
  await q("update client_packages set expires_at = today_sp() - 1 where id = $1", [pk1])
  const r1 = await attempt('ZZS Exp Pkg', a1)
  check('expired: no proposal, structured error', !proposalOf(r1) && seen[0]?.ok === false && seen[0].code === 'PACKAGE_EXPIRED' && seen[0].reason === 'expired', JSON.stringify(seen[0]))
  const e2 = await newClient('ZZS Empty Pkg', 6)
  const tpl1 = (await q<any>("select id from package_templates where name = 'ZZS Pacote x1'"))[0]?.id ?? (await q<any>("select rpc_upsert_package_template(null,'ZZS Pacote x1',$1,1,30,6000,true) as id", [svcId]))[0].id
  const pk2 = (await q<any>('select rpc_sell_package($1,$2) as id', [e2, tpl1]))[0].id
  await bookToday(e2, '11:00', pk2) // uses the only session
  const a2 = await bookToday(e2, '13:00')
  const r2 = await attempt('ZZS Empty Pkg', a2)
  check('empty: structured error', !proposalOf(r2) && seen[1]?.code === 'PACKAGE_EMPTY' && seen[1].reason === 'empty', JSON.stringify(seen[1]))
  const e3 = await newClient('ZZS None Pkg', 7)
  const a3 = await bookToday(e3, '15:00')
  const r3 = await attempt('ZZS None Pkg', a3)
  check('none: structured error', !proposalOf(r3) && seen[2]?.code === 'PACKAGE_INVALID' && seen[2].reason === 'none', JSON.stringify(seen[2]))
})

sc('10 split payment and undo', async () => {
  const cl = await newClient('ZZS Split Client', 8)
  const ap = await bookToday(cl, '09:00')
  await q('select rpc_complete_appointment($1)', [ap])
  world.script = [
    () => [tu('find_entries', { client_query: 'ZZS Split', mode: 'receivable' })],
    (c) => [tu('propose_payment', { entry_id: fund(c, 'find_entries').rows[0].entry_id, payments: [{ amount_cents: 5000, method: 'pix' }, { amount_cents: 3000, method: 'cash' }] })],
    () => [text('Pagamento dividido preparado.')],
  ]
  const r = await say('metade no pix e o resto em dinheiro')
  const prop = proposalOf(r)!
  const c = await confirm(prop.pending_id)
  const ent = await entryOfAppt(ap)
  const pays = await paymentsOf(ent.id)
  check('two payments, paid', ent.status === 'paid' && pays.length === 2 && pays.map((p: any) => p.method).sort().join() === 'cash,pix')
  check('two undo steps in one item', c.pendings[0]!.undoable.length === 1 && (await pendingRow(prop.pending_id)).undo[0].steps.length === 2)
  await undo(prop.pending_id)
  check('undo reverses both', (await q<any>('select count(*)::int as n from ledger_payments where entry_id = $1 and reversed_at is null', [ent.id]))[0].n === 0)
})

sc('11 reverse payment, then undo of the reversal', async () => {
  const cl = await newClient('ZZS Rev Client', 9)
  const ap = await bookToday(cl, '09:00')
  await q('select rpc_complete_appointment($1)', [ap])
  const ent = await entryOfAppt(ap)
  await q("select rpc_register_payments($1,null,'[{\"amount_cents\":8000,\"method\":\"pix\"}]'::jsonb,null)", [ent.id])
  world.script = [
    () => [tu('find_entries', { client_query: 'ZZS Rev', mode: 'statement' })],
    (c) => [tu('get_entry', { entry_id: fund(c, 'find_entries').rows[0].entry_id })],
    (c) => [tu('propose_reverse_payment', { payment_id: c.last('get_entry').entry.payments[0].payment_id })],
    () => [text('Estorno preparado.')],
  ]
  const r = await say('estornar o pix da Rev')
  const prop = proposalOf(r)
  check('proposal for the reversal', !!prop && flat(prop.actions[0]).includes('Saldo depois: R$ 80,00'), JSON.stringify(r.messages.map((m) => m.body)) + flat(prop?.actions[0]))
  if (!prop) return
  await confirm(prop.pending_id)
  check('payment reversed', (await q<any>('select count(*)::int as n from ledger_payments where entry_id = $1 and reversed_at is null', [ent.id]))[0].n === 0)
  await undo(prop.pending_id)
  check('undo re-registers the payment', (await q<any>('select count(*)::int as n from ledger_payments where entry_id = $1 and reversed_at is null and amount_cents = 8000', [ent.id]))[0].n === 1)
})

sc('12 void entry', async () => {
  const id = await manualEntry('ZZS Void me', 4200)
  world.script = [
    () => [tu('find_entries', { description_query: 'ZZS Void', mode: 'payable' })],
    (c) => [tu('propose_void_entry', { entry_id: fund(c, 'find_entries').rows[0].entry_id })],
    () => [text('Cancelamento preparado.')],
  ]
  const r = await say('cancelar o lançamento Void')
  const prop = proposalOf(r)!
  check('warns it cannot be undone', prop.actions[0]!.warnings.some((w) => w.includes('desfazer')))
  const c = await confirm(prop.pending_id)
  check('voided', (await q<any>('select voided_at from ledger_entries where id = $1', [id]))[0].voided_at !== null)
  check('no undo offered', c.pendings[0]!.undoable.length === 0)
})

sc('13 edit entry and undo', async () => {
  const id = await manualEntry('ZZS Edit me', 2500)
  world.script = [
    () => [tu('find_entries', { description_query: 'ZZS Edit', mode: 'payable' })],
    (c) => [tu('propose_edit_entry', { entry_id: fund(c, 'find_entries').rows[0].entry_id, description: 'novo ZZS nome', amount_cents: 3500, due_date_ref: { kind: 'tomorrow' } })],
    () => [text('Edição preparada.')],
  ]
  const r = await say('mudar o valor para 35')
  const prop = proposalOf(r)!
  check('before and after on the card', flat(prop.actions[0]).includes('R$ 25,00 → R$ 35,00'), flat(prop.actions[0]))
  await confirm(prop.pending_id)
  const e = (await q<any>('select description, amount_cents, due_date = today_sp() + 1 as tomorrow from ledger_entries where id = $1', [id]))[0]
  check('edited', e.description === 'novo ZZS nome' && e.amount_cents === 3500 && e.tomorrow === true)
  await undo(prop.pending_id)
  const e2 = (await q<any>('select description, amount_cents, due_date = today_sp() as today from ledger_entries where id = $1', [id]))[0]
  check('undo restores', e2.description === 'ZZS Edit me' && e2.amount_cents === 2500 && e2.today === true)
})

sc('14 batch of 3 with one failing', async () => {
  world.script = [
    () => [
      tu('propose_expense', { payee: 'ZZS B1', reason: 'um', amount_cents: 1000, paid: false }),
      tu('propose_expense', { payee: 'ZZS B2', reason: 'dois', amount_cents: 2000, paid: false }),
      tu('propose_expense', { payee: 'ZZS B3', reason: 'tres', amount_cents: 3000, paid: false }),
    ],
    () => [text('Preparei as três despesas.')],
  ]
  const r = await say('três despesas')
  const prop = proposalOf(r)!
  check('one pending row with 3 actions', prop.actions.length === 3 && (await q<any>('select count(*)::int as n from assistant_pending'))[0].n === 1)
  await q("update assistant_pending set actions = jsonb_set(actions, '{1,params,amount_cents}', '-5') where id = $1", [prop.pending_id]) // makes action 2 fail in the RPC
  const c = await confirm(prop.pending_id)
  const res = (await pendingRow(prop.pending_id)).result.lines
  check('actions ran in order, failure did not stop the others', res.map((l: any) => l.ok).join() === 'true,false,true', JSON.stringify(res))
  check('entries 1 and 3 exist, 2 does not', (await entriesLike('ZZS B1%')).length === 1 && (await entriesLike('ZZS B2%')).length === 0 && (await entriesLike('ZZS B3%')).length === 1)
  check('failure line has the pt-BR RPC message', res[1].text.includes('Valor inválido.') && textOf(c).includes('Não consegui'), res[1].text)
  check('status confirmed (some ok)', c.pendings[0]!.status === 'confirmed' && c.pendings[0]!.undoable.length === 2)
  const keys = await q<any>("select import_key from ledger_entries where import_key like 'assist-%' order by import_key")
  check('import keys derive from pending id and index', keys.length === 2 && keys[0].import_key === `assist-${prop.pending_id}-0` && keys[1].import_key === `assist-${prop.pending_id}-2`)
})

sc('15 unknown entry id from the model is rejected', async () => {
  const seen: any[] = []
  world.script = [
    () => [tu('propose_payment', { entry_id: crypto.randomUUID(), payments: [{ amount_cents: 1000, method: 'pix' }] })],
    (c) => {
      seen.push(c.last('propose_payment'))
      return [text('Não encontrei esse lançamento.')]
    },
  ]
  const r = await say('dar baixa')
  check('rejected with UNKNOWN_ID', seen[0]?.ok === false && seen[0].code === 'UNKNOWN_ID')
  check('no proposal, no pending', !proposalOf(r) && (await q<any>('select count(*)::int as n from assistant_pending'))[0].n === 0)
  // a real id never returned by a read in this thread is rejected too
  const id = await manualEntry('ZZS Not read', 1000)
  world.script = [() => [tu('propose_void_entry', { entry_id: id })], (c) => { seen.push(c.last('propose_void_entry')); return [text('Preciso consultar primeiro.')] }]
  await say('cancelar')
  check('real but unread id rejected', seen[1]?.code === 'UNKNOWN_ID')
})

sc('16 model text with digits: regenerate, then fallback', async () => {
  world.script = [() => [text('O total é 20 reais.')], () => [text('Sem número aqui.')]]
  const r1 = await say('quanto?')
  check('regenerated once and passed', world.llmCalls === 2 && textOf(r1) === 'Sem número aqui.')
  check('regeneration carries the corrective note', JSON.stringify(world.requests[1].system).includes('CORREÇÃO OBRIGATÓRIA'))
  world.reset()
  world.script = [() => [text('Total R$ 20')], () => [text('Ainda 30')]]
  const r2 = await say('quanto?')
  check('fallback after a second violation', textOf(r2) === GUARD_FALLBACK && world.llmCalls === 2)
  world.reset()
  world.script = [() => [tu('propose_expense', { payee: 'ZZS Guard', reason: 'x', amount_cents: 1000, paid: false })], () => [text('Feito 1')], () => [text('Feito 2')]]
  const r3 = await say('despesa')
  check('guard fallback drops the proposal', !proposalOf(r3) && textOf(r3) === GUARD_FALLBACK && (await q<any>('select count(*)::int as n from assistant_pending'))[0].n === 0)
})

sc('17 access control', async () => {
  const noJwt = await call({ action: 'message', text: 'oi' }, null)
  check('no token: 401', noJwt.status === 401)
  const badJwt = await call({ action: 'message', text: 'oi' }, 'not-a-jwt')
  check('bad token: 401', badJwt.status === 401)
  const pro = await call({ action: 'message', text: 'oi' }, proJwt)
  check('professional: 403', pro.status === 403 && world.llmCalls === 0)
  check('professional leaves no rows', (await q<any>('select count(*)::int as n from assistant_messages'))[0].n === 0)
  const badBody = await call({ action: 'nope' })
  check('bad action: 400', badBody.status === 400)
  const longText = await say('x'.repeat(1001))
  check('too long: 400', longText.status === 400)
  await q("update studio_settings set value = 'false' where key = 'assistant_enabled'")
  const off = await say('oi')
  check('disabled: 503 pt-BR', off.status === 503 && /desativado/.test(off.body.error) && world.llmCalls === 0)
})

sc('18 rate limit: the 31st request in 10 minutes', async () => {
  for (let i = 0; i < 29; i++) await q("insert into assistant_messages (owner_user_id, role, body) values ($1,'user','x')", [ownerId])
  world.script = [() => [text('Oi.')], () => [text('Oi.')]]
  const ok = await say('30ª')
  check('30th request allowed', ok.status === 200)
  const no = await say('31ª')
  check('31st request: 429', no.status === 429 && /Muitas mensagens/.test(no.body.error))
  await q("update assistant_messages set created_at = now() - interval '11 minutes'")
  const again = await say('depois da janela')
  check('window slides', again.status === 200)
})

sc('19 undo of a created entry (unpaid and paid) and a blocked undo', async () => {
  world.script = [() => [tu('propose_expense', { payee: 'ZZS U1', reason: 'a', amount_cents: 1000, paid: true, method: 'cash' })], () => [text('Ok.')]]
  const r = await say('despesa paga')
  const id = proposalOf(r)!.pending_id
  await confirm(id)
  const u = await undo(id)
  const e = (await q<any>("select voided_at from ledger_entries where description = 'ZZS U1: a'"))[0]
  check('paid creation: payment reversed then entry voided', !!e.voided_at && textOf(u).startsWith('Desfeito:'))
  check('undo twice is harmless', textOf(await undo(id)).includes('nada para desfazer'))
  world.script = [() => [tu('propose_expense', { payee: 'ZZS U2', reason: 'b', amount_cents: 1500, paid: false })], () => [text('Ok.')]]
  const r2 = await say('despesa aberta')
  const id2 = proposalOf(r2)!.pending_id
  await confirm(id2)
  const ent = (await entriesLike('ZZS U2: b'))[0]
  await q("select rpc_register_payments($1,null,'[{\"amount_cents\":1500,\"method\":\"pix\"}]'::jsonb,null)", [ent.id])
  const blocked = await undo(id2)
  check('blocked undo returns the RPC message', textOf(blocked).includes('Não deu para desfazer') && textOf(blocked).includes('estorne'), textOf(blocked))
  check('entry still live and undo still offered', (await entriesLike('ZZS U2: b')).length === 1 && blocked.pendings[0]!.undoable.length === 1)
})

sc('20 client credit and settle account (Task 9)', async () => {
  const cl = await newClient('ZZS Conta Cliente', 10)
  const ap = await bookToday(cl, '09:00')
  await q('select rpc_complete_appointment($1)', [ap])
  world.script = [() => [tu('propose_add_credit', { client_query: 'ZZS Conta Cliente', amount_cents: 3000, method: 'pix' })], () => [text('Crédito preparado.')]]
  const r = await say('adicionar crédito')
  const prop = proposalOf(r)!
  check('credit card shows the new balance', flat(prop.actions[0]).includes('Saldo de crédito depois: R$ 30,00'), flat(prop.actions[0]))
  await confirm(prop.pending_id)
  check('credit balance', (await q<any>('select credit_balance_cents from v_client_account where client_id = $1', [cl]))[0].credit_balance_cents === 3000)
  world.script = [
    () => [tu('propose_settle_account', { client_query: 'ZZS Conta Cliente', payments: [{ amount_cents: 3000, method: 'credit_balance' }, { amount_cents: 5000, method: 'pix' }] })],
    () => [text('Quitação preparada.')],
  ]
  const r2 = await say('quitar a conta')
  const p2 = proposalOf(r2)!
  check('settle card shows debt after', flat(p2.actions[0]).includes('Dívida depois: R$ 0,00'), flat(p2.actions[0]))
  await confirm(p2.pending_id)
  check('settled', (await entryOfAppt(ap)).status === 'paid')
  await undo(p2.pending_id)
  check('undo of settle', (await entryOfAppt(ap)).paid_cents === 0)
  world.script = [() => [tu('propose_settle_account', { client_query: 'ZZS Conta Cliente', payments: [{ amount_cents: 999999, method: 'pix' }] })], (c) => [text(c.last('propose_settle_account').code)]]
  const r3 = await say('quitar demais')
  check('overpayment rejected at proposal', !proposalOf(r3))
})

sc('21 reads: summary, client account, entries card truncated to 10', async () => {
  for (let i = 0; i < 12; i++) await manualEntry(`ZZS Lista ${i}`, 1000 + i)
  world.script = [() => [tu('find_entries', { description_query: 'ZZS Lista', mode: 'payable' })], () => [text('Aqui estão os lançamentos.')]]
  const r = await say('o que tenho a pagar')
  const c = cardOf(r, 'entries')!
  check('entries card with 10 of 12', c.rows.length === 10 && c.total === 12)
  world.script = [() => [tu('finance_summary', { period: 'today' })], () => [text('Resumo de hoje abaixo.')]]
  const s = await say('Resumo de hoje')
  const f = cardOf(s, 'facts')!
  check('summary facts card from rpc_finance_summary', f.title.startsWith('Resumo') && f.lines.some((l) => l.label === 'Recebido') && f.lines.some((l) => l.label === 'Resultado'))
  const tr = (world.requests.at(-1).messages.find((m: any) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result')?.content[0].content as string) ?? ''
  check('summary numbers are not sent to the model', !/\d/.test(tr), tr)
  const cl = await newClient('ZZS Account Read', 11)
  void cl
  world.script = [() => [tu('client_account', { client_query: 'ZZS Account Read' })], () => [text('Conta da cliente abaixo.')]]
  const a = await say('conta da cliente')
  check('client account card', cardOf(a, 'facts')?.lines.some((l) => l.label === 'Dívida em aberto') === true)
  world.script = [() => [tu('finance_summary', { period: 'date_range', date_from: { kind: 'date', value: '2020-01-01' }, date_to: { kind: 'today' } })], (c) => [text(c.last('finance_summary').code)]]
  const big = await say('resumo de tudo')
  check('range over 366 days is a structured error', !cardOf(big, 'facts'))
})

sc('22 validation: amounts, dates, duplicates, high value', async () => {
  const seen: any[] = []
  const grab = (name: string) => (c: Ctx) => {
    seen.push(c.last(name))
    return [text('Não deu.')]
  }
  world.script = [() => [tu('propose_expense', { payee: 'ZZS V', reason: 'x', amount_cents: 6_000_000, paid: false })], grab('propose_expense')]
  await say('muito')
  check('above the cap: BAD_AMOUNT', seen[0]?.code === 'BAD_AMOUNT')
  world.script = [() => [tu('propose_expense', { payee: 'ZZS V', reason: 'x', amount_cents: 12.5, paid: false })], grab('propose_expense')]
  await say('fração')
  check('non-integer cents rejected', seen[1]?.code === 'BAD_AMOUNT')
  world.script = [() => [tu('propose_expense', { payee: 'ZZS V', reason: 'x', amount_cents: 1000, date_ref: { kind: 'date', value: '2026-02-31' }, paid: false })], grab('propose_expense')]
  await say('data ruim')
  check('invalid date: structured error', seen[2]?.code === 'DATE_INVALID')
  world.script = [() => [tu('propose_expense', { payee: 'ZZS V', reason: 'x', amount_cents: 1000, paid: true })], grab('propose_expense')]
  await say('sem forma')
  check('paid without method: asks', seen[3]?.code === 'METHOD_REQUIRED')
  world.script = [() => [tu('propose_expense', { payee: 'ZZS V', reason: 'x', amount_cents: 1000, paid: true, method: 'barter' })], grab('propose_expense')]
  await say('permuta em despesa')
  check('barter on expense rejected', seen[4]?.code === 'METHOD_NOT_ALLOWED')
  world.script = [() => [tu('propose_expense', { payee: 'ZZS Alto', reason: 'obra', amount_cents: 1_500_000, paid: false, category: 'desconhecida' })], () => [text('Preparei.')]]
  const hi = await say('obra')
  const p = proposalOf(hi)!
  check('high value warning and unknown category -> Outros', p.actions[0]!.warnings.includes('Valor alto, confira') && flat(p.actions[0]).includes('Outros'), flat(p.actions[0]))
  await manualEntry('ZZS Repetida', 7000)
  world.script = [() => [tu('propose_expense', { reason: 'ZZS Repetida', amount_cents: 7000, paid: false })], () => [text('Preparei.')]]
  const dup = await say('de novo')
  const dp = proposalOf(dup)!
  check('duplicate guard warns and does not block', dp.actions[0]!.warnings.includes('Já existe um lançamento igual'))
  await confirm(dp.pending_id)
  check('duplicate still created on confirm', (await entriesLike('ZZS Repetida')).length === 2)
  world.script = [() => [tu('propose_expense', { payee: 'ZZS Max', reason: 'x', amount_cents: 5_000_000, paid: false })], () => [text('Ok.')]]
  check('exactly the cap is accepted', !!proposalOf(await say('limite')))
})

sc('23 ask_user rules', async () => {
  const seen: any[] = []
  world.script = [
    () => [tu('ask_user', { question: 'Qual o valor de 20 reais?', options: [] })],
    (c) => {
      seen.push(c.last('ask_user'))
      return [tu('ask_user', { question: 'Pago em qual forma?', options: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ label: `Op${'x'.repeat(n)}`, value: `v${n}` })) })]
    },
    (c) => {
      seen.push(c.last('ask_user'))
      return [tu('ask_user', { question: 'Pago em qual forma?', options: [{ label: 'Pix', value: 'pix' }, { label: 'Dinheiro', value: 'cash' }] })]
    },
  ]
  const r = await say('lançar despesa de gás')
  check('digits in the question rejected', seen[0]?.code === 'DIGITS_IN_QUESTION')
  check('more than 6 options rejected', seen[1]?.code === 'BAD_ARGUMENT')
  const qc = cardOf(r, 'question')
  check('question card with chips', qc?.options.length === 2 && qc.options[0]!.value === 'pix')
  check('loop ended after the question', world.script.length === 0 && world.llmCalls === 3)
})

sc('24 max 6 tool iterations then a closing call without tools', async () => {
  world.script = [
    ...Array.from({ length: 6 }, () => () => [tu('find_entries', { description_query: 'ZZS nada', mode: 'payable' })]),
    () => [text('Não achei nada.')],
  ]
  const r = await say('procurar')
  check('7 model calls, last one with tools disabled', world.llmCalls === 7 && world.requests[6].tool_choice?.type === 'none')
  check('answered', textOf(r) === 'Não achei nada.')
})

// ---------------------------------------------------------------- run
async function main() {
  await pgc.connect()
  await ensureFixtures()
  const only = process.env.ONLY?.split(',')
  for (const [name, fn] of scenarios) {
    if (only && !only.some((p) => name.startsWith(p + ' '))) continue
    scenario = name
    try {
      await reset()
      const before = failures.length
      await fn()
      void before
      check('script fully consumed', world.script.length === 0, `${world.script.length} left`)
      const bad = await invariants()
      check('check_invariants() = 0 rows', bad === 0, String(bad))
    } catch (e) {
      failures.push(`[${name}] threw: ${e instanceof Error ? e.stack?.split('\n').slice(0, 3).join(' | ') : String(e)}`)
    }
  }
  scenario = 'cleanup'
  await reset()
  await pgc.end()
  if (failures.length) console.log(failures.join('\n'))
  console.log(`test:assistant ${failures.length ? 'FAIL' : 'PASS'} (${passed} checks, ${failures.length} failed, ${scenarios.length} scenarios)`)
  process.exit(failures.length ? 1 : 0)
}
void main()
