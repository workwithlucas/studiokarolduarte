import { describe, expect, it } from 'vitest'
import { ERROR_MESSAGES as SERVER, messageOfCode } from '../../supabase/functions/_shared/errors-pt.ts'
import { ERROR_MESSAGES as CLIENT } from '../../src/lib/rpc'

describe('errors-pt matches src/lib/rpc.ts', () => {
  it('same codes', () => {
    expect(Object.keys(SERVER).sort()).toEqual(Object.keys(CLIENT).sort())
  })
  it('same pt-BR text for every code', () => {
    for (const [code, text] of Object.entries(CLIENT)) expect(SERVER[code]).toBe(text)
  })
  it('messageOfCode falls back to the database text, then to a generic sentence', () => {
    expect(messageOfCode('HAS_PAYMENTS')).toBe(CLIENT.HAS_PAYMENTS)
    expect(messageOfCode('NOPE', ' Texto do banco ')).toBe('Texto do banco')
    expect(messageOfCode(null)).toBe('Algo deu errado. Tente novamente.')
  })
})
