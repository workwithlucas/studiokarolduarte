// Full backup (schema + data) of the database in DATABASE_URL. Reads DATABASE_URL from the process env only.
// Usage (PowerShell):  $env:DATABASE_URL = Read-Host "DATABASE_URL"; npm run backup
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const KEEP = 8
const url = process.env.DATABASE_URL
if (!url) {
  console.log('backup FAIL: DATABASE_URL não definida.')
  console.log('No PowerShell (a senha fica só nesta sessão):')
  console.log('  $env:DATABASE_URL = Read-Host "Cole a DATABASE_URL (Supabase > Connect > Session pooler)"')
  console.log('  npm run backup')
  process.exit(1)
}

// The Supabase CLI installed by npm is a .cmd shim on Windows, which needs a shell; the URL is quoted for it.
const win = process.platform === 'win32'
const dump = (extra: string[]) =>
  spawnSync('supabase', ['db', 'dump', '--db-url', win ? `"${url}"` : url, ...extra], { encoding: 'utf8', shell: win })

const dir = 'backups'
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

const d = new Date()
const p = (n: number) => String(n).padStart(2, '0')
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
const file = join(dir, `backup-${stamp}.sql`)

// `supabase db dump` writes schema by default; the data-only dump is appended to the same file so the backup restores both.
const schema = dump(['-f', file])
if (schema.status !== 0) {
  console.log(`backup FAIL (schema): ${(schema.stderr || schema.stdout || '').trim().split('\n').slice(-3).join(' | ').replace(url, '<DATABASE_URL>')}`)
  process.exit(1)
}
const dataFile = `${file}.data`
const data = dump(['--data-only', '--use-copy', '-f', dataFile])
if (data.status !== 0) {
  console.log(`backup FAIL (data): ${(data.stderr || data.stdout || '').trim().split('\n').slice(-3).join(' | ').replace(url, '<DATABASE_URL>')}`)
  process.exit(1)
}
appendFileSync(file, `\n-- ---------------------------------------------------------------- DATA\n${readFileSync(dataFile, 'utf8')}`)
unlinkSync(dataFile)

const all = readdirSync(dir).filter((f) => /^backup-\d{8}-\d{4}\.sql$/.test(f)).sort()
for (const old of all.slice(0, Math.max(0, all.length - KEEP))) unlinkSync(join(dir, old))

const kb = statSync(file).size / 1024
console.log(`backup OK ${file} (${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`}), mantidos os últimos ${Math.min(all.length, KEEP)}`)
