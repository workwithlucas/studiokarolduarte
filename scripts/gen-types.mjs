// Generates src/types/db.ts from the local Supabase database (UTF-8, no shell redirection).
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const r = spawnSync('supabase', ['gen', 'types', 'typescript', '--local'], { encoding: 'utf8', shell: true })
if (r.status !== 0) {
  console.log(`gen:types FAIL: ${r.stderr}`)
  process.exit(1)
}
mkdirSync('src/types', { recursive: true })
writeFileSync('src/types/db.ts', r.stdout, 'utf8')
console.log('gen:types OK -> src/types/db.ts')
