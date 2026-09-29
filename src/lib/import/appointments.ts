// Appointment import (future agenda from the old system): parse, plan (preview), run. Pure logic: the UI and the flow test pass in the RPCs.
// Never creates a service or a professional. Prices and durations always come from the catalog.
import Papa from 'papaparse'
import { isValidYMD, toSaoPauloISO } from '../datetime'
import { decodeCsv, nameKey, nameSimilarity, normalizeHeader, normalizePhone, parseCreditCents, parseCsv } from './clients'

export type Field = 'client' | 'phone' | 'start' | 'end' | 'date' | 'time' | 'service' | 'professional' | 'status' | 'price' | 'notes'
export type Action = 'placement' | 'maintenance' | 'removal'

export interface Sheet {
  headers: string[]
  rows: string[][]
}

// ---------------------------------------------------------------- file
/** CSV (BOM, delimiter, windows-1252 fallback) or XLS/XLSX (first sheet). */
export async function parseAppointmentFile(name: string, buf: ArrayBuffer): Promise<Sheet> {
  if (/\.xlsx?$/i.test(name)) return parseSpreadsheet(buf)
  const { headers, rows } = parseCsv(decodeCsv(buf))
  return { headers, rows }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Excel dates arrive as JS Dates whose local components are what the sheet shows. Time-only cells sit in 1899/1900. */
function excelCell(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const d = new Date(Math.round(v.getTime() / 60_000) * 60_000)
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    if (d.getFullYear() < 1901) return hm
    const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    return hm === '00:00' ? ymd : `${ymd} ${hm}`
  }
  return v == null ? '' : String(v).trim()
}

export async function parseSpreadsheet(buf: ArrayBuffer): Promise<Sheet> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true })
  const first = wb.SheetNames[0]
  if (!first) return { headers: [], rows: [] }
  const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[first]!, { header: 1, raw: true, defval: '' })
  const data = raw.map((r) => r.map(excelCell)).filter((r) => r.some((c) => c !== ''))
  const [headers = [], ...rows] = data
  return { headers, rows }
}

// ---------------------------------------------------------------- headers
const ALIASES: Record<Field, string[]> = {
  client: ['cliente', 'nome', 'nome_cliente', 'nome_da_cliente'],
  phone: ['telefone', 'celular', 'whatsapp', 'fone'],
  start: ['inicio', 'data_hora', 'horario', 'data_e_hora', 'inicio_do_atendimento'],
  end: ['fim', 'termino'],
  date: ['data', 'dia'],
  time: ['hora', 'hora_inicio'],
  service: ['servico', 'procedimento'],
  professional: ['profissional', 'colaborador', 'atendente', 'colaboradora'],
  status: ['status', 'situacao'],
  price: ['valor', 'preco'],
  notes: ['observacao', 'observacoes', 'obs'],
}

export interface HeaderMap {
  index: Partial<Record<Field, number>>
  /** Required columns that were not found. `start` is satisfied by `start` or by `date`. */
  missing: string[]
}

export function matchHeaders(headers: string[]): HeaderMap {
  const index: Partial<Record<Field, number>> = {}
  headers.forEach((h, i) => {
    const n = normalizeHeader(h)
    for (const f of Object.keys(ALIASES) as Field[]) {
      if (index[f] === undefined && ALIASES[f].includes(n)) {
        index[f] = i
        break
      }
    }
  })
  const missing: string[] = []
  if (index.client === undefined) missing.push('cliente')
  if (index.start === undefined && index.date === undefined) missing.push('inicio')
  if (index.service === undefined) missing.push('servico')
  if (index.professional === undefined) missing.push('profissional')
  return { index, missing }
}

// ---------------------------------------------------------------- field parsers
/** 'dd/MM/yyyy' | 'dd/MM/yy' | 'yyyy-MM-dd' → 'yyyy-MM-dd'; null when invalid. */
export function parseYMD(input: string): string | null {
  const s = input.trim()
  let ymd: string | null = null
  const br = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s)
  if (br) ymd = `${br[3]!.length === 2 ? `20${br[3]}` : br[3]}-${pad(Number(br[2]))}-${pad(Number(br[1]))}`
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) ymd = s
  return ymd && isValidYMD(ymd) ? ymd : null
}

/** '9:30' | '09:30:00' | '9h30' | '14h' | '9:30 PM' → 'HH:MM'; null when invalid. */
export function parseHHMM(input: string): string | null {
  const m = /^(\d{1,2})(?:[:h](\d{2})|h)?(?::\d{2})?\s*(am|pm)?$/i.exec(input.trim())
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? '0')
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return h > 23 || min > 59 ? null : `${pad(h)}:${pad(min)}`
}

