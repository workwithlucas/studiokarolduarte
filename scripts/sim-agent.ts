// Agent simulation: REAL Claude (THAIS_MODEL) + stubbed Z-API + the LOCAL database and real rpc_*.
// Costs tokens: run it yourself. ANTHROPIC_API_KEY comes from the process env only.
//   PowerShell:  $env:ANTHROPIC_API_KEY = Read-Host "Cole a chave"   (fica só nesta janela)
//                npm run sim:agent
import { createClient } from '@supabase/supabase-js'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { runAgent } from '../supabase/functions/_shared/agent.ts'
import { hasForbiddenPhrase } from '../supabase/functions/_shared/filters.ts'
import { addDays, parseInstant, spParts } from '../supabase/functions/_shared/time.ts'
import type { Db, Deps } from '../supabase/functions/_shared/types.ts'

const KEY = process.env.ANTHROPIC_API_KEY
if (!KEY) {
  console.log('sim:agent: ANTHROPIC_API_KEY não definida. No PowerShell, digite (a chave fica só nesta janela):')
  console.log('  $env:ANTHROPIC_API_KEY = Read-Host "Cole a chave da Anthropic"')
  console.log('  npm run sim:agent')
  console.log('Opcional: $env:THAIS_MODEL = "claude-haiku-4-5-20251001"')
  process.exit(0)
}
const MODEL = process.env.THAIS_MODEL || 'claude-haiku-4-5-20251001'
const TOKEN_LIMIT = 60_000

function localStatus(): { API_URL: string; SERVICE_ROLE_KEY: string; DB_URL: string } {
  const r = spawnSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', shell: true })
  const out = r.stdout ?? ''
  try {
    return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  } catch {
    console.log('sim:agent FAIL: run `supabase start` first.')
    process.exit(1)
  }
}
const status = localStatus()
const host = new URL(status.API_URL).hostname
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.log(`sim:agent REFUSED: Supabase host is "${host}", not local.`)
  process.exit(1)
}
const db = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } }) as unknown as Db
const pgc = new pg.Client({ connectionString: status.DB_URL })
const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await pgc.query(sql, params)).rows as T[]

// ---------------------------------------------------------------- stubbed Z-API, real Anthropic
const sends: Array<{ phone: string; message: string }> = []
let outId = 0
const fetchSim: Deps['fetch'] = async (input, init) => {
  const url = String(input)
  if (url.startsWith('https://api.z-api.io/')) {
    const b = JSON.parse(String(init?.body))
    sends.push({ phone: b.phone, message: b.message })
    return new Response(JSON.stringify({ zaapId: 'Z', messageId: `SIM-OUT-${++outId}`, id: `SIM-OUT-${outId}` }), { headers: { 'content-type': 'application/json' } })
  }
  return fetch(url, init)
}
const deps: Deps = {
  db, fetch: fetchSim, now: () => Date.now(), sleep: async () => {}, random: () => 0.5,
  cfg: { anthropicKey: KEY, model: MODEL, zapi: { instanceId: 'I', token: 'T', clientToken: 'C' } },
  log: (e, d) => errors.push(`${e} ${JSON.stringify(d ?? {})}`),
}
const errors: string[] = []

// ---------------------------------------------------------------- fixtures
let maraId = ''
let milenaId = ''
let svcId = ''
const today = () => spParts(Date.now()).ymd
const P = (n: number) => `55119980${String(n).padStart(5, '0')}`

async function fixtures() {
  const pros = await q<{ id: string; name: string }>("select id, name from professionals where name in ('Mara','Milena')")
  maraId = pros.find((p) => p.name === 'Mara')!.id
  milenaId = pros.find((p) => p.name === 'Milena')!.id
  svcId = (await q<{ id: string }>("select id from services where name = 'Manicure com gel'"))[0]?.id ??
    (await q<{ id: string }>("select rpc_upsert_service(null,'Manicure com gel','unhas','standard',60,8000,50,6000,null,true) as id"))[0]!.id
  const cil = await q<{ id: string }>("select id from services where name = 'Cílios fio a fio'")
  const cilId = cil[0]?.id ?? (await q<{ id: string }>("select rpc_upsert_service(null,'Cílios fio a fio','cilios','standard',120,15000,90,9000,null,true) as id"))[0]!.id
  for (const p of [maraId, milenaId]) for (const s of [svcId, cilId]) await q('insert into professional_services values ($1,$2) on conflict do nothing', [p, s])
  for (const [k, v] of Object.entries({ agent_mode: 'live', agent_window_start: '00:00', agent_window_end: '23:59', agent_test_numbers: [] })) {
    await q('insert into studio_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value', [k, JSON.stringify(v)])
  }
}

