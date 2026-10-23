// Manual simulation of the finance assistant with the REAL model against the LOCAL database.
// ANTHROPIC_API_KEY comes from the process environment only. 12 scripted messages from Karol, assertions on database
// outcomes, abort above 40k tokens. Local Supabase only. Not part of the automatic suites.
import { createClient } from '@supabase/supabase-js'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { handleAssistant, type AssistantRuntime } from '../supabase/functions/_shared/assistant.ts'
import type { Card, MessageView } from '../supabase/functions/_shared/assistant-types.ts'
import type { Db } from '../supabase/functions/_shared/types.ts'

const KEY = process.env.ANTHROPIC_API_KEY
if (!KEY) {
  console.log('sim:assistant SKIPPED: ANTHROPIC_API_KEY is not set in this PowerShell window. Set it for this window only, then run again:')
  console.log('  $env:ANTHROPIC_API_KEY = Read-Host "Chave da Anthropic"')
  console.log('  npm run sim:assistant')
  process.exit(0)
}

const TOKEN_LIMIT = 40_000
const DEV_PASSWORD = 'studio-dev-123' // local demo password set by scripts/dev-users.ts

function localStatus(): { API_URL: string; SERVICE_ROLE_KEY: string; ANON_KEY: string; DB_URL: string } {
  const r = spawnSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', shell: true })
  const out = r.stdout ?? ''
  try {
    return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  } catch {
    console.log('sim:assistant FAIL: run `supabase start` first (could not read `supabase status -o json`).')
    process.exit(1)
  }
}
const status = localStatus()
if (!['127.0.0.1', 'localhost'].includes(new URL(status.API_URL).hostname)) {
  console.log('sim:assistant REFUSED: Supabase is not local.')
  process.exit(1)
}
const svc = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const pgc = new pg.Client({ connectionString: status.DB_URL })
const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await pgc.query(sql, params)).rows as T[]