/** Start (and end) as São Paulo ISO strings. Accepts one datetime cell, or a date cell plus a time cell. */
export function parseWhen(startCell: string, dateCell: string, timeCell: string): string | null {
  const one = startCell.trim()
  let dateStr = dateCell.trim()
  let timeStr = timeCell.trim()
  if (one && dateStr && !timeStr && parseHHMM(one)) timeStr = one // 'Data' + 'Horario' (time only)
  else if (one) {
    const m = /^(.+?)(?:[ T]+(\d{1,2}(?:[:h]\d{2})?(?::\d{2})?(?:\s*[ap]m)?))?$/i.exec(one)
    if (!m) return null
    if (!dateStr) dateStr = m[1]!
    if (!timeStr && m[2]) timeStr = m[2]
  }
  const ymd = parseYMD(dateStr)
  const hhmm = parseHHMM(timeStr)
  return ymd && hhmm ? toSaoPauloISO(ymd, hhmm) : null
}

export function normText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const CANCELLED = /^(cancel|desmarc|excluid)/

// ---------------------------------------------------------------- catalog
export interface CatalogService {
  id: string
  name: string
  kind: string
  duration_min: number
  price_cents: number
  maintenance_duration_min: number | null
  maintenance_price_cents: number | null
  active: boolean
}
export interface CatalogProfessional {
  id: string
  name: string
  active: boolean
}
export interface ExistingClient {
  id: string
  name: string
  phone_e164: string | null
  external_code: string | null
}
export interface ImportContext {
  services: CatalogService[]
  professionals: CatalogProfessional[]
  /** `${professional_id}|${service_id}` for every professional_services link. */
  links: ReadonlySet<string>
  clients: ExistingClient[]
}

/** Prefix → action, catalog candidates from most to least specific. */
export function serviceCandidates(raw: string): { prefix: Action | null; names: string[] } {
  const full = normText(raw)
  const m = /^(manutencao|remocao)\b[\s:–-]*(.*)$/.exec(full)
  if (!m) return { prefix: null, names: [full] }
  const rest = m[2]!.replace(/^(de|do|da)\s+/, '').trim()
  return { prefix: m[1] === 'manutencao' ? 'maintenance' : 'removal', names: [...(rest ? [rest] : []), full] }
}

function matchProfessional(pros: CatalogProfessional[], raw: string): CatalogProfessional | null {
  const n = normText(raw)
  if (!n) return null
  const exact = pros.filter((p) => normText(p.name) === n)
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) return null
  const words = pros.filter((p) => normText(p.name).startsWith(`${n} `))
  return words.length === 1 ? words[0]! : null
}

// ---------------------------------------------------------------- plan
export interface PlannedAppointment {
  /** Line in the file (the header is line 1). */
  line: number
  status: 'book' | 'skip'
  reason?: string
  clientName: string
  phone: string | null
  externalCode: null
  /** Set when the client already exists. Otherwise `clientRef` groups rows of the same new client. */
  clientId: string | null
  clientRef: string | null
  isNewClient: boolean
  professionalId: string
  serviceId: string
  action: Action
  startsAt: string
  durationMin: number
  priceCents: number
  notes: string | null
  warnings: string[]
}

export interface SkippedRow {
  line: number
  client: string
  reason: string
}

export interface AppointmentPlan {
  rows: PlannedAppointment[]
  skipped: SkippedRow[]
  totals: { rows: number; create: number; matchedClients: number; newClients: number; skipped: number; warnings: number }
  missing: string[]
}

export interface PlanOptions {
  now?: number
  includePast?: boolean
}

function matchClient(pool: Array<ExistingClient & { ref?: string }>, name: string, phone: string | null) {
  // Never on phone alone: the name must be similar (mirrors rpc_upsert_client). No phone → exact name among phoneless clients.
  if (!phone) return pool.find((c) => c.phone_e164 === null && nameKey(c.name) === nameKey(name))
  return pool.find((c) => c.phone_e164 === phone && nameSimilarity(c.name, name) >= 0.82)
}

