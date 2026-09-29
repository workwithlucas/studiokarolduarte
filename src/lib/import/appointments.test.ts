import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  idempotencyKey,
  matchHeaders,
  parseHHMM,
  parseWhen,
  parseYMD,
  planAppointments,
  problemsToCsv,
  runAppointmentImport,
  serviceCandidates,
  type BookArgs,
  type ImportContext,
} from './appointments'
import { decodeCsv, parseCsv } from './clients'

const NOW = Date.parse('2026-09-29T12:00:00-03:00')
const MARA = { id: 'pro-mara', name: 'Mara', active: true }
const SVC = {
  id: 'svc-1',
  name: 'ZZ Import Serviço',
  kind: 'standard',
  duration_min: 60,
  price_cents: 5000,
  maintenance_duration_min: 45,
  maintenance_price_cents: 3000,
  active: true,
}
const REM = { id: 'svc-2', name: 'ZZ Import Remoção', kind: 'removal', duration_min: 30, price_cents: 2000, maintenance_duration_min: null, maintenance_price_cents: null, active: true }
const ctx = (over: Partial<ImportContext> = {}): ImportContext => ({
  services: [SVC, REM],
  professionals: [MARA, { id: 'pro-karol', name: 'Karol Duarte', active: true }],
  links: new Set(['pro-mara|svc-1', 'pro-mara|svc-2']),
  clients: [],
  ...over,
})
const fixture = () => {
  const p = parseCsv(decodeCsv(readFileSync('tests/fixtures/appointments-sample.csv')))
  return { headers: p.headers, rows: p.rows }
}

describe('headers', () => {
  it('matches aliases without accents or case, date + time columns', () => {
    const m = matchHeaders(['NOME', 'Celular', 'Data', 'Hora', 'Procedimento', 'Colaborador', 'Preço', 'Obs'])
    expect(m.missing).toEqual([])
    expect(m.index.client).toBe(0)
    expect(m.index.time).toBe(3)
    expect(m.index.price).toBe(6)
  })
  it('reports required columns that are missing', () => {
    expect(matchHeaders(['cliente', 'servico']).missing).toEqual(['inicio', 'profissional'])
  })
  it('data_hora and horario are the start column', () => {
    expect(matchHeaders(['cliente', 'data_hora', 'servico', 'profissional']).missing).toEqual([])
    expect(matchHeaders(['cliente', 'Horário', 'servico', 'profissional']).index.start).toBe(1)
  })
})

describe('date and time', () => {
  it('parses BR and ISO dates and times', () => {
    expect(parseYMD('10/03/2031')).toBe('2031-03-10')
    expect(parseYMD('31/02/2031')).toBeNull()
    expect(parseHHMM('9h30')).toBe('09:30')
    expect(parseHHMM('14h')).toBe('14:00')
    expect(parseHHMM('25:00')).toBeNull()
  })
  it('one cell, or separate date and time', () => {
    expect(parseWhen('10/03/2031 09:00', '', '')).toBe('2031-03-10T09:00:00-03:00')
    expect(parseWhen('2031-03-10T09:00', '', '')).toBe('2031-03-10T09:00:00-03:00')
    expect(parseWhen('', '10/03/2031', '9:30')).toBe('2031-03-10T09:30:00-03:00')
    expect(parseWhen('09:30', '10/03/2031', '')).toBe('2031-03-10T09:30:00-03:00')
    expect(parseWhen('lixo', '', '')).toBeNull()
  })
})

describe('service name', () => {
  it('prefix decides the action', () => {
    expect(serviceCandidates('Manutenção Blindagem')).toEqual({ prefix: 'maintenance', names: ['blindagem', 'manutencao blindagem'] })
    expect(serviceCandidates('REMOÇÃO de Gel').prefix).toBe('removal')
    expect(serviceCandidates('Blindagem').prefix).toBeNull()
  })
})