// ---------------------------------------------------------------- token budget
let tokens = 0
class Abort extends Error {}
const countingFetch: AssistantRuntime['fetch'] = async (input, init) => {
  const res = await fetch(input, init)
  try {
    const u = ((await res.clone().json()) as { usage?: Record<string, number> }).usage
    tokens += (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
  } catch {
    /* error bodies carry no usage */
  }
  if (tokens > TOKEN_LIMIT) throw new Abort(`token budget exceeded (${tokens} > ${TOKEN_LIMIT})`)
  return res
}

let jwt = ''
const rt = (): AssistantRuntime => ({
  svc: svc as unknown as Db,
  authenticate: async (t) => {
    const { data, error } = await svc.auth.getUser(t)
    return error || !data.user ? null : { id: data.user.id }
  },
  userDb: (t) => createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${t}` } } }) as unknown as Db,
  fetch: countingFetch,
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
  cfg: { anthropicKey: KEY, model: process.env.ASSISTANT_MODEL || 'claude-haiku-4-5-20251001' },
  log: (e, d) => console.log(`  [log] ${e} ${JSON.stringify(d ?? {})}`),
})

// ---------------------------------------------------------------- conversation helpers
interface Res {
  status: number
  messages: MessageView[]
  pendings: Array<{ id: string; status: string }>
  error?: string
}
async function call(body: Record<string, unknown>): Promise<Res> {
  const r = await handleAssistant(rt(), jwt, { request_id: crypto.randomUUID(), ...body })
  const b = r.body as any
  return { status: r.status, messages: b.messages ?? [], pendings: b.pendings ?? [], error: b.error }
}
const cards = (r: Res) => r.messages.map((m) => m.card).filter((c): c is Card => !!c)
const cardOf = <K extends Card['kind']>(r: Res, kind: K) => cards(r).find((c): c is Extract<Card, { kind: K }> => c.kind === kind)
const said = (r: Res) => r.messages.filter((m) => m.role === 'assistant').map((m) => m.body).join(' ')

/** Sends a message; answers questions and choices like Karol would; confirms the proposal. Returns every response. */
async function converse(text: string, opts: { confirm?: boolean; answer?: string } = {}): Promise<{ all: Res[]; confirmed: Res | null; proposal: Extract<Card, { kind: 'proposal' }> | null }> {
  const all: Res[] = []
  let r = await call({ action: 'message', text })
  all.push(r)
  for (let i = 0; i < 3; i++) {
    const choice = cardOf(r, 'choice')
    const question = cardOf(r, 'question')
    if (choice) r = await call({ action: 'message', text: choice.options[0]!.label, pick: { choice_id: choice.choice_id, value: choice.options[0]!.value } })
    else if (question) r = await call({ action: 'message', text: opts.answer ?? 'Ainda não paguei, deixe em aberto.' })
    else break
    all.push(r)
  }
  const proposal = cardOf(all.at(-1)!, 'proposal') ?? null
  let confirmed: Res | null = null
  if (proposal && opts.confirm !== false) {
    confirmed = await call({ action: 'confirm', pending_id: proposal.pending_id })
    all.push(confirmed)
  }
  return { all, confirmed, proposal }
}

// ---------------------------------------------------------------- fixtures
let maraId = ''
let svcId = ''
let tplId = ''
async function fixtures() {
  spawnSync('npx', ['tsx', 'scripts/dev-users.ts'], { shell: true, stdio: 'ignore' })
  const anon = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email: 'karol@studio.test', password: DEV_PASSWORD })
  if (error || !data.session) throw new Error(`login: ${error?.message}`)
  jwt = data.session.access_token
  maraId = (await q<{ id: string }>("select id from professionals where name = 'Mara'"))[0]!.id
  svcId = (await q<{ id: string }>("select id from services where name = 'ZZS Servico'"))[0]?.id ??
    (await q<{ id: string }>("select rpc_upsert_service(null,'ZZS Servico','unhas','standard',60,8000,null,null,null,true) as id"))[0]!.id
  await q('insert into professional_services values ($1,$2) on conflict do nothing', [maraId, svcId])
  tplId = (await q<{ id: string }>("select id from package_templates where name = 'ZZS Pacote x3'"))[0]?.id ??
    (await q<{ id: string }>("select rpc_upsert_package_template(null,'ZZS Pacote x3',$1,3,30,18000,true) as id", [svcId]))[0]!.id
}
async function wipe() {
  const clients = "select id from clients where name like 'ZZS %'"
  const entries = `select id from ledger_entries where description like '%ZZS%' or import_key like 'assist-%' or client_id in (${clients})`
  await q('delete from assistant_messages')
  await q('delete from assistant_pending')
  await q(`delete from ledger_payments where entry_id in (${entries})`)
  await q(`delete from account_settlements where client_id in (${clients})`)
  await q(`delete from ledger_entries where id in (${entries})`)
  await q(`delete from appointment_addons where appointment_id in (select id from appointments where client_id in (${clients}))`)
  await q(`delete from appointments where client_id in (${clients})`)
  await q(`delete from client_packages where client_id in (${clients})`)
  await q("delete from clients where name like 'ZZS %'")
}
let seq = 0
const newClient = async (name: string) => (await q<{ id: string }>('select rpc_upsert_client($1,$2,null,null,null) as id', [name, `1197770${String(++seq).padStart(4, '0')}`]))[0]!.id
const bookToday = async (clientId: string, hhmm: string, complete = false) => {
  const id = (await q<{ id: string }>(
    "select rpc_book_appointment($1::uuid,$2::uuid,$3::uuid,'placement'::service_action,'{}'::uuid[],((today_sp() + $4::time) at time zone 'America/Sao_Paulo'),'staff'::appointment_source,$5,null,null,true) as id",
    [clientId, maraId, svcId, hhmm, `sim-${++seq}-${Math.random()}`],
  ))[0]!.id
  if (complete) await q('select rpc_complete_appointment($1)', [id])
  return id
}

// ---------------------------------------------------------------- the 12 messages
let passed = 0
const failures: string[] = []
const lines: string[] = []
function check(n: number, name: string, ok: boolean, extra = '') {
  if (ok) passed++
  else failures.push(`#${n} ${name}${extra ? ` (${extra})` : ''}`)
}
const one = async (sql: string, p: unknown[] = []) => (await q<any>(sql, p))[0]

async function main() {
  await pgc.connect()
  await fixtures()
  await wipe()
  let step = 0
  const mark = (label: string) => lines.push(`${String(++step).padStart(2)}. ${label.padEnd(60)} tokens ${tokens}`)

  // fixtures for the whole run
  const julioPkg = await newClient('ZZS Julio Pacote')
  const pkg = (await one('select rpc_sell_package($1,$2) as id', [julioPkg, tplId])).id
  const apJulio = await bookToday(julioPkg, '09:00')
  const roberta = await newClient('ZZS Roberta Lima')
  const apRoberta = await bookToday(roberta, '11:00', true)
  const marina = await newClient('ZZS Marina Souza')
  const apMarina = await bookToday(marina, '13:00', true)

  // 1
  let t = await converse('Lançar 20 de despesa em nome do Zé, motivo gás')
  let e = await one("select * from v_ledger where kind = 'expense' and description ilike '%gás%' and voided_at is null order by created_at desc limit 1")
  check(1, 'expense for Zé, gás, 20 reais', !!e && e.amount_cents === 2000 && /z[eé]/i.test(e.description), JSON.stringify(e && [e.description, e.amount_cents]))
  mark('Lançar 20 de despesa em nome do Zé, motivo gás')

  // 2
  t = await converse('Dar baixa no lançamento do Julio de hoje, usar pacote ativo')
  const ap = await one('select status, client_package_id from appointments where id = $1', [apJulio])
  check(2, 'Julio: package used and appointment completed', ap.status === 'completed' && ap.client_package_id === pkg, JSON.stringify(ap))
  check(2, 'ledger zero', (await one('select amount_cents from ledger_entries where appointment_id = $1 and voided_at is null', [apJulio])).amount_cents === 0)
  mark('Dar baixa no lançamento do Julio de hoje, usar pacote ativo')

  // 3
  t = await converse('Recebi 50 no pix da Roberta')
  const pay = await one("select p.amount_cents, p.method from ledger_payments p join ledger_entries l on l.id = p.entry_id join clients c on c.id = l.client_id where c.name = 'ZZS Roberta Lima' and p.reversed_at is null order by p.created_at desc limit 1")
  check(3, 'Roberta: 50 reais received in pix', pay?.amount_cents === 5000 && pay.method === 'pix', JSON.stringify(pay))
  mark('Recebi 50 no pix da Roberta')

  // 4
  const before = (await one('select count(*)::int as n from assistant_pending')).n
  let r = await call({ action: 'message', text: 'Resumo de hoje' })
  check(4, 'summary card, nothing proposed', !!cardOf(r, 'facts') && !cardOf(r, 'proposal') && (await one('select count(*)::int as n from assistant_pending')).n === before)
  mark('Resumo de hoje')

  // 5
  t = await converse('Paguei 150 de aluguel hoje em dinheiro')
  e = await one("select * from v_ledger where kind = 'expense' and category = 'Aluguel' and voided_at is null order by created_at desc limit 1")
  check(5, 'rent 150 paid in cash', !!e && e.amount_cents === 15000 && e.paid_cents === 15000, JSON.stringify(e && [e.amount_cents, e.paid_cents]))
  mark('Paguei 150 de aluguel hoje em dinheiro')

  // 6
  const gas = await one("select id from ledger_entries where description ilike '%gás%' and kind = 'expense' and voided_at is null order by created_at desc limit 1")
  t = await converse('Cancela o lançamento do gás')
  check(6, 'gas entry voided', !!gas && (await one('select voided_at from ledger_entries where id = $1', [gas.id])).voided_at !== null)
  mark('Cancela o lançamento do gás')

  // 7 (two Julios with an open entry today: the owner picks from chips)
  const j1 = await newClient('ZZS Julio Costa')
  const j2 = await newClient('ZZS Julio Dias')
  const a1 = await bookToday(j1, '15:00')
  const a2 = await bookToday(j2, '17:00')
  t = await converse('Dar baixa no lançamento do Julio de hoje, 80 no pix')
  const done = (await q<any>("select status from appointments where id = any($1::uuid[])", [[a1, a2]])).filter((x) => x.status === 'completed').length
  check(7, 'ambiguous Julio: choice then exactly one completed', !!cardOf(t.all[0]!, 'choice') && done === 1, `choice=${!!cardOf(t.all[0]!, 'choice')} done=${done}`)
  mark('Dar baixa no lançamento do Julio de hoje (ambíguo)')

  // 8
  t = await converse('Dar baixa na Marina, metade no pix e metade em dinheiro')
  const mp = await q<any>('select method, amount_cents from ledger_payments where entry_id = (select id from ledger_entries where appointment_id = $1 and voided_at is null) and reversed_at is null', [apMarina])
  check(8, 'Marina: split 4000 pix + 4000 cash', mp.length === 2 && mp.every((x) => x.amount_cents === 4000) && mp.map((x) => x.method).sort().join() === 'cash,pix', JSON.stringify(mp))
  mark('Dar baixa na Marina, metade no pix e metade em dinheiro')

  // 9
  t = await converse('Estorna o pix da Roberta')
  check(9, 'Roberta pix reversed', (await one("select count(*)::int as n from ledger_payments p join ledger_entries l on l.id = p.entry_id where l.appointment_id = $1 and p.reversed_at is null", [apRoberta])).n === 0)
  mark('Estorna o pix da Roberta')

  // 10
  t = await converse('Muda o valor do aluguel para 180')
  e = await one("select * from v_ledger where kind = 'expense' and category = 'Aluguel' and voided_at is null order by created_at desc limit 1")
  check(10, 'rent edited to 180', e?.amount_cents === 18000, String(e?.amount_cents))
  mark('Muda o valor do aluguel para 180')

  // 11
  r = await call({ action: 'message', text: 'Mostra o que tenho a pagar' })
  check(11, 'payables card', !!cardOf(r, 'entries'))
  mark('Mostra o que tenho a pagar')

  // 12
  const pend = (await one('select count(*)::int as n from assistant_pending')).n
  r = await call({ action: 'message', text: 'Qual vai ser a previsão do tempo amanhã?' })
  check(12, 'out of scope: one sentence, no card, no proposal', !!said(r) && cards(r).length === 0 && (await one('select count(*)::int as n from assistant_pending')).n === pend, said(r))
  check(12, 'out of scope text has no digits', !/\d/.test(said(r)))
  mark('Qual vai ser a previsão do tempo amanhã?')

  const bad = (await svc.rpc('check_invariants')).data as unknown[]
  check(0, 'check_invariants() = 0 rows', (bad ?? []).length === 0, String(bad?.length))
  void t
  await wipe()
  await pgc.end()
  for (const l of lines) console.log(l)
  if (failures.length) console.log(failures.join('\n'))
  console.log(`sim:assistant ${failures.length ? 'FAIL' : 'PASS'} (${passed} checks, ${failures.length} failed, ${tokens} tokens of ${TOKEN_LIMIT})`)
  process.exit(failures.length ? 1 : 0)
}

main().catch(async (e) => {
  for (const l of lines) console.log(l)
  console.log(e instanceof Abort ? `sim:assistant ABORTED: ${e.message}` : `sim:assistant FAIL: ${e instanceof Error ? e.stack : String(e)}`)
  try {
    await wipe()
    await pgc.end()
  } catch {
    /* best effort */
  }
  process.exit(1)
})
