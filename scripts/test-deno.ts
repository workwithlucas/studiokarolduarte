// Edge Functions under the real runtime (`supabase functions serve`, Docker) against the LOCAL Supabase.
// Dummy secrets only (git-ignored supabase/functions/local-secrets.txt, rewritten on every run). No real keys, no network to Z-API/Anthropic.
// Needs: supabase start. Starts the functions, runs the checks, tears everything down. Prints failures and a one-line summary only.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import pg from 'pg'

const SECRETS_FILE = 'supabase/functions/local-secrets.txt'
const EDGE_CONTAINER = 'supabase_edge_runtime_studiokarolduarte'
const WEBHOOK_SECRET = 'dummy-webhook-secret'
const CRON_SECRET = 'dummy-cron-secret'
const PHONE = '5544999999999'
const GROUP_PHONE = '120363019502650977-group'
const SETTING_KEYS = ['agent_mode', 'agent_test_numbers', 'confirmation_enabled']

let passed = 0
const failures: string[] = []
const check = (name: string, ok: boolean, extra = '') => {
  if (ok) passed++
  else failures.push(`${name}${extra ? ` (${extra})` : ''}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function localStatus(): { API_URL: string; DB_URL: string } {
  const r = spawnSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', shell: true })
  const out = r.stdout ?? ''
  try {
    return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  } catch {
    console.log('test:deno FAIL: run `supabase start` first (could not read `supabase status -o json`).')
    process.exit(1)
  }
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v as T
    await sleep(300)
  }
  return null
}

const fixture = (name: string, messageId: string, extra: Record<string, unknown> = {}) => {
  const j = JSON.parse(readFileSync(`tests/fixtures/zapi/${name}.json`, 'utf8'))
  return JSON.stringify({ ...j, messageId, ...extra })
}

async function main() {
  const status = localStatus()
  const host = new URL(status.API_URL).hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`test:deno REFUSED: Supabase host is "${host}", not local.`)
    process.exit(1)
  }
  const BASE = `${status.API_URL}/functions/v1`
  const pgc = new pg.Client({ connectionString: status.DB_URL })
  await pgc.connect()
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await pgc.query(sql, params)).rows as T[]

  // ---- dummy legacy listener
  const legacy: string[] = []
  const listener = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      legacy.push(body)
      res.end('ok')
    })
  })
  await new Promise<void>((r) => listener.listen(0, '0.0.0.0', r))
  const port = (listener.address() as { port: number }).port

  writeFileSync(
    SECRETS_FILE,
    [
      `WEBHOOK_SECRET=${WEBHOOK_SECRET}`,
      `CRON_SECRET=${CRON_SECRET}`,
      'ANTHROPIC_API_KEY=dummy-anthropic',
      'GROQ_API_KEY=dummy-groq',
      'ZAPI_INSTANCE_ID=dummy-instance',
      'ZAPI_TOKEN=dummy-token',
      'ZAPI_CLIENT_TOKEN=dummy-client-token',
      `LEGACY_WEBHOOK_URL=http://host.docker.internal:${port}/legacy`,
      '',
    ].join('\n'),
  )

  const saved = new Map<string, unknown>()
  for (const r of await q('select key, value from studio_settings where key = any($1)', [SETTING_KEYS])) saved.set(r.key, r.value)
  const setSetting = (key: string, value: unknown) =>
    q('insert into studio_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value', [key, JSON.stringify(value)])
  const cleanRows = () => q('delete from wa_conversations where phone_e164 = any($1)', [[PHONE, GROUP_PHONE]])

  let serve: ChildProcess | undefined
  let log = ''
  try {
    await cleanRows()
    serve = spawn('supabase', ['functions', 'serve', '--no-verify-jwt', '--env-file', SECRETS_FILE], { shell: true })
    serve.stdout?.on('data', (d) => (log += d))
    serve.stderr?.on('data', (d) => (log += d))
    const ready = await until(async () => /Serving functions/.test(log), 180_000)
    if (!ready) throw new Error(`functions serve did not start:\n${log.slice(-800)}`)

    const post = (path: string, body: string, headers: Record<string, string> = {}) =>
      fetch(`${BASE}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    const hook = (body: string) => post(`wa-webhook?s=${WEBHOOK_SECRET}`, body)
    const stored = async (id: string) => (await q('select 1 from wa_messages where external_id = $1', [id])).length
    const run = Date.now().toString(36)

    // ---- all four functions boot (a request loads each one)
    for (const fn of ['wa-webhook', 'agent-run', 'send-confirmations', 'wa-sweep']) {
      const r = await post(fn, '{}')
      check(`${fn} boots and answers`, r.status === 401 || r.status === 200, `HTTP ${r.status}`)
    }

    // ---- wa-webhook auth
    const bad = await post('wa-webhook?s=wrong', fixture('text', `T-${run}-bad`))
    check('wa-webhook wrong s -> 401', bad.status === 401, `HTTP ${bad.status}`)
    check('wa-webhook wrong s: nothing stored', (await stored(`T-${run}-bad`)) === 0)

    // ---- mode off: 200, stored, no LLM, no send
    await setSetting('agent_mode', 'off')
    await setSetting('agent_test_numbers', [])
    const idText = `T-${run}-text`
    const ok = await hook(fixture('text', idText))
    check('wa-webhook off: 200', ok.status === 200, `HTTP ${ok.status}`)
    check('wa-webhook off: message stored (EdgeRuntime.waitUntil works)', !!(await until(async () => (await stored(idText)) === 1)))

    // ---- group ignored
    const idGroup = `T-${run}-group`
    const g = await hook(fixture('group', idGroup))
    check('wa-webhook group: 200', g.status === 200, `HTTP ${g.status}`)

    // ---- same messageId twice -> stored once
    const dup = await hook(fixture('text', idText))
    check('wa-webhook duplicate: 200', dup.status === 200, `HTTP ${dup.status}`)
    await sleep(3_000)
    const count = (await q('select count(*)::int as n from wa_messages where external_id = $1', [idText]))[0].n
    check('wa-webhook same messageId twice: stored once', count === 1, String(count))
    check('wa-webhook group ignored: nothing stored', (await stored(idGroup)) === 0)
    check('wa-webhook group ignored: no conversation', (await q('select 1 from wa_conversations where phone_e164 = $1', [GROUP_PHONE])).length === 0)

    const outbound = (await q("select count(*)::int as n from wa_messages m join wa_conversations c on c.id = m.conversation_id where c.phone_e164 = $1 and m.direction = 'out'", [PHONE]))[0].n
    check('wa-webhook off: zero sends', outbound === 0, String(outbound))
    check('wa-webhook off: zero LLM calls (agent-run never invoked)', !/agent_run|api\.anthropic\.com/.test(log))

    // ---- mode test, phone not whitelisted -> raw body forwarded
    await setSetting('agent_mode', 'test')
    await setSetting('agent_test_numbers', ['5511900000000'])
    const rawForward = fixture('text', `T-${run}-fwd`)
    const f = await hook(rawForward)
    check('wa-webhook test (not whitelisted): 200', f.status === 200, `HTTP ${f.status}`)
    const forwarded = await until(async () => legacy.length > 0 && legacy[0])
    check('wa-webhook test (not whitelisted): raw body forwarded to legacy', forwarded === rawForward, forwarded ? 'body differs' : 'nothing received')

    // ---- fromMe -> conversation goes human (needs a phone the mode allows)
    await setSetting('agent_test_numbers', [PHONE])
    const fm = await hook(fixture('from-me', `T-${run}-fromme`))
    check('wa-webhook fromMe: 200', fm.status === 200, `HTTP ${fm.status}`)
    const human = await until(async () => (await q("select 1 from wa_conversations where phone_e164 = $1 and mode = 'human'", [PHONE])).length === 1)
    check("wa-webhook fromMe: conversation mode 'human'", !!human)

    // ---- agent-run without CRON_SECRET
    const noSecret = await post('agent-run', JSON.stringify({ conversation_id: '00000000-0000-4000-8000-000000000000' }))
    check('agent-run without CRON_SECRET -> 401', noSecret.status === 401, `HTTP ${noSecret.status}`)

    // ---- send-confirmations disabled -> zero sends
    await setSetting('agent_mode', 'live')
    await setSetting('confirmation_enabled', false)
    const confBefore = (await q('select count(*)::int as n from wa_confirmations'))[0].n
    const outBefore = (await q("select count(*)::int as n from wa_messages where direction = 'out'"))[0].n
    const sc = await post('send-confirmations', '{}', { 'x-cron-secret': CRON_SECRET })
    check('send-confirmations disabled: 200', sc.status === 200, `HTTP ${sc.status}`)
    await sleep(3_000)
    const confAfter = (await q('select count(*)::int as n from wa_confirmations'))[0].n
    const outAfter = (await q("select count(*)::int as n from wa_messages where direction = 'out'"))[0].n
    check('send-confirmations disabled: zero sends', confAfter === confBefore && outAfter === outBefore && !/"sent":[1-9]/.test(log))

    // ---- no import or runtime errors in the runtime log
    const errs = log.split('\n').filter((l) => /error|failed|not defined|Uncaught/i.test(l) && !/legacy_forward_failed/.test(l))
    check('runtime log has no import/runtime errors', errs.length === 0, errs.slice(0, 2).join(' | ').slice(0, 300))
  } finally {
    serve?.kill()
    if (serve?.pid) spawnSync('taskkill', ['/PID', String(serve.pid), '/T', '/F'], { shell: true })
    spawnSync('docker', ['rm', '-f', EDGE_CONTAINER], { shell: true })
    listener.close()
    for (const k of SETTING_KEYS) {
      if (saved.has(k)) await setSetting(k, saved.get(k))
      else await q('delete from studio_settings where key = $1', [k])
    }
    await cleanRows()
    await pgc.end()
    rmSync(SECRETS_FILE, { force: true })
  }
}

main()
  .catch((e) => failures.push(`erro inesperado: ${e instanceof Error ? e.message : String(e)}`))
  .finally(() => {
    for (const f of failures) console.log(`FAIL ${f}`)
    console.log(`test:deno ${failures.length === 0 ? 'PASS' : 'FAIL'} (${passed} ok, ${failures.length} falhas)`)
    process.exit(failures.length === 0 ? 0 : 1)
  })
