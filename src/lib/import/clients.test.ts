import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  creditNote,
  decodeCsv,
  detectDelimiter,
  errorsToCsv,
  matchHeaders,
  nameSimilarity,
  normalizeHeader,
  normalizePhone,
  parseBirthday,
  parseCreditCents,
  parseCsv,
  planImport,
  runImport,
} from './clients'

const fixture = () => readFileSync('tests/fixtures/clients-sample.csv')

describe('decode', () => {
  it('strips the UTF-8 BOM and keeps accents', () => {
    const text = decodeCsv(fixture())
    expect(text.startsWith('nome;')).toBe(true)
    expect(text).toContain('João')
    expect(text).not.toContain('�')
  })

  it('falls back to windows-1252 when UTF-8 yields replacement characters', () => {
    const bytes = Uint8Array.from([0x4a, 0x6f, 0x73, 0xe9, 0x3b, 0x31]) // "José;1" in windows-1252
    expect(decodeCsv(bytes)).toBe('José;1')
  })
})

describe('delimiter', () => {
  it.each([
    ['nome,telefone,obs', ','],
    ['nome;telefone;obs', ';'],
    ['nome\ttelefone\tobs', '\t'],
    ['"a;b",telefone,obs', ','],
  ])('%j -> %j', (line, d) => expect(detectDelimiter(line)).toBe(d))

  it('parses the fixture as semicolon with 14 data rows', () => {
    const p = parseCsv(decodeCsv(fixture()))
    expect(p.delimiter).toBe(';')
    expect(p.headers).toEqual(['nome', 'telefone', 'aniversario', 'codigo', 'observacoes', 'credito'])
    expect(p.rows).toHaveLength(14)
  })
})

describe('headers', () => {
  it('normalizes accents, case and spaces', () => {
    expect(normalizeHeader(' Aniversário ')).toBe('aniversario')
    expect(normalizeHeader('Código Externo')).toBe('codigo_externo')
    expect(normalizeHeader('Crédito Loja')).toBe('credito_loja')
  })

  it('maps aliases', () => {
    const m = matchHeaders(['Name', 'Celular', 'Nascimento', 'COD', 'Obs', 'Crédito Loja'])
    expect(m.index).toEqual({ name: 0, phone: 1, birthday: 2, external_code: 3, notes: 4, credit: 5 })
    expect(m.missing).toEqual([])
  })

  it('requires nome', () => {
    expect(matchHeaders(['telefone']).missing).toEqual(['name'])
  })
})

describe('field parsers', () => {
  it.each([
    ['14/03/1985', '1985-03-14'],
    ['1985-03-14', '1985-03-14'],
    ['29/02/2000', '2000-02-29'],
    ['31/02/1999', null],
    ['29/02/1900', null],
    ['14-03-1985', null],
    ['', null],
    ['lixo', null],
  ])('birthday %j -> %j', (i, o) => expect(parseBirthday(i)).toBe(o))

  it.each([
    ['(11) 98888-0001', '5511988880001'],
    ['+55 11 98888-0001', '5511988880001'],
    ['011 98888-0001', '5511988880001'],
    ['1198888000', '551198888000'],
    ['12345', null],
  ])('phone %j -> %j', (i, o) => expect(normalizePhone(i)).toBe(o))

  it.each([
    ['R$ 150,00', 15000],
    ['1.234,56', 123456],
    ['12.50', 1250],
    ['0', 0],
    ['abc', null],
    ['', null],
  ])('credit %j -> %j', (i, o) => expect(parseCreditCents(i)).toBe(o))

  it('credit note text', () => expect(creditNote(15000)).toBe('Crédito em loja: R$ 150,00'))

  it('Terezinha/Teresinha are similar; mother/daughter are not', () => {
    expect(nameSimilarity('Terezinha Alves', 'Teresinha Alves')).toBeGreaterThanOrEqual(0.82)
    expect(nameSimilarity('Maria Aparecida Souza', 'Ana Clara Souza')).toBeLessThan(0.82)
  })
})

describe('plan', () => {
  const plan = planImport(parseCsv(decodeCsv(fixture())), [])
  const byName = (n: string) => plan.rows.find((r) => r.name === n)!

  it('totals', () => {
    expect(plan.totals).toEqual({ rows: 14, create: 11, match: 2, warnings: 2, skipped: 1 })
  })

  it('blank name is skipped', () => expect(plan.rows.find((r) => r.status === 'skip')?.warnings).toEqual(['Nome em branco']))
  it('mother and daughter share a phone but are separate', () => {
    expect(byName('ZZ Maria Aparecida Souza').status).toBe('create')
    expect(byName('ZZ Ana Clara Souza').status).toBe('create')
  })
  it('Terezinha/Teresinha collapse', () => {
    expect(byName('ZZ Terezinha Alves').status).toBe('create')
    expect(byName('ZZ Teresinha Alves').status).toBe('match')
  })
  it('duplicate external code matches the first', () => expect(byName('ZZ Duplicada de Código').status).toBe('match'))
  it('invalid phone imports without phone and warns', () => {
    const r = byName('ZZ Telefone Inválido')
    expect(r.phone).toBeNull()
    expect(r.status).toBe('create')
    expect(r.warnings).toHaveLength(1)
  })
  it('credit is appended to notes', () => expect(byName('ZZ Carla Crédito').notes).toBe('Cliente VIP\nCrédito em loja: R$ 150,00'))
  it('zero credit adds nothing', () => expect(byName('ZZ Maria Aparecida Souza').notes).toBe('Prefere manhã'))
  it('invalid birthday warns', () => {
    expect(byName('ZZ Beatriz Nascimento').birthday).toBeNull()
    expect(byName('ZZ Beatriz Nascimento').warnings).toHaveLength(1)
  })
  it('missing name column', () => expect(planImport(parseCsv('telefone\n11988880000'), []).missing).toEqual(['name']))

  it('everything matches when the clients already exist', () => {
    const existing = plan.rows
      .filter((r) => r.status === 'create')
      .map((r) => ({ name: r.name, phone_e164: r.phone, external_code: r.externalCode }))
    const again = planImport(parseCsv(decodeCsv(fixture())), existing)
    expect(again.totals.create).toBe(0)
  })
})

describe('run', () => {
  it('counts created/matched via ids, chunks and reports errors', async () => {
    const plan = planImport(parseCsv('nome;telefone\nA;11988880001\nB;11988880002\nC;11988880003\nD;11988880004'), [])
    const progress: number[] = []
    const r = await runImport(
      plan,
      async (a) => {
        if (a.p_name === 'C') throw new Error('falhou')
        return a.p_name === 'D' ? 'id-A' : `id-${a.p_name}`
      },
      new Set(['id-B']),
      (done) => progress.push(done),
      2,
    )
    expect(r).toMatchObject({ created: 1, matched: 2, skipped: 0 })
    expect(r.errors).toEqual([{ line: 4, name: 'C', message: 'falhou' }])
    expect(progress).toEqual([0, 2, 4])
    expect(errorsToCsv(r.errors)).toContain('linha,nome,erro')
  })
})
