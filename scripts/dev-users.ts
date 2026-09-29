// Creates the local demo users and links them to the seeded professionals. Idempotent.
// Runs only against a local Supabase (host 127.0.0.1 or localhost). Local demo credentials only.
import { createClient } from '@supabase/supabase-js'
import { spawnSync } from 'node:child_process'
import pg from 'pg'

export const DEV_PASSWORD = 'studio-dev-123'
const USERS = [
  { email: 'karol@studio.test', professional: 'Karol Duarte', role: 'owner' },
  { email: 'mara@studio.test', professional: 'Mara', role: 'professional' },
  { email: 'milena@studio.test', professional: 'Milena', role: 'professional' },
]

function localStatus(): { API_URL: string; SERVICE_ROLE_KEY: string; DB_URL: string } {
  const r = spawnSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', shell: true })
  const out = r.stdout ?? ''
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  try {
    return JSON.parse(json)
  } catch {
    console.log('dev:users FAIL: run `supabase start` first (could not read `supabase status -o json`).')
    process.exit(1)
  }
}

async function main() {
  const status = localStatus()
  const host = new URL(status.API_URL).hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`dev:users REFUSED: Supabase host is "${host}", not local.`)
    process.exit(1)
  }

  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const db = new pg.Client({ connectionString: status.DB_URL })
  await db.connect()

  const existing = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (existing.error) throw existing.error

  for (const u of USERS) {
    let id = existing.data.users.find((x) => x.email === u.email)?.id
    if (id) {
      const r = await admin.auth.admin.updateUserById(id, { password: DEV_PASSWORD, email_confirm: true })
      if (r.error) throw r.error
    } else {
      const r = await admin.auth.admin.createUser({ email: u.email, password: DEV_PASSWORD, email_confirm: true })
      if (r.error || !r.data.user) throw r.error ?? new Error('createUser failed')
      id = r.data.user.id
    }
    const upd = await db.query('update professionals set user_id = $1 where name = $2', [id, u.professional])
    if (upd.rowCount !== 1) throw new Error(`professional "${u.professional}" not found (run supabase db reset)`)
  }
  await db.end()

  console.log('dev:users OK (local only)')
  for (const u of USERS) console.log(`  ${u.email}  /  ${DEV_PASSWORD}  (${u.role})`)
}

main().catch((e) => {
  console.log(`dev:users FAIL: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