describe('plan', () => {
  const plan = planAppointments(fixture(), ctx(), { now: NOW })
  const reasonOf = (client: string) => plan.skipped.find((s) => s.client === client)?.reason ?? ''

  it('lists skipped rows with a reason, and never creates services or professionals', () => {
    expect(reasonOf('ZZ Imp Dani')).toMatch(/Serviço não encontrado/)
    expect(reasonOf('ZZ Imp Eva')).toMatch(/Profissional não encontrada/)
    expect(reasonOf('ZZ Imp Fabi')).toMatch(/passado/)
    expect(reasonOf('ZZ Imp Hana')).toMatch(/cancelado/)
    expect(plan.totals.skipped).toBe(4)
    expect(plan.totals.create).toBe(10)
    expect(plan.totals.rows).toBe(14)
  })
  it('action from prefix; duration and price from the catalog', () => {
    const bia = plan.rows.find((r) => r.clientName === 'ZZ Imp Bia')!
    expect(bia).toMatchObject({ action: 'maintenance', durationMin: 45, priceCents: 3000 })
    expect(bia.warnings.join(' ')).toMatch(/Valor do arquivo/)
    expect(bia.warnings.join(' ')).toMatch(/Duração do arquivo/)
    const iris = plan.rows.find((r) => r.clientName === 'ZZ Imp Iris')!
    expect(iris).toMatchObject({ action: 'removal', phone: '5511966660009' })
    expect(plan.rows.find((r) => r.clientName === 'ZZ Imp Kelly')).toMatchObject({ action: 'placement', priceCents: 5000, phone: '5511966660011' })
  })
  it('an accent-less lowercase service and a lowercase professional match', () => {
    expect(plan.rows.find((r) => r.clientName === 'ZZ Imp Julia')?.startsAt).toBe('2031-03-13T09:30:00-03:00')
  })
  it('a new client appears once in newClients however many rows it has', () => {
    const ana = plan.rows.filter((r) => r.clientName === 'ZZ Imp Ana')
    expect(ana).toHaveLength(3)
    expect(new Set(ana.map((r) => r.clientRef)).size).toBe(1)
    expect(plan.totals.newClients).toBe(8)
    expect(plan.totals.matchedClients).toBe(2)
  })
  it('invalid phone is a warning, not a skip', () => {
    expect(plan.rows.find((r) => r.clientName === 'ZZ Imp Luiza')).toMatchObject({ phone: null })
    expect(plan.rows.find((r) => r.clientName === 'ZZ Imp Luiza')?.warnings.join(' ')).toMatch(/Telefone inválido/)
  })
  it('past rows come in only when asked', () => {
    const p = planAppointments(fixture(), ctx(), { now: NOW, includePast: true })
    expect(p.totals.create).toBe(11)
  })
  it('never matches a client on phone alone', () => {
    const p = planAppointments(fixture(), ctx({ clients: [{ id: 'c1', name: 'Outra Pessoa Totalmente', phone_e164: '5511966660001', external_code: null }] }), { now: NOW })
    expect(p.rows.find((r) => r.clientName === 'ZZ Imp Ana')?.isNewClient).toBe(true)
  })
  it('matches an existing client by phone and similar name', () => {
    const p = planAppointments(fixture(), ctx({ clients: [{ id: 'c1', name: 'ZZ Imp Ana', phone_e164: '5511966660001', external_code: null }] }), { now: NOW })
    expect(p.rows.filter((r) => r.clientName === 'ZZ Imp Ana').every((r) => r.clientId === 'c1')).toBe(true)
  })
  it('skips a professional not linked to the service and a service without maintenance', () => {
    const p = planAppointments(fixture(), ctx({ links: new Set() }), { now: NOW })
    expect(p.totals.create).toBe(0)
    const noMaint = planAppointments(fixture(), ctx({ services: [{ ...SVC, maintenance_price_cents: null }, REM] }), { now: NOW })
    expect(noMaint.skipped.find((s) => s.client === 'ZZ Imp Bia')?.reason).toMatch(/não tem manutenção/)
  })
  it('missing required columns produce no rows', () => {
    const p = planAppointments({ headers: ['cliente'], rows: [['x']] }, ctx(), { now: NOW })
    expect(p.missing).toEqual(['inicio', 'servico', 'profissional'])
  })
})

describe('run', () => {
  function fakes() {
    const clients = new Map<string, string>()
    const booked = new Map<string, BookArgs>()
    let n = 0
    return {
      booked,
      deps: (existingKeys: ReadonlySet<string> = new Set()) => ({
        existingKeys,
        upsertClient: async (a: { p_name: string; p_phone: string | null }) => {
          const k = `${a.p_name}|${a.p_phone}`
          if (!clients.has(k)) clients.set(k, `client-${++n}`)
          return clients.get(k)!
        },
        book: async (a: BookArgs) => {
          const clash = [...booked.values()].some(
            (b) => b.p_professional_id === a.p_professional_id && Math.abs(Date.parse(b.p_starts_at) - Date.parse(a.p_starts_at)) < 3_600_000,
          )
          if (clash) throw Object.assign(new Error('Este horário já está ocupado.'), { code: 'SLOT_TAKEN' })
          booked.set(a.p_idempotency_key, a)
          return a.p_idempotency_key
        },
      }),
    }
  }

  it('books with staff source, force and a sha256 idempotency key; overlap and duplicate are handled', async () => {
    const f = fakes()
    const plan = planAppointments(fixture(), ctx(), { now: NOW })
    const progress: number[] = []
    const r = await runAppointmentImport(plan, f.deps(), (d) => progress.push(d), 4)
    expect(r.created).toBe(8)
    expect(r.alreadyThere).toBe(1)
    expect(r.errors).toEqual([])
    expect(r.skipped.filter((s) => /SLOT_TAKEN/.test(s.reason)).map((s) => s.client)).toEqual(['ZZ Imp Gabi'])
    expect(progress.at(-1)).toBe(10)
    const any = [...f.booked.values()][0]!
    expect(any).toMatchObject({ p_source: 'staff', p_force: true, p_addon_ids: [] })
    expect(any.p_idempotency_key).toBe(await idempotencyKey(any.p_client_id, any.p_professional_id, any.p_starts_at))
    expect(any.p_idempotency_key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('importing the same file again creates 0', async () => {
    const f = fakes()
    const plan = planAppointments(fixture(), ctx(), { now: NOW })
    await runAppointmentImport(plan, f.deps())
    const again = await runAppointmentImport(plan, f.deps(new Set(f.booked.keys())))
    expect(again.created).toBe(0)
    expect(again.alreadyThere).toBe(9)
  })

  it('the error CSV lists skipped rows and errors', async () => {
    const f = fakes()
    const plan = planAppointments(fixture(), ctx(), { now: NOW })
    const r = await runAppointmentImport(plan, f.deps())
    const csv = problemsToCsv(r)
    expect(csv.split('\r\n')[0]).toBe('linha,cliente,tipo,motivo')
    expect(csv).toMatch(/SLOT_TAKEN/)
  })
})
