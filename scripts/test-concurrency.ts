// 10 parallel rpc_book_appointment on the same slot -> 1 success, 9 SLOT_TAKEN.
// Uses the local Supabase database only. Prints failures and a one-line summary.
import pg from 'pg'

const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const PARALLEL = 10

async function main() {
  const admin = new pg.Client({ connectionString: DB_URL })
  await admin.connect()

  const one = async <T = string>(sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows[0] as T

  const mara = (await one<{ id: string }>(`select id from professionals where name = 'Mara'`)).id
  const svc = (await one<{ id: string }>(
    `select rpc_upsert_service(null,'ZZ concorrência','outros','standard',60,5000,null,null,null,true) as id`,
  )).id
  await admin.query(`select rpc_set_professional_services($1, (select array_agg(service_id) from professional_services where professional_id = $1) || $2::uuid)`, [mara, svc])
  const client = (await one<{ id: string }>(`select rpc_upsert_client('ZZ Concorrência','11 90000-0000',null,null,null) as id`)).id
  const slot = (await one<{ ts: string }>(
    `select (((today_sp() + 7 + ((8 - extract(dow from today_sp() + 7)::int) % 7)) + time '15:00') at time zone 'America/Sao_Paulo') as ts`,
  )).ts

  const clients = await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      const c = new pg.Client({ connectionString: DB_URL })
      await c.connect()
      return c
    }),
  )

  const results = await Promise.all(
    clients.map(async (c, i) => {
      try {
        const r = await c.query(
          `select rpc_book_appointment($1,$2,$3,'placement','{}'::uuid[],$4,'staff',$5,null) as id`,
          [client, mara, svc, slot, `concurrency-${Date.now()}-${i}`],
        )
        return { ok: true as const, id: r.rows[0].id as string }
      } catch (e) {
        return { ok: false as const, code: (e as Error).message }
      }
    }),
  )
  await Promise.all(clients.map((c) => c.end()))

  const successes = results.filter((r) => r.ok).length
  const taken = results.filter((r) => !r.ok && r.code === 'SLOT_TAKEN').length
  const others = results.filter((r) => !r.ok && r.code !== 'SLOT_TAKEN').map((r) => (r as { code: string }).code)
  const ledger = Number(
    (await one<{ n: string }>(
      `select count(*) as n from ledger_entries l join appointments a on a.id = l.appointment_id
       where a.service_id = $1 and l.voided_at is null`,
      [svc],
    )).n,
  )
  const invariants = Number((await one<{ n: string }>(`select count(*) as n from check_invariants()`)).n)

  // cleanup: remove everything this script created
  await admin.query(`delete from ledger_entries where client_id = $1`, [client])
  await admin.query(`delete from appointments where client_id = $1`, [client])
  await admin.query(`delete from clients where id = $1`, [client])
  await admin.query(`delete from professional_services where service_id = $1`, [svc])
  await admin.query(`delete from services where id = $1`, [svc])
  await admin.query(`delete from audit_log where entity_id = $1 or entity_id = $2`, [client, svc])
  await admin.end()

  const pass = successes === 1 && taken === PARALLEL - 1 && ledger === 1 && invariants === 0
  if (!pass) {
    console.log(`expected 1 success + ${PARALLEL - 1} SLOT_TAKEN, 1 ledger entry, 0 invariant rows`)
    if (others.length) console.log(`unexpected errors: ${others.join(', ')}`)
  }
  console.log(`test:concurrency ${pass ? 'PASS' : 'FAIL'} (${successes} success, ${taken} SLOT_TAKEN, ${ledger} ledger, ${invariants} invariants)`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.log(`test:concurrency FAIL: ${(e as Error).message}`)
  process.exit(1)
})