export function planAppointments(sheet: Sheet, ctx: ImportContext, opts: PlanOptions = {}): AppointmentPlan {
  const now = opts.now ?? Date.now()
  const map = matchHeaders(sheet.headers)
  const empty = { rows: 0, create: 0, matchedClients: 0, newClients: 0, skipped: 0, warnings: 0 }
  if (map.missing.length > 0) return { rows: [], skipped: [], totals: empty, missing: map.missing }

  const cell = (r: string[], f: Field) => (map.index[f] === undefined ? '' : (r[map.index[f]!] ?? '').trim())
  const pool: Array<ExistingClient & { ref?: string }> = [...ctx.clients]
  const catalog = new Map<string, CatalogService>()
  for (const s of ctx.services) catalog.set(normText(s.name), s)

  const rows: PlannedAppointment[] = []
  const skipped: SkippedRow[] = []

  sheet.rows.forEach((r, i) => {
    const line = i + 2
    const clientName = cell(r, 'client').replace(/\s+/g, ' ')
    const skip = (reason: string) => skipped.push({ line, client: clientName, reason })

    const status = normText(cell(r, 'status'))
    const startsAt = parseWhen(cell(r, 'start'), cell(r, 'date'), cell(r, 'time'))
    const rawService = cell(r, 'service')
    const rawPro = cell(r, 'professional')

    if (!clientName) return skip('Cliente em branco')
    if (!startsAt) return skip(`Data/hora inválida (${[cell(r, 'start'), cell(r, 'date'), cell(r, 'time')].filter(Boolean).join(' ') || 'vazia'})`)
    if (!rawService) return skip('Serviço em branco')
    if (!rawPro) return skip('Profissional em branco')
    if (CANCELLED.test(status)) return skip('Status cancelado')
    if (!opts.includePast && Date.parse(startsAt) < now) return skip('Horário no passado')

    const { prefix, names } = serviceCandidates(rawService)
    const svc = names.map((n) => catalog.get(n)).find(Boolean)
    if (!svc) return skip(`Serviço não encontrado no catálogo (${rawService})`)
    if (!svc.active) return skip(`Serviço inativo (${svc.name})`)
    let action: Action
    if (svc.kind === 'removal') {
      if (prefix === 'maintenance') return skip(`"${svc.name}" é uma remoção, não tem manutenção`)
      action = 'removal'
    } else if (prefix === 'removal') {
      return skip(`"${svc.name}" não é um serviço de remoção`)
    } else {
      action = prefix ?? 'placement'
      if (action === 'maintenance' && svc.maintenance_price_cents === null) return skip(`"${svc.name}" não tem manutenção`)
    }

    const pro = matchProfessional(ctx.professionals, rawPro)
    if (!pro) return skip(`Profissional não encontrada (${rawPro})`)
    if (!pro.active) return skip(`Profissional inativa (${pro.name})`)
    if (!ctx.links.has(`${pro.id}|${svc.id}`)) return skip(`${pro.name} não faz "${svc.name}"`)

    const warnings: string[] = []
    const durationMin = action === 'maintenance' ? (svc.maintenance_duration_min ?? svc.duration_min) : svc.duration_min
    const priceCents = action === 'maintenance' ? svc.maintenance_price_cents! : svc.price_cents

    const rawPrice = cell(r, 'price')
    if (rawPrice) {
      const cents = parseCreditCents(rawPrice)
      if (cents === null) warnings.push(`Valor inválido no arquivo (${rawPrice}): ignorado`)
      else if (cents !== priceCents) warnings.push(`Valor do arquivo (${rawPrice}) difere do catálogo; vale o catálogo`)
    }
    const rawEnd = cell(r, 'end')
    if (rawEnd) {
      const endHHMM = parseHHMM(rawEnd)
      const endIso = endHHMM ? toSaoPauloISO(startsAt.slice(0, 10), endHHMM) : parseWhen(rawEnd, '', '')
      if (endIso) {
        const mins = Math.round((Date.parse(endIso) - Date.parse(startsAt)) / 60_000)
        if (mins !== durationMin) warnings.push(`Duração do arquivo (${mins} min) difere do catálogo (${durationMin} min); vale o catálogo`)
      }
    }

    let phone: string | null = null
    const rawPhone = cell(r, 'phone')
    if (rawPhone) {
      phone = normalizePhone(rawPhone)
      if (!phone) warnings.push(`Telefone inválido (${rawPhone}): cliente tratada sem telefone`)
    }

    const found = matchClient(pool, clientName, phone)
    let clientId: string | null = null
    let clientRef: string | null = null
    let isNewClient = false
    if (found) {
      clientId = found.ref ? null : found.id
      clientRef = found.ref ?? null
    } else {
      isNewClient = true
      clientRef = `L${line}`
      pool.push({ id: '', name: clientName, phone_e164: phone, external_code: null, ref: clientRef })
    }

    rows.push({
      line,
      status: 'book',
      clientName,
      phone,
      externalCode: null,
      clientId,
      clientRef,
      isNewClient,
      professionalId: pro.id,
      serviceId: svc.id,
      action,
      startsAt,
      durationMin,
      priceCents,
      notes: cell(r, 'notes') || null,
      warnings,
    })
  })

  const newRefs = new Set(rows.filter((r) => r.isNewClient).map((r) => r.clientRef))
  return {
    rows,
    skipped,
    totals: {
      rows: sheet.rows.length,
      create: rows.length,
      matchedClients: rows.filter((r) => !r.isNewClient).length,
      newClients: newRefs.size,
      skipped: skipped.length,
      warnings: rows.filter((r) => r.warnings.length > 0).length,
    },
    missing: [],
  }
}

