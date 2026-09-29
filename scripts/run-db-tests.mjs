// Runs pgTAP via the Supabase CLI. Prints failures and a one-line summary only.
import { spawnSync } from 'node:child_process'

const r = spawnSync('supabase', ['test', 'db'], { encoding: 'utf8', shell: true })
const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
const lines = out.split(/\r?\n/)

const noise = /new version|recommend updating|Pulling|Pull complete|Download|Digest|Status:|Already exists|^public\.ecr|Connecting to local|^\s*$/
const failures = lines.filter(
  (l) => !noise.test(l) && !/^(Files=|Result:|All \d+ subtests passed|Test Summary Report|-{5,})/.test(l),
)

const tests = /Tests=(\d+)/.exec(out)?.[1] ?? '?'
const ok = r.status === 0 && /Result: PASS/.test(out)
if (!ok) console.log(failures.join('\n'))
console.log(`test:db ${ok ? 'PASS' : 'FAIL'} (${tests} assertions)`)
process.exit(ok ? 0 : 1)
