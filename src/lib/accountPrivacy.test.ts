// The agent never sees client credit or debt: not in its prompt, tools, context or gates.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = 'supabase/functions'
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('agent: no credit or debt exposure', () => {
  const forbidden = /credit_balance|open_debt|client_account|rpc_get_client_account|rpc_settle_client_account|rpc_add_client_credit|v_client_account|saldo anterior|crédito da cliente|em aberto/i
  // The owner-only finance assistant (Task 15) is not the agent: it exists to show the owner credit and debt.
  // The rule below is that Thaís's code never touches it, so the two sets stay apart (checked by the last test).
  const OWNER_ASSISTANT = /[\\/](assistant[^\\/]*\.ts|errors-pt\.ts)$|[\\/]assistant-chat[\\/]/
  const all = sources(DIR)
  const files = all.filter((f) => !OWNER_ASSISTANT.test(f))

  it('finds the agent sources', () => {
    expect(files.length).toBeGreaterThan(5)
    expect(files.some((f) => f.endsWith('prompt.ts'))).toBe(true)
  })

  it.each(files)('%s mentions no credit or debt value', (f) => {
    expect(readFileSync(f, 'utf8')).not.toMatch(forbidden)
  })

  it('no agent file imports the owner assistant or its shared error texts', () => {
    for (const f of files.filter((x) => !x.includes('_deno'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/from '\.\.?\/(_shared\/)?(assistant[\w-]*|errors-pt)(\.ts)?'/)
    }
  })

  it('the client-context migration only adds spend for owner/agent and nothing about credit', () => {
    const sql = readFileSync('supabase/migrations/20261001120000_crm_packages.sql', 'utf8')
    const fn = sql.slice(sql.indexOf('function rpc_get_client_context'), sql.indexOf('rpc_void_package'))
    expect(fn).not.toMatch(/credit|debt|balance/i)
  })
})
