import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeCsv, parseCsv } from './clients'
import {
  DEFAULT_DESCRIPTION,
  matchClient,
  matchHeaders,
  planReceivables,
  receivableKey,
  receivableProblemsToCsv,
  runReceivableImport,
  type CreateArgs,
  type KnownClient,
} from './receivables'

const CLIENTS: KnownClient[] = [
  { id: 'c-maria', name: 'ZZ Maria Aparecida Souza', phone_e164: '5511981110001' },
  { id: 'c-ana', name: 'ZZ Ana Clara Souza', phone_e164: '5511981110001' },
  { id: 'c-tere', name: 'ZZ Terezinha Alves', phone_e164: '5511982220002' },
  { id: 'c-joao', name: 'ZZ João Batista Lima', phone_e164: '5511983330003' },
  { id: 'c-joana', name: 'ZZ Joana Ferreira', phone_e164: '5521995550005' },
  { id: 'c-carla', name: 'ZZ Carla Crédito', phone_e164: '5511987770007' },
  { id: 'c-lu', name: 'ZZ Luíza Conceição', phone_e164: '5511971110010' },
  { id: 'c-angela', name: 'ZZ Ângela Ávila', phone_e164: '5511973330012' },
]
const parsed = () => parseCsv(decodeCsv(readFileSync('tests/fixtures/receivables-sample.csv')))

describe('headers', () => {
  it('maps cliente|nome, vencimento|data, valor, descricao|obs', () => {
    const m = matchHeaders(['Nome', 'Data', 'Valor', 'Obs'])
    expect(m.missing).toEqual([])
    expect(m.index).toEqual({ client: 0, due: 1, amount: 2, description: 3 })
    expect(matchHeaders(['Cliente', 'Vencimento', 'Valor', 'Descrição']).index.description).toBe(3)
  })
  it('reports the required columns that are missing', () => {
    expect(matchHeaders(['cliente', 'valor']).missing).toEqual(['due'])
  })
})

describe('client matching (never creates)', () => {
  it('exact name, accents and case ignored', () => {
    expect(matchClient(CLIENTS, 'zz joao batista lima', null)).toEqual({ id: 'c-joao' })
  })
  it('similar spelling matches when it is the only candidate', () => {
    expect(matchClient(CLIENTS, 'ZZ Teresinha Alves', null)).toEqual({ id: 'c-tere' })
  })
  it('unknown name is a reason, not a match', () => {
    expect(matchClient(CLIENTS, 'ZZ Cliente Inexistente', null)).toEqual({ reason: 'Cliente não encontrada' })
  })
  it('two clients with the same name are ambiguous', () => {
    const twins = [...CLIENTS, { id: 'c-maria2', name: 'ZZ Maria Aparecida Souza', phone_e164: null }]
    expect(matchClient(twins, 'ZZ Maria Aparecida Souza', null)).toEqual({ reason: 'Nome ambíguo (2 clientes)' })
  })
  it('a phone disambiguates twins', () => {
    const twins = [...CLIENTS, { id: 'c-maria2', name: 'ZZ Maria Aparecida Souza', phone_e164: null }]
    expect(matchClient(twins, 'ZZ Maria Aparecida Souza', '5511981110001')).toEqual({ id: 'c-maria' })
  })
})

describe('plan', () => {
  it('plans the fixture: 6 rows, 4 skipped with reasons', async () => {
    const plan = await planReceivables(parsed(), CLIENTS)
    expect(plan.missing).toEqual([])
    expect(plan.totals).toEqual({ rows: 10, toImport: 6, skipped: 4 })
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'Cliente não encontrada',
      'Vencimento inválido (31/02/2031)',
      'Valor inválido (abc)',
      'Cliente em branco',
    ])
    expect(plan.skipped.map((s) => s.line)).toEqual([8, 9, 10, 11])
  })

  it('parses dates and money', async () => {
    const plan = await planReceivables(parsed(), CLIENTS)
    const byClient = Object.fromEntries(plan.rows.map((r) => [r.clientId, r]))
    expect(byClient['c-maria']).toMatchObject({ due: '2031-10-15', amountCents: 15000, description: 'Alongamento pendente' })
    expect(byClient['c-ana']).toMatchObject({ due: '2031-10-20', amountCents: 8050 })
    expect(byClient['c-tere']).toMatchObject({ amountCents: 120000 })
    expect(byClient['c-joao']).toMatchObject({ amountCents: 4500, description: DEFAULT_DESCRIPTION })
  })

  it('reports missing required columns without rows', async () => {
    const plan = await planReceivables({ delimiter: ';', headers: ['cliente', 'valor'], rows: [['A', '1']] }, CLIENTS)
    expect(plan.missing).toEqual(['due'])
    expect(plan.rows).toEqual([])
  })

  it('the key is the sha256 of client|due|amount|description and is stable', async () => {
    const a = await receivableKey('c1', '2031-10-15', 15000, 'x')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await receivableKey('c1', '2031-10-15', 15000, 'x')).toBe(a)
    expect(await receivableKey('c1', '2031-10-15', 15001, 'x')).not.toBe(a)
    const plan = await planReceivables(parsed(), CLIENTS)
    expect(plan.rows[0]!.key).toBe(await receivableKey('c-maria', '2031-10-15', 15000, 'Alongamento pendente'))
  })
})

describe('run', () => {
  it('chunks of 25, idempotent on the second run', async () => {
    const plan = await planReceivables(parsed(), CLIENTS)
    const db = new Map<string, string>() // key -> id
    const create = async (a: CreateArgs) => {
      if (!db.has(a.p_import_key)) db.set(a.p_import_key, `e${db.size + 1}`)
      return db.get(a.p_import_key)!
    }
    const progress: number[] = []
    const first = await runReceivableImport(plan, create, new Set(), (d) => progress.push(d))
    expect(first).toMatchObject({ created: 6, alreadyThere: 0 })
    expect(first.skipped).toHaveLength(4)
    expect(progress.at(-1)).toBe(6)
    const second = await runReceivableImport(plan, create, new Set(db.keys()))
    expect(second).toMatchObject({ created: 0, alreadyThere: 6 })
    expect(db.size).toBe(6)
  })

  it('sends income entries that are open (no payment) with the import key', async () => {
    const plan = await planReceivables(parsed(), CLIENTS)
    const sent: CreateArgs[] = []
    await runReceivableImport(plan, async (a) => (sent.push(a), 'id'), new Set())
    expect(sent).toHaveLength(6)
    expect(sent.every((a) => a.p_kind === 'income' && a.p_pay_now === false && a.p_method === null && a.p_import_key.length === 64)).toBe(true)
  })

  it('collects errors per row and keeps going', async () => {
    const plan = await planReceivables(parsed(), CLIENTS)
    let n = 0
    const r = await runReceivableImport(plan, async () => {
      if (++n === 2) throw new Error('boom')
      return `id${n}`
    }, new Set())
    expect(r.created).toBe(5)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ line: 3, reason: 'boom' })
  })

  it('problems CSV lists skipped and errors sorted by line', async () => {
    const csv = receivableProblemsToCsv({
      skipped: [{ line: 8, client: 'X', reason: 'Cliente não encontrada' }],
      errors: [{ line: 3, client: 'Y', reason: 'boom' }],
    })
    expect(csv.split('\r\n')).toEqual(['linha,cliente,tipo,motivo', '3,Y,erro,boom', '8,X,ignorada,Cliente não encontrada'])
  })
})