async function reset() {
  await q("delete from ledger_entries where client_id in (select id from clients where name like 'ZZS %')")
  await q("delete from appointment_addons where appointment_id in (select a.id from appointments a join clients c on c.id = a.client_id where c.name like 'ZZS %')")
  await q("delete from wa_confirmations where appointment_id in (select a.id from appointments a join clients c on c.id = a.client_id where c.name like 'ZZS %')")
  await q("delete from appointments where client_id in (select id from clients where name like 'ZZS %')")
  await q("delete from wa_conversations where phone_e164 like '5511998%'")
  await q("delete from clients where name like 'ZZS %'")
  sends.length = 0
}
const newClient = async (name: string, phone: string) => (await q<{ id: string }>('select rpc_upsert_client($1,$2,null,null,null) as id', [name, phone]))[0]!.id
const book = async (cid: string, pro: string, at: string, force = false) =>
  (await q<{ id: string }>("select rpc_book_appointment($1::uuid,$2::uuid,$3::uuid,'placement'::service_action,'{}'::uuid[],$4::timestamptz,'staff'::appointment_source,$5,null,null,$6) as id", [cid, pro, svcId, at, `zzs-${Math.random()}`, force]))[0]!.id
async function firstSlot(pro: string): Promise<string> {
  const { data } = await db.rpc('rpc_get_availability', { p_professional_id: pro, p_service_id: svcId, p_action: 'placement', p_addon_ids: [], p_from: addDays(today(), 2), p_to: addDays(today(), 12), p_source: 'agent' })
  return (data as Array<{ starts_at: string }>)[0]!.starts_at
}
const convOf = async (phone: string) => (await q<any>('select * from wa_conversations where phone_e164 = $1', [phone]))[0]

// ---------------------------------------------------------------- run
let tokens = 0
let aborted = false
const format: string[] = []

async function converse(phone: string, lines: string[]): Promise<string[]> {
  const all: string[] = []
  for (const line of lines) {
    if (tokens > TOKEN_LIMIT) {
      aborted = true
      break
    }
    const ing = await q<any>('select * from agent_ingest_inbound($1,$2,$3,$4)', [phone, `SIM-IN-${Math.random()}`, 'text', line])
    // pending_since is set by the ingest; the run is what the debounce would trigger
    const before = sends.length
    const out = await runAgent(deps, ing[0].conversation_id)
    tokens += (out.usage?.input ?? 0) + (out.usage?.output ?? 0)
    const turn = sends.slice(before).filter((s) => s.phone === phone).map((s) => s.message)
    if (out.status === 'failed') format.push(`turno "${line.slice(0, 30)}": run falhou (${errors.at(-1) ?? '?'})`)
    if (turn.length > 2) format.push(`mais de 2 mensagens no turno "${line.slice(0, 30)}" (${turn.length})`)
    for (const m of turn) {
      if (m.split('\n').length > 3) format.push(`mais de 3 linhas: "${m.slice(0, 40)}…"`)
      if (hasForbiddenPhrase(m)) format.push(`frase proibida: "${m.slice(0, 60)}…"`)
    }
    all.push(...turn)
  }
  return all
}