// ---------------------------------------------------------------- run
export interface UpsertClientArgs {
  p_name: string
  p_phone: string | null
  p_external_code: string | null
  p_birthday: string | null
  p_notes: string | null
}
export interface BookArgs {
  p_client_id: string
  p_professional_id: string
  p_service_id: string
  p_action: Action
  p_addon_ids: string[]
  p_starts_at: string
  p_source: 'staff'
  p_idempotency_key: string
  p_notes: string | null
  p_force: true
}

export interface AppointmentRunResult {
  created: number
  /** Already in the system (same client, professional and start): idempotent no-op. */
  alreadyThere: number
  skipped: SkippedRow[]
  errors: SkippedRow[]
}

export const CHUNK_SIZE = 25

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const idempotencyKey = (clientId: string, professionalId: string, startsAt: string) =>
  sha256Hex(`${clientId}|${professionalId}|${startsAt}`)

const codeOf = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '')
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface RunDeps {
  upsertClient: (a: UpsertClientArgs) => Promise<string>
  book: (a: BookArgs) => Promise<string>
  /** Idempotency keys already in the database. */
  existingKeys: ReadonlySet<string>
}

/** Sequential, in chunks. The client is created lazily (only rows that reach booking), once per new client. */
export async function runAppointmentImport(
  plan: AppointmentPlan,
  deps: RunDeps,
  onProgress?: (done: number, total: number) => void,
  chunkSize = CHUNK_SIZE,
): Promise<AppointmentRunResult> {
  const result: AppointmentRunResult = { created: 0, alreadyThere: 0, skipped: [...plan.skipped], errors: [] }
  const seenKeys = new Set(deps.existingKeys)
  const refIds = new Map<string, string>()
  const total = plan.rows.length
  let done = 0
  onProgress?.(0, total)
  for (let i = 0; i < total; i += chunkSize) {
    for (const r of plan.rows.slice(i, i + chunkSize)) {
      const fail = (list: SkippedRow[], reason: string) => list.push({ line: r.line, client: r.clientName, reason })
      try {
        let clientId = r.clientId ?? (r.clientRef ? refIds.get(r.clientRef) : undefined)
        if (!clientId) {
          clientId = await deps.upsertClient({ p_name: r.clientName, p_phone: r.phone, p_external_code: null, p_birthday: null, p_notes: null })
          if (r.clientRef) refIds.set(r.clientRef, clientId)
        }
        const key = await idempotencyKey(clientId, r.professionalId, r.startsAt)
        if (seenKeys.has(key)) {
          result.alreadyThere++
        } else {
          await deps.book({
            p_client_id: clientId,
            p_professional_id: r.professionalId,
            p_service_id: r.serviceId,
            p_action: r.action,
            p_addon_ids: [],
            p_starts_at: r.startsAt,
            p_source: 'staff',
            p_idempotency_key: key,
            p_notes: r.notes,
            p_force: true,
          })
          seenKeys.add(key)
          result.created++
        }
      } catch (e) {
        if (codeOf(e) === 'SLOT_TAKEN') fail(result.skipped, 'Horário ocupado (SLOT_TAKEN)')
        else fail(result.errors, messageOf(e))
      }
      done++
    }
    onProgress?.(done, total)
    await new Promise((res) => setTimeout(res, 0)) // let the progress bar paint between chunks
  }
  return result
}

/** Skipped rows and errors in one CSV (linha, cliente, tipo, motivo). */
export function problemsToCsv(result: Pick<AppointmentRunResult, 'skipped' | 'errors'>): string {
  const data = [
    ...result.skipped.map((s) => [s.line, s.client, 'ignorada', s.reason]),
    ...result.errors.map((s) => [s.line, s.client, 'erro', s.reason]),
  ].sort((a, b) => Number(a[0]) - Number(b[0]))
  return Papa.unparse({ fields: ['linha', 'cliente', 'tipo', 'motivo'], data })
}