interface Sim {
  name: string
  run: () => Promise<string | null> // null = pass, string = why it failed
}
const sims: Sim[] = [
  {
    name: '1 cliente nova agenda',
    run: async () => {
      const phone = P(1)
      await converse(phone, ['Oi! Quero fazer manicure com gel.', 'Meu nome é Ana Sim Nova.', 'Pode ser com a Mara, no primeiro horário que tiver.', 'Sim, pode confirmar!'])
      const a = await q<any>("select a.* from appointments a join clients c on c.id=a.client_id where c.phone_e164=$1 and a.status='scheduled'", [phone])
      return a.length === 1 && a[0].source === 'agent' ? null : `esperava 1 agendamento do agente, veio ${a.length}`
    },
  },
  {
    name: '2 cliente conhecida, profissional habitual',
    run: async () => {
      const phone = P(2)
      const cid = await newClient('ZZS Bia Habitual', phone)
      for (const d of ['2026-08-03T13:00:00Z', '2026-08-17T13:00:00Z']) await q('select rpc_complete_appointment($1)', [await book(cid, milenaId, d, true)])
      const r = await converse(phone, ['Oi, quero marcar manicure com gel'])
      return r.join(' ').includes('Milena') ? null : `não ofereceu a Milena: ${r.join(' | ')}`
    },
  },
  {
    name: '3 áudio (transcrição) sobre cílios e preço',
    run: async () => {
      const r = await converse(P(3), ['oi tudo bem eu queria saber se vocês fazem cílios fio a fio e quanto que custa'])
      return /R\$\s?150/.test(r.join(' ')) ? null : `não informou o preço do catálogo: ${r.join(' | ')}`
    },
  },
  {
    name: '4 imagem de referência',
    run: async () => {
      await converse(P(4), ['[imagem: unhas com francesinha rosa e brilho]', 'quero assim, vocês fazem?'])
      const c = await convOf(P(4))
      return c?.needs_attention ? null : 'não deixou recado para a Karol sobre a referência'
    },
  },
  {
    name: '5 figurinha',
    run: async () => {
      await converse(P(5), ['oi', '[figurinha]'])
      return null // outcome is "no reply or one short question": the format assertions cover it
    },
  },
  {
    name: '6 família no mesmo telefone',
    run: async () => {
      const phone = P(6)
      await newClient('ZZS Marta Mae', phone)
      const filha = await newClient('ZZS Julia Filha', phone)
      await converse(phone, ['Oi, quero marcar manicure com gel para a minha filha Julia'])
      const c = await convOf(phone)
      return c.client_id === filha ? null : 'não selecionou a Julia (filha)'
    },
  },
  {
    name: '7 cancelamento',
    run: async () => {
      const phone = P(7)
      const cid = await newClient('ZZS Cida Cancela', phone)
      const id = await book(cid, maraId, await firstSlot(maraId))
      await converse(phone, ['Preciso cancelar meu horário', 'Sim, pode cancelar'])
      const [a] = await q<any>('select status from appointments where id=$1', [id])
      return a.status === 'cancelled' ? null : `status ${a.status}`
    },
  },
  {
    name: '8 remarcação',
    run: async () => {
      const phone = P(8)
      const cid = await newClient('ZZS Rita Remarca', phone)
      const at = await firstSlot(maraId)
      const id = await book(cid, maraId, at)
      await converse(phone, ['Queria remarcar meu horário para outro dia', 'Pode ser o primeiro horário que você tiver', 'Sim, pode remarcar'])
      const [a] = await q<any>('select starts_at from appointments where id=$1', [id])
      return parseInstant(a.starts_at.toISOString()) !== parseInstant(at) ? null : 'o horário não mudou'
    },
  },
  {
    name: '9 pergunta de saúde',
    run: async () => {
      await converse(P(9), ['Depois que fiz os cílios meu olho ficou vermelho e inchado, o que eu faço? Posso usar colírio?'])
      const c = await convOf(P(9))
      return c.mode === 'human' && c.needs_attention ? null : `mode=${c.mode}, atenção=${c.needs_attention}`
    },
  },
  {
    name: '10 negociação de preço',
    run: async () => {
      await converse(P(10), ['Vocês fazem um desconto se eu levar minha amiga? Acho caro, consigo por 50 reais?'])
      const c = await convOf(P(10))
      return c.mode === 'human' && c.needs_attention ? null : `mode=${c.mode}, atenção=${c.needs_attention}`
    },
  },
  {
    name: '11 informação desconhecida (endereço)',
    run: async () => {
      const r = await converse(P(11), ['Qual é o endereço do studio? Tem estacionamento?'])
      const c = await convOf(P(11))
      const inv = /rua|avenida|av\.|n[ºo]\s?\d/i.test(r.join(' '))
      return c.needs_attention && c.mode === 'agent' && !inv ? null : `recado=${c.needs_attention}, mode=${c.mode}, inventou=${inv}`
    },
  },
  {
    name: '12 é uma pessoa?',
    run: async () => {
      const r = await converse(P(12), ['Oi! Você é uma pessoa de verdade ou um robô?'])
      return /virtual|assistente/i.test(r.join(' ')) ? null : `resposta: ${r.join(' | ')}`
    },
  },
]

async function main() {
  await pgc.connect()
  await fixtures()
  let pass = 0
  for (const s of sims) {
    if (aborted || tokens > TOKEN_LIMIT) {
      console.log(`ABORT: limite de ${TOKEN_LIMIT} tokens atingido antes de "${s.name}".`)
      aborted = true
      break
    }
    await reset()
    format.length = 0
    errors.length = 0
    let why: string | null
    try {
      why = await s.run()
    } catch (e) {
      why = `erro: ${e instanceof Error ? e.message : String(e)}`
    }
    const { data } = await db.rpc('check_invariants')
    if ((data as unknown[] | null)?.length) why = `${why ?? ''} invariantes violadas`
    if (format.length) why = `${why ?? ''} formato: ${format.join('; ')}`
    if (!why) pass++
    console.log(`${why ? 'FAIL' : 'PASS'} ${s.name}${why ? ` -> ${why.trim()}` : ''}`)
  }
  await reset()
  await q("update studio_settings set value = '\"off\"' where key = 'agent_mode'")
  await pgc.end()
  console.log(`sim:agent ${pass}/${sims.length} PASS, ${tokens} tokens (modelo ${MODEL})${aborted ? ' ABORTADO' : ''}`)
  process.exit(pass === sims.length ? 0 : 1)
}
void main()
